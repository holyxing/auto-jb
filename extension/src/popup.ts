import { discoveryProfile, validateProfile } from "./profiles";
import { liveConnections, preferredConnection } from "./popupConnections";
import type { BossChatProbe, ChatDelta } from "./bossChat";
import { isConfiguredBossJobsUrl } from "./bossJobsUrl";
import { isConfiguredLiepinJobsUrl } from "./liepinJobsUrl";
import { BUILT_IN_JOB_TITLES, DEFAULT_SEARCH_SETTINGS,
  parseContactInterval, parseSearchSettings, searchSettingsWithTitle,
  titleFromSearchSettings, type SearchSettings } from "./searchSettings";
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
type Connection = {
  id: string;
  source: string;
  account: string;
  profile: string;
  seen_at: number;
  blocked: string;
  selected_key: string;
  detail: { title: string } | null;
  tab: number;
  send_ready: boolean;
  contact_click_ready: boolean;
  search_limited: boolean;
};
type Run = {
  id: string;
  connection_id: string;
  scope: string;
  profile: string;
  status: string;
  reason: string;
  visited: number;
  budget: number;
  lease_until: number;
  cooldown_until: number;
  contact_interval_seconds: number;
  deadline: number;
  mode: string;
};
type State = {
  connections: Connection[];
  runs: Run[];
  counts: { run_id: string; action: string; count: number }[];
  capabilities: {
    scope: string;
    profile: string;
    action: string;
    status: string;
  }[];
  commands: {
    id: string; run_id: string; scope: string; job_key: string;
    action: string; status: string; result?: { note?: string };
  }[];
  jobs: {
    scope: string; key: string; data: { title: string; company: string };
    decision: string; contact: string; resume: string;
  }[];
};
let current: State | null = null;
let active: Run | undefined;
let latest: Run | undefined;
let busy = false;
let manualConnection = false;
let chatTab = false;
let chatTabId: number | undefined;
let activeTabUrl = "";
let pageUnreachable = false;
let attachError = "";
let waking = false;
let refreshing = false;
let searchSettings: SearchSettings = DEFAULT_SEARCH_SETTINGS;
let chatProbe: (BossChatProbe & {
  delta?: ChatDelta | null;
  baseline_at?: number | null;
}) | null = null;
const names: Record<string, string> = {
  RUNNING: "执行中",
  PAUSED_USER: "已暂停",
  WAITING_HUMAN: "需接管",
  COMPLETED: "本轮结束",
  STOPPED: "已停止",
  CONTACT: "沟通",
  RESUME_SEND: "发送简历",
  SELECT: "选择岗位",
  SCROLL: "加载列表",
  RESTORE: "返回列表",
  SUCCEEDED: "动作完成",
  CLICKED: "已点击·待人工确认",
  UNKNOWN: "结果未知",
  ISSUED: "待执行",
  CLAIMED: "执行中",
  CANCELLED: "已撤销",
  BUDGET_REACHED: "达到本轮预算",
  VERIFICATION_FINISHED: "当前岗位验证结束",
  END_OF_VISIBLE_RESULTS: "当前列表已读完",
  LIST_NO_PROGRESS: "列表未出现新岗位",
};
function settingsChangeBlocked() {
  return current?.runs.some((run) =>
    run.status === "RUNNING" ||
    (["PAUSED_USER", "WAITING_HUMAN"].includes(run.status) &&
      run.lease_until > Date.now() / 1000)) ?? false;
}
async function rpc(message: unknown) {
  const r = await chrome.runtime.sendMessage(message);
  if (!r?.ok) throw new Error(r?.error ?? "扩展连接失败");
  return r.value;
}
function isControlledPage(url: string) {
  try {
    const parsed = new URL(url);
    return (parsed.origin === "https://www.zhipin.com" && parsed.pathname === "/web/geek/jobs") ||
      (parsed.origin === "https://www.liepin.com" && parsed.pathname === "/zhaopin/") ||
      (parsed.origin === "http://127.0.0.1:17830" && parsed.pathname.startsWith("/fixture"));
  } catch {
    return false;
  }
}
function tabMessage(tabId: number, message: unknown, ms: number) {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
function attachFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "无法把扩展挂到当前招聘页";
  if (message.includes("Access to storage is not allowed"))
    return "扩展还在连接当前招聘页，请再打开一次弹窗";
  if (message.includes("Cannot access contents"))
    return "扩展没有权限挂到这个招聘页，请在扩展管理里重新加载";
  if (message.includes("Receiving end") || message.includes("message port closed"))
    return "招聘页没有回应扩展";
  return message;
}
async function wakeTab(tabId: number) {
  const expected = (await rpc({ type: "boot" }) as { boot?: string }).boot ?? "";
  const ping = async () => {
    const response = await tabMessage(tabId, { type: "wake2" }, 2500) as {
      ok?: boolean;
      boot?: string;
      error?: string;
    } | undefined;
    if (response?.ok && response.boot === expected) return "";
    return response?.error || "招聘页没有完成连接";
  };
  try {
    if (!(await ping())) return;
  } catch {
    // 扩展重载后，残留的旧脚本不回应 wake2。
  }
  try {
    await rpc({ type: "attach", tabId });
  } catch (error) {
    throw new Error(attachFailure(error));
  }
  let last = "招聘页没有完成连接";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      last = await ping();
      if (!last) return;
    } catch (error) {
      last = attachFailure(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(last);
}
function connection() {
  return current?.connections.find(
    (c) => c.id === $<HTMLSelectElement>("connection").value,
  );
}
function renderUnknown(scope: string) {
  const unknown = current?.commands.filter((c) =>
    c.scope === scope && c.status === "UNKNOWN" &&
    ["CONTACT", "RESUME_SEND"].includes(c.action)) ?? [];
  $("unknown-records").hidden = !unknown.length;
  const select = $<HTMLSelectElement>("unknown-command");
  const ids = unknown.map((c) => c.id);
  if (JSON.stringify([...select.options].map((option) => option.value)) !== JSON.stringify(ids)) {
    const selected = select.value;
    select.replaceChildren(...unknown.map((c) => {
      const option = document.createElement("option");
      const job = current?.jobs.find((j) => j.scope === c.scope && j.key === c.job_key);
      option.value = c.id;
      option.textContent = `${job?.data.title ?? c.job_key} · ${names[c.action] ?? c.action}`;
      return option;
    }));
    if (ids.includes(selected)) select.value = selected;
    $<HTMLSelectElement>("unknown-outcome").value = "";
  }
  const chosen = unknown.find((c) => c.id === select.value);
  const success = $<HTMLOptionElement>("unknown-success");
  const expected = chosen?.action === "RESUME_SEND" ? "SENT" : "CONTACT_INITIATED";
  success.value = expected;
  success.textContent = chosen?.action === "RESUME_SEND" ? "确认已发送简历" : "确认已联系";
  const outcome = $<HTMLSelectElement>("unknown-outcome");
  if (outcome.value && !["NO_EFFECT", expected].includes(outcome.value)) outcome.value = "";
  $<HTMLButtonElement>("unknown-save").disabled = busy || !chosen || !outcome.value ||
    $<HTMLInputElement>("unknown-note").value.trim().length < 5;
}
function render() {
  const conn = connection();
  const scope = conn ? `${conn.source}:${conn.account}` : "";
  const runs = current?.runs.filter((r) => r.scope === scope) ?? [];
  active = runs.find((r) =>
    ["RUNNING", "PAUSED_USER", "WAITING_HUMAN"].includes(r.status),
  );
  latest = active ?? runs.find((r) => r.connection_id === conn?.id);
  const online = !!conn && Date.now() / 1000 - conn.seen_at < 15;
  const profileReady = conn?.source !== "liepin" ||
    conn.profile.includes(":liepin-click-v2:");
  const verified = current?.capabilities.some(
    (c) =>
      c.scope === scope &&
      c.profile === conn?.profile &&
      c.action === "CONTACT" &&
      c.status === "VERIFIED",
  );
  const siteClick = !!profileReady &&
    ["boss", "liepin"].includes(conn?.source ?? "") && !!conn?.contact_click_ready;
  const canContact = siteClick || conn?.send_ready;
  const lastCommand = current?.commands.find((c) => c.run_id === latest?.id);
  const unknownInRun = current?.commands.some(
    (c) => c.run_id === active?.id && c.status === "UNKNOWN",
  ) ?? false;
  const unknownBlocksResume = unknownInRun && !siteClick;
  const expired = !!active && active.deadline <= Date.now() / 1000;
  const resumableAuto = active?.mode === "auto" &&
    ["PAUSED_USER", "WAITING_HUMAN"].includes(active.status) &&
    !unknownBlocksResume;
  const restartAuto = !!resumableAuto &&
    (expired || active?.profile !== conn?.profile);
  const problem = lastCommand?.status === "FAILED" && lastCommand.result?.note
    ? lastCommand.result.note
    : latest?.reason ?? "";
  $("page").textContent =
    conn?.detail?.title ?? (chatTab ? "BOSS 消息页" : "打开招聘职位列表后显示当前岗位");
  $("state").textContent = latest
    ? (names[latest.status] ?? latest.status)
    : "尚未启动";
  $("source").textContent =
    conn?.source === "fixture"
      ? "本地样本，不联系招聘方"
      : chatTab && !conn
        ? "会话只读观察"
        : `北京 · AI 与产品相关 · 薪资、职级不限${conn?.source === "liepin" ? " · 猎聘" : ""}`;
  $("blocked").textContent =
    (chatTab && !conn ? "消息页尚不能关联具体岗位，请返回职位列表" : "") ||
    (!profileReady ? "猎聘扩展仍是旧版：请在 Chrome 扩展管理中重新加载，然后刷新招聘页" : "") ||
    conn?.blocked ||
    (pageUnreachable && !conn ? (attachError || "扩展没有连上当前招聘页") : "") ||
    (!online ? "当前没有在线的岗位列表，可打开设定的北京搜索页" :
      active?.status === "WAITING_HUMAN" || active?.status === "PAUSED_USER"
        ? unknownBlocksResume
          ? "本轮有结果未知的动作，请先在招聘平台核对，并在下方登记；禁止重复点击。"
          : unknownInRun
            ? "已沟通或结果未知的岗位会跳过，不会重复点击。点击“继续本轮自动点击”处理其余岗位。"
          : restartAuto
            ? `本轮已暂停：${problem}。扩展已更新或本轮到期，点击“续接本轮自动点击”保留已处理岗位。`
            : `本轮已暂停：${problem}。点击“继续本轮自动点击”或上方“恢复”。`
        : ["boss", "liepin"].includes(conn?.source ?? "") && !siteClick ? "当前页尚未具备点击条件，请核对账号、搜索入口与岗位列表" : !canContact ? "当前仅可只读扫描" : !siteClick && !verified ? "当前页面的沟通能力尚未验证" : "");
  $("capability").textContent =
    siteClick
      ? `${conn?.source === "liepin" ? "猎聘“聊一聊”" : "BOSS“立即沟通”"}以单次点击为完成；会话与简历由人工确认。未启动时上方控制按钮为灰色。`
      : "";
  $("chat-probe").textContent = !chatTab
    ? ""
    : !chatProbe
      ? "正在只读检查当前会话…"
      : !chatProbe.selected
        ? "请选择一个会话后查看简历入口；不会自动发送。"
      : `已选会话：${chatProbe.resume === "WAITING_PEER" ? "发简历需双方回复" : chatProbe.resume === "READY" ? "发简历入口可用，尚未绑定岗位与简历" : "发简历入口不可用"}；已观察到 ${chatProbe.outgoing.filter((item) => item.delivered).length} 条送达消息。${!chatProbe.conversation ? "无法匹配唯一会话名片，不能建立基线。" : !chatProbe.panel_bound ? "消息区无法绑定到选中会话，不能建立基线。" : !chatProbe.complete ? "消息过多或有重复 ID，基线不完整。" : chatProbe.delta?.state === "NEW_DELIVERED" ? `基线后出现 ${chatProbe.delta.newIds.length} 条新送达消息候选；尚未绑定岗位与发送动作。` : chatProbe.delta?.reason ?? ""}${chatProbe.identity_source === "display-triple" ? " 当前仅以招聘人、公司、职位三项匹配会话，尚无平台会话 ID。" : ""}`;
  $("chat-baseline").hidden = !chatTab;
  $<HTMLButtonElement>("chat-baseline").disabled = busy ||
    !chatProbe?.selected || !chatProbe.conversation || !chatProbe.panel_bound || !chatProbe.complete ||
    chatProbe.account === "unverified";
  $("connection").closest("label")!.hidden = chatTab;
  $("resume-option").hidden = !conn?.send_ready;
  $("resume-field").hidden =
    !conn?.send_ready || !$<HTMLInputElement>("send-resume").checked;
  $("scan").classList.toggle("primary", siteClick);
  $("auto").classList.toggle("primary", !!canContact);
  $("auto").textContent = restartAuto ? "续接本轮自动点击" : resumableAuto ? "继续本轮自动点击" : conn?.source === "boss" ? "开始自动点击立即沟通" : conn?.source === "liepin" ? "开始自动点击聊一聊" : "开始自动沟通与投递";
  $("verify").textContent = siteClick ? "点击当前岗位一次" : "验证当前岗位";
  $("usage").textContent = siteClick
    ? `使用顺序：登录${conn?.source === "liepin" ? "猎聘" : " BOSS"} → 打开北京搜索页 → 核对岗位 → 启动本轮；点击后由你核对会话。`
    : "验证会联系当前岗位招聘方，并可能发送站内默认招呼。";
  // 以输入框里的草稿 URL 为准；职位标题一改，打开按钮即可再点。
  const draft = draftSearchSettings();
  const onBossSearch = !!activeTabUrl &&
    isConfiguredBossJobsUrl(activeTabUrl, draft.bossUrl);
  $("broad").textContent = onBossSearch
    ? "已打开配置的 BOSS 北京搜索页"
    : "打开配置的 BOSS 北京搜索页";
  $<HTMLButtonElement>("broad").disabled = busy || !!active || onBossSearch;
  const onLiepinSearch = !!activeTabUrl &&
    isConfiguredLiepinJobsUrl(activeTabUrl, draft.liepinUrl);
  $("open-liepin").textContent = onLiepinSearch
    ? "已打开配置的猎聘北京搜索页"
    : "打开配置的猎聘北京搜索页";
  $<HTMLButtonElement>("open-liepin").disabled = busy || !!active || onLiepinSearch;
  $<HTMLButtonElement>("save-search-settings").disabled = busy || settingsChangeBlocked();
  // 搜索页与配置不一致时展开入口，避免找不到打开按钮。
  if (conn?.search_limited || /北京搜索入口|已配置的猎聘北京搜索页/.test(conn?.blocked ?? ""))
    $<HTMLDetailsElement>("automation-settings").open = true;
  $("reason").textContent = latest
    ? (names[latest.reason] ?? latest.reason) +
      (latest.lease_until > Date.now() / 1000 && latest.status !== "RUNNING"
        ? " · 停止请求中"
        : "")
    : "";
  const cooldownSeconds = latest?.status === "RUNNING"
    ? Math.max(0, Math.ceil(latest.cooldown_until - Date.now() / 1000))
    : 0;
  const delivered = current?.jobs.filter((job) =>
    job.scope === scope && (
      job.contact === "CLICKED" || job.contact === "CONTACT_INITIATED"
      || job.resume === "SENT" || job.resume === "ALREADY_SENT"
    ),
  ).length ?? 0;
  $("delivered").hidden = !scope;
  $("delivered").textContent = `已投递 ${delivered}`;
  $("progress").textContent = latest
    ? `本轮预算计数 ${latest.visited} / ${latest.budget} · 点击间隔 ${latest.contact_interval_seconds ?? 5} 秒${cooldownSeconds > 0 ? ` · 还需等待 ${cooldownSeconds} 秒` : ""}`
    : "沿当前 AI产品经理搜索结果的左侧列表读取，逐岗判断 AI 与产品相关性";
  const count = (action: string) =>
    current?.counts.find((c) => c.run_id === latest?.id && c.action === action)
      ?.count ?? 0;
  $("counts").textContent = conn?.source === "liepin" &&
    latest?.profile.includes(":liepin-click-v1:")
    ? `旧版记录 ${count("CONTACT")} 条仅调用 DOM 点击，未核实实际沟通；这些岗位保持去重，需人工核对`
    : siteClick
    ? `本轮已点击 ${count("CONTACT")} · 待人工确认会话`
    : `本轮沟通 ${count("CONTACT")} · 简历发送 ${count("RESUME_SEND")}`;
  const jobs = current?.jobs.filter((j) => j.scope === scope) ?? [];
  $("pending").textContent =
    `待复核 ${jobs.filter((j) => j.decision === "NEEDS_REVIEW").length} · 等待对方 ${jobs.filter((j) => j.resume === "WAITING_PEER").length} · 结果未知 ${jobs.filter((j) => j.contact === "UNKNOWN" || j.resume === "UNKNOWN").length}`;
  $("action").textContent = lastCommand
    ? `最近动作：${names[lastCommand.action] ?? lastCommand.action} · ${names[lastCommand.status] ?? lastCommand.status}${lastCommand.result?.note ? ` · ${lastCommand.result.note}` : ""}`
    : "";
  renderUnknown(scope);
  for (const mode of ["scan", "verify", "auto"])
    $<HTMLButtonElement>(mode).disabled =
      busy ||
      !online ||
      !!active ||
      !!conn?.blocked ||
      (mode !== "scan" && !canContact) ||
      (mode === "auto" && !siteClick && !verified) ||
      (mode === "verify" && !conn?.selected_key);
  $<HTMLButtonElement>("auto").disabled =
    busy || !online || !!conn?.blocked || !canContact ||
    (resumableAuto ? false : !!active || (!siteClick && !verified));
  $<HTMLButtonElement>("pause").disabled =
    busy || !active || active.status !== "RUNNING";
  $<HTMLButtonElement>("resume").disabled =
    busy || !active || active.status === "RUNNING" ||
    !online || !!conn?.blocked || expired ||
    active.profile !== conn?.profile || unknownBlocksResume;
  $<HTMLButtonElement>("stop").disabled = busy || !active;
  $<HTMLButtonElement>("continue").disabled =
    busy || !!active || !latest || !online || !!conn?.blocked;
}
async function refresh() {
  refreshing = true;
  try {
  const stored = await chrome.storage.local.get([
    "deviceToken",
    "lastDiagnostic",
  ]);
  $("status").textContent = stored.deviceToken
    ? "已配对 · 本机执行"
    : "尚未配对";
  $("diagnostic").textContent = JSON.stringify(
    stored.lastDiagnostic ?? { message: "等待受控页面" },
    null,
    2,
  );
  if (!stored.deviceToken) {
    current = null;
    chatTab = false;
    chatTabId = undefined;
    chatProbe = null;
    pageUnreachable = false;
    $<HTMLSelectElement>("connection").replaceChildren();
    render();
    return;
  }
  const tabs = await chrome.tabs.query({});
  const activeTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const activeFresh = !!activeTab?.id && current?.connections.some(
    (item) => item.tab === activeTab.id && Date.now() / 1000 - item.seen_at < 15,
  );
  attachError = "";
  if (activeTab?.id && activeTab.url && isControlledPage(activeTab.url) && !activeFresh && !waking) {
    waking = true;
    try {
      await wakeTab(activeTab.id);
    } catch (error) {
      attachError = error instanceof Error ? error.message : "扩展没有连上当前招聘页";
    } finally {
      waking = false;
    }
  }
  // 当前标签不是招聘搜索页，或本轮因切走/重载暂停时，自动拉回配置的搜索页并恢复。
  try {
    await rpc({ type: "recoverSiteRun" });
  } catch {
    // 恢复失败时仍展示原暂停原因，可手工继续。
  }
  const state: State = await rpc({ type: "panel", action: "state" });
  current = state;
  activeTabUrl = activeTab?.url ?? "";
  const activeUrl = activeTab?.url ? new URL(activeTab.url) : null;
  chatTab = activeUrl?.origin === "https://www.zhipin.com" &&
    activeUrl.pathname === "/web/geek/chat";
  chatTabId = chatTab ? activeTab?.id : undefined;
  const probeKey = `bossChatProbe:${activeTab?.id}`;
  const storedProbe = chatTab ? (await chrome.storage.session.get(probeKey))[probeKey] : null;
  chatProbe = storedProbe && Date.now() - storedProbe.seen_at < 5000
    ? storedProbe as BossChatProbe
    : null;
  state.connections = chatTab
    ? []
    : liveConnections(
        state.connections,
        new Set(tabs.map((t) => t.id).filter((id): id is number => id !== undefined)),
        Date.now() / 1000,
      );
  const select = $<HTMLSelectElement>("connection");
  const chosen = select.value;
  const preferred = preferredConnection(
    state.connections,
    activeTab?.id,
    manualConnection ? chosen : undefined,
  );
  pageUnreachable = !!activeTab?.url && isControlledPage(activeTab.url) &&
    !current!.connections.some((item) => item.tab === activeTab.id);
  if (!pageUnreachable) attachError = "";
  select.replaceChildren(
    ...current!.connections.map((c) => {
      const option = document.createElement("option");
      option.value = c.id;
      option.textContent = `${c.tab === activeTab?.id ? "当前页 · " : ""}${c.source === "fixture" ? "本地样本" : c.source === "liepin" ? "猎聘" : "BOSS"} · ${c.account.slice(0, 8)}`;
      return option;
    }),
  );
  if (pageUnreachable) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "当前招聘页尚未连上";
    select.append(option);
  }
  if (preferred) select.value = preferred.id;
  else if (pageUnreachable) select.value = "";
  render();
  } finally {
    refreshing = false;
  }
}
async function act(fn: () => Promise<unknown>) {
  busy = true;
  $("error").textContent = "";
  render();
  try {
    await fn();
    await refresh();
  } catch (e) {
    $("error").textContent = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    render();
  }
}
async function persistOptions() {
  await chrome.storage.local.set({
    taskOptions: {
      limit: $<HTMLInputElement>("limit").value,
      minutes: $<HTMLInputElement>("minutes").value,
      sendResume: $<HTMLInputElement>("send-resume").checked,
      resumeName: $<HTMLInputElement>("resume-name").value,
      contactIntervalSeconds: $<HTMLInputElement>("contact-interval").value,
    },
  });
}
async function start(mode: string, previous?: string) {
  const conn = connection();
  if (!conn) throw new Error("请先选择页面");
  const contactIntervalSeconds = parseContactInterval($<HTMLInputElement>("contact-interval").value);
  await persistOptions();
  return rpc({
    type: "panel",
    action: "start",
    body: {
      connection_id: conn.id,
      expected_scope: `${conn.source}:${conn.account}`,
      expected_profile: conn.profile,
      mode,
      max_jobs: Number($<HTMLInputElement>("limit").value),
      minutes: Number($<HTMLInputElement>("minutes").value),
      contact_interval_seconds: contactIntervalSeconds,
      send_resume: !!conn.send_ready && $<HTMLInputElement>("send-resume").checked,
      resume_name: $<HTMLInputElement>("resume-name").value,
      previous_run: previous ?? null,
    },
  });
}
$("connection").onchange = () => {
  manualConnection = true;
  render();
};
function draftSearchSettings(): SearchSettings {
  try {
    return parseSearchSettings({
      bossUrl: $<HTMLInputElement>("boss-search-url").value || searchSettings.bossUrl,
      liepinUrl: $<HTMLInputElement>("liepin-search-url").value || searchSettings.liepinUrl,
    });
  } catch {
    return searchSettings;
  }
}
async function persistDraftSearchSettings() {
  const next = draftSearchSettings();
  await chrome.storage.local.set({ searchSettings: next });
  searchSettings = next;
  $<HTMLInputElement>("boss-search-url").value = next.bossUrl;
  $<HTMLInputElement>("liepin-search-url").value = next.liepinUrl;
  syncJobTitleControls(titleFromSearchSettings(next));
  return next;
}
$("broad").onclick = () => void act(async () => {
  if (active) throw new Error("已有运行中的任务，请先处理该任务");
  const next = await persistDraftSearchSettings();
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const url = tab?.url ? new URL(tab.url) : null;
  if (url?.origin === "https://www.zhipin.com" && url.pathname === "/web/geek/jobs" && tab.id &&
      !isConfiguredBossJobsUrl(url, next.bossUrl))
    await chrome.tabs.update(tab.id, { url: next.bossUrl });
  else await chrome.tabs.create({ url: next.bossUrl });
});
$("open-liepin").onclick = () => void act(async () => {
  if (active) throw new Error("已有运行中的任务，请先处理该任务");
  const next = await persistDraftSearchSettings();
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const url = tab?.url ? new URL(tab.url) : null;
  if (url?.origin === "https://www.liepin.com" && url.pathname === "/zhaopin/" && tab.id &&
      !isConfiguredLiepinJobsUrl(url, next.liepinUrl))
    await chrome.tabs.update(tab.id, { url: next.liepinUrl });
  else await chrome.tabs.create({ url: next.liepinUrl });
});
function fillJobTitleSelect() {
  const select = $<HTMLSelectElement>("job-title-select");
  select.replaceChildren();
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "手工输入";
  select.append(custom);
  for (const title of BUILT_IN_JOB_TITLES) {
    const option = document.createElement("option");
    option.value = title;
    option.textContent = title;
    select.append(option);
  }
}
function syncJobTitleControls(title = "") {
  const keyword = title.trim();
  $<HTMLInputElement>("job-title").value = keyword;
  $<HTMLSelectElement>("job-title-select").value =
    BUILT_IN_JOB_TITLES.includes(keyword) ? keyword : "";
}
function applyJobTitle(title: string) {
  const keyword = title.trim();
  if (!keyword) return;
  const next = searchSettingsWithTitle(keyword, {
    bossUrl: $<HTMLInputElement>("boss-search-url").value || searchSettings.bossUrl,
    liepinUrl: $<HTMLInputElement>("liepin-search-url").value || searchSettings.liepinUrl,
  });
  $<HTMLInputElement>("boss-search-url").value = next.bossUrl;
  $<HTMLInputElement>("liepin-search-url").value = next.liepinUrl;
}
$("job-title-select").onchange = () => {
  const selected = $<HTMLSelectElement>("job-title-select").value;
  if (!selected) {
    $<HTMLInputElement>("job-title").focus();
    render();
    return;
  }
  $<HTMLInputElement>("job-title").value = selected;
  applyJobTitle(selected);
  render();
};
$("job-title").addEventListener("change", () => {
  const title = $<HTMLInputElement>("job-title").value;
  applyJobTitle(title);
  syncJobTitleControls(title.trim());
  render();
});
$("job-title").addEventListener("input", () => {
  const title = $<HTMLInputElement>("job-title").value;
  applyJobTitle(title);
  const select = $<HTMLSelectElement>("job-title-select");
  select.value = BUILT_IN_JOB_TITLES.includes(title.trim()) ? title.trim() : "";
  render();
});
for (const id of ["boss-search-url", "liepin-search-url"])
  $(id).addEventListener("change", () => {
    try {
      syncJobTitleControls(titleFromSearchSettings(parseSearchSettings({
        bossUrl: $<HTMLInputElement>("boss-search-url").value,
        liepinUrl: $<HTMLInputElement>("liepin-search-url").value,
      })));
    } catch {
      syncJobTitleControls("");
    }
    render();
  });
$("save-search-settings").onclick = () => void act(async () => {
  if (settingsChangeBlocked())
    throw new Error("请先暂停或停止执行中的批次，等待已领取动作结束，再修改搜索入口");
  applyJobTitle($<HTMLInputElement>("job-title").value);
  const next = parseSearchSettings({
    bossUrl: $<HTMLInputElement>("boss-search-url").value,
    liepinUrl: $<HTMLInputElement>("liepin-search-url").value,
  });
  const interval = parseContactInterval($<HTMLInputElement>("contact-interval").value);
  await chrome.storage.local.set({ searchSettings: next });
  searchSettings = next;
  $<HTMLInputElement>("boss-search-url").value = next.bossUrl;
  $<HTMLInputElement>("liepin-search-url").value = next.liepinUrl;
  syncJobTitleControls(titleFromSearchSettings(next));
  await persistOptions();
  $("settings-status").textContent = `已保存；点击间隔 ${interval} 秒。招聘页将重新校准。`;
});
$("chat-baseline").onclick = () => void act(async () => {
  if (!chatTabId) throw new Error("请先打开 BOSS 消息页");
  await rpc({ type: "captureChatBaseline", tabId: chatTabId });
});
for (const mode of ["scan", "verify"])
  $(mode).onclick = () => void act(() => start(mode));
$("auto").onclick = () => void act(async () => {
  if (active?.mode === "auto" && active.status !== "RUNNING") {
    if (active.deadline <= Date.now() / 1000 || active.profile !== connection()?.profile) {
      const previous = active.id;
      await rpc({ type: "panel", action: "control", run_id: previous, body: { action: "stop" } });
      await start("auto", previous);
    } else {
      await rpc({ type: "panel", action: "control", run_id: active.id, body: { action: "resume" } });
    }
  } else {
    await start("auto");
  }
});
for (const action of ["pause", "resume", "stop"])
  $(action).onclick = () =>
    void act(() =>
      rpc({
        type: "panel",
        action: "control",
        run_id: active?.id,
        body: { action },
      }),
    );
$("continue").onclick = () => void act(() => start(latest!.mode, latest!.id));
$("unknown-command").onchange = () => {
  $<HTMLSelectElement>("unknown-outcome").value = "";
  render();
};
$("unknown-outcome").onchange = render;
$("unknown-note").oninput = render;
$("unknown-save").onclick = () => void act(async () => {
  const cmd = current?.commands.find((c) =>
    c.id === $<HTMLSelectElement>("unknown-command").value &&
    c.status === "UNKNOWN" &&
    c.scope === `${connection()?.source}:${connection()?.account}`);
  const outcome = $<HTMLSelectElement>("unknown-outcome").value;
  const note = $<HTMLInputElement>("unknown-note").value.trim();
  const expected = cmd?.action === "RESUME_SEND" ? "SENT" : "CONTACT_INITIATED";
  if (!cmd || !["NO_EFFECT", expected].includes(outcome) || note.length < 5)
    throw new Error("请选择本账号的未决动作，核对招聘平台后填写结论与依据");
  await rpc({ type: "panel", action: "resolve", command_id: cmd.id, body: { outcome, note } });
  $<HTMLInputElement>("unknown-note").value = "";
  $<HTMLSelectElement>("unknown-outcome").value = "";
});
$("pair").onclick = () =>
  void act(async () => {
    await rpc({ type: "pair", code: $<HTMLInputElement>("code").value.trim() });
    $<HTMLInputElement>("code").value = "";
  });
$("save").onclick = () =>
  void act(async () => {
    const p = validateProfile(
      JSON.parse($<HTMLTextAreaElement>("profile").value),
    );
    await chrome.storage.local.set({ bossProfile: p });
    $("error").textContent = "配置已更新，旧发送能力失效；等待页面重新握手";
  });
$("disconnect").onclick = () =>
  void act(async () => {
    if (active)
      await rpc({
        type: "panel",
        action: "control",
        run_id: active.id,
        body: { action: "pause" },
      });
    await chrome.storage.local.remove("deviceToken");
  });
$("send-resume").onchange = () => {
  $("resume-field").hidden = !$<HTMLInputElement>("send-resume").checked;
  void persistOptions();
};
for (const id of ["limit", "minutes", "resume-name"])
  $(id).addEventListener("change", () => void persistOptions());
async function init() {
  const stored = await chrome.storage.local.get(["bossProfile", "taskOptions", "searchSettings"]);
  searchSettings = parseSearchSettings(stored.searchSettings);
  $<HTMLInputElement>("boss-search-url").value = searchSettings.bossUrl;
  $<HTMLInputElement>("liepin-search-url").value = searchSettings.liepinUrl;
  fillJobTitleSelect();
  syncJobTitleControls(titleFromSearchSettings(searchSettings));
  if (stored.taskOptions) {
    const options = stored.taskOptions;
    $<HTMLInputElement>("limit").value = String(options.limit ?? 20);
    $<HTMLInputElement>("minutes").value = String(options.minutes ?? 30);
    $<HTMLInputElement>("send-resume").checked = options.sendResume === true;
    $<HTMLInputElement>("resume-name").value = options.resumeName ?? "";
    $<HTMLInputElement>("contact-interval").value = String(options.contactIntervalSeconds ?? 5);
    $("resume-field").hidden = !$<HTMLInputElement>("send-resume").checked;
  }
  $<HTMLTextAreaElement>("profile").value = JSON.stringify(
    stored.bossProfile ?? discoveryProfile,
    null,
    2,
  );
  await refresh();
}
void init().catch((e) => {
  $("error").textContent = String(e);
});
setInterval(() => {
  if (!busy && !refreshing)
    void refresh().catch((e) => {
      $("error").textContent = String(e);
    });
}, 1500);
