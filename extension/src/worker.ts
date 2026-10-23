import { compareBossChat, type BossChatProbe } from "./bossChat";
import { isConfiguredBossJobsUrl } from "./bossJobsUrl";
import { discoveryProfile } from "./profiles";
import { isConfiguredLiepinJobsUrl } from "./liepinJobsUrl";
import { parseSearchSettings } from "./searchSettings";
import { apiError } from "./httpError";
const API = "http://127.0.0.1:17830";
// 每次 service worker 启动换一个代号。旧页面脚本拿不到它，不能再假装已连上。
const runtimeBoot = crypto.randomUUID();
async function attachOpenJobPages() {
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.liepin.com/zhaopin/*",
      "https://www.zhipin.com/web/geek/jobs*",
      "http://127.0.0.1:17830/fixture*",
    ],
  });
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch {
      // 弹窗打开时会再试，并把失败原因显示出来。
    }
  }));
}
void chrome.storage.session.setAccessLevel({
  accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
}).catch(() => undefined).then(() => attachOpenJobPages());
async function searchSettings() {
  const stored = await chrome.storage.local.get("searchSettings");
  return parseSearchSettings(stored.searchSettings);
}
let recoveringSiteRun = false;
let lastSiteRecoverAt = 0;
function recoverableSiteReason(reason: string) {
  // 用户点“暂停”不自动恢复；招聘页关掉或切走时自动拉回搜索页。
  if (!reason || reason === "用户暂停") return false;
  return /用户操作页面或扩展重新启动|不在前台|浏览器连接中断|北京搜索入口|已配置的猎聘北京搜索页|页面无法识别|招聘页已断开/
    .test(reason);
}
async function ensureSiteSearchTab(source: "boss" | "liepin") {
  const search = await searchSettings();
  const targetUrl = source === "liepin" ? search.liepinUrl : search.bossUrl;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => {
    const url = tab.url ?? "";
    return source === "liepin"
      ? url.startsWith("https://www.liepin.com/zhaopin/")
      : url.startsWith("https://www.zhipin.com/web/geek/jobs");
  });
  await chrome.storage.session.set({ siteRunRecover: { at: Date.now() } });
  if (existing?.id) {
    const configured = source === "liepin"
      ? isConfiguredLiepinJobsUrl(existing.url ?? "", search.liepinUrl)
      : isConfiguredBossJobsUrl(existing.url ?? "", search.bossUrl);
    if (!configured)
      await chrome.tabs.update(existing.id, { url: targetUrl, active: true });
    else
      await chrome.tabs.update(existing.id, { active: true });
    try {
      await chrome.scripting.executeScript({
        target: { tabId: existing.id },
        files: ["content.js"],
      });
    } catch {
      // 页面连上后弹窗或下次恢复会再挂。
    }
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  return created.id ?? 0;
}
async function recoverSiteRun() {
  if (recoveringSiteRun || Date.now() - lastSiteRecoverAt < 5000) return { recovered: false };
  const stored = await chrome.storage.local.get("deviceToken");
  if (!stored.deviceToken) return { recovered: false };
  let state: {
    runs: {
      id: string; mode: string; status: string; reason: string; scope: string;
      profile: string; deadline: number;
    }[];
    connections: {
      tab: number; seen_at: number; blocked: string; source: string;
      account: string; profile: string;
    }[];
  };
  try {
    state = await request("/api/device/state", undefined, stored.deviceToken);
  } catch {
    return { recovered: false };
  }
  const now = Date.now() / 1000;
  const run = state.runs.find((item) =>
    item.mode === "auto" &&
    ["WAITING_HUMAN", "PAUSED_USER"].includes(item.status) &&
    item.deadline > now &&
    recoverableSiteReason(item.reason) &&
    (item.scope.startsWith("boss:") || item.scope.startsWith("liepin:")),
  );
  if (!run) return { recovered: false };
  recoveringSiteRun = true;
  lastSiteRecoverAt = Date.now();
  try {
    const source = run.scope.startsWith("liepin:") ? "liepin" : "boss";
    const tabId = await ensureSiteSearchTab(source);
    if (!tabId) return { recovered: false };
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await request("/api/device/state", undefined, stored.deviceToken);
      const fresh = state.runs.find((item) => item.id === run.id);
      if (!fresh || !["WAITING_HUMAN", "PAUSED_USER"].includes(fresh.status))
        return { recovered: true };
      const seen = Date.now() / 1000;
      const conn = state.connections.find((item) =>
        item.tab === tabId &&
        seen - item.seen_at < 20 &&
        !item.blocked &&
        `${item.source}:${item.account}` === run.scope &&
        item.profile === run.profile,
      );
      if (conn) {
        await request(
          `/api/device/runs/${run.id}/control`,
          { action: "resume" },
          stored.deviceToken,
        );
        return { recovered: true };
      }
    }
    return { recovered: false };
  } catch {
    return { recovered: false };
  } finally {
    recoveringSiteRun = false;
  }
}
chrome.tabs.onActivated.addListener(() => {
  void recoverSiteRun();
});
chrome.tabs.onRemoved.addListener(() => {
  void recoverSiteRun();
});
void chrome.alarms.create("recoverSiteRun", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "recoverSiteRun") void recoverSiteRun();
});
function fromPage(sender: chrome.runtime.MessageSender) {
  if (!sender.tab?.id || !sender.url) return false;
  const u = new URL(sender.url);
  return (
    u.origin === "https://www.zhipin.com" ||
    (u.origin === "https://www.liepin.com" && u.pathname === "/zhaopin/") ||
    (u.origin === API && u.pathname === "/fixture")
  );
}
function clearChatSession(tabId: number) {
  return chrome.storage.session.remove([
    `bossChatProbe:${tabId}`,
    `bossChatBaseline:${tabId}`,
  ]);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearChatSession(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) {
    let isChat = false;
    try {
      const url = new URL(change.url);
      isChat = url.origin === "https://www.zhipin.com" &&
        url.pathname === "/web/geek/chat";
    } catch {
      // A non-web URL cannot retain a BOSS chat baseline.
    }
    if (!isChat)
      void clearChatSession(tabId);
  }
});
async function request(path: string, body: unknown, token?: string) {
  const response = await fetch(API + path, {
    signal: AbortSignal.timeout(12000),
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(apiError(response.status, data));
  return data;
}
const liepinDetailButton = `(() => {
  const labels = ["聊一聊", "继续聊", "已沟通"];
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const nodes = [...document.querySelectorAll("button,a,[role='button'],span,div")].filter((element) =>
    labels.includes(element.textContent ? element.textContent.trim() : ""));
  const leaves = nodes.filter((element) =>
    !nodes.some((other) => other !== element && element.contains(other)));
  const options = leaves.flatMap((leaf) => {
    const control = leaf.closest("button,a,[role='button']") || leaf;
    if (!visible(control)) return [];
    const rect = control.getBoundingClientRect();
    if (rect.top < 0 || rect.top > 360) return [];
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || (top !== control && !control.contains(top))) return [];
    return [{ text: leaf.textContent.trim(), x, y, top: rect.top, left: rect.left }];
  });
  options.sort((a, b) => a.top - b.top || b.left - a.left);
  const panel = [...document.querySelectorAll("div,span,p,h2,h3")].some((element) =>
    visible(element) && element.textContent && element.textContent.trim() === "我的沟通" &&
    ![...element.children].some((child) => child.textContent && child.textContent.trim() === "我的沟通"));
  const closedLabels = ["该职位已暂停招聘", "职位已暂停招聘", "已下线"];
  const closed = [...document.querySelectorAll("h1,h2,h3,div,span,p")].some((element) =>
    visible(element) && closedLabels.includes(element.textContent ? element.textContent.trim() : ""));
  const pick = options[0] || null;
  return { text: pick ? pick.text : "", x: pick ? pick.x : 0, y: pick ? pick.y : 0, panel, closed };
})()`;

async function readLiepinDetailButton(tabId: number) {
  const raw = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: liepinDetailButton,
    returnByValue: true,
  }) as { result?: { value?: { text: string; x: number; y: number; panel: boolean; closed?: boolean } } };
  return raw.result?.value ?? { text: "", x: 0, y: 0, panel: false, closed: false };
}

async function pointerClick(tabId: number, pointAt: () => Promise<{ x: number; y: number }>) {
  const target = { tabId };
  let pressed = false;
  let point = { x: 0, y: 0 };
  await chrome.debugger.attach(target, "1.3");
  try {
    point = await pointAt();
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left",
      buttons: 1, clickCount: 1, pointerType: "mouse",
    });
    pressed = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left",
      buttons: 0, clickCount: 1, pointerType: "mouse",
    });
    pressed = false;
  } finally {
    if (pressed) await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function waitForLiepinDetail(before: Set<number | undefined>, searchId: number, path: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({});
    const found = tabs.find((tab) => {
      if (!tab.id || tab.id === searchId || before.has(tab.id) || !tab.url) return false;
      try {
        const url = new URL(tab.url);
        return url.origin === "https://www.liepin.com" && url.pathname === path;
      } catch {
        return false;
      }
    });
    if (found?.id && found.status === "complete") return found.id;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return 0;
}

async function clickLiepinDetailChat(tabId: number) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  let pressed = false;
  let point = { text: "", x: 0, y: 0, panel: false };
  try {
    const deadline = Date.now() + 8000;
    let button = await readLiepinDetailButton(tabId);
    while (!button.text && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      button = await readLiepinDetailButton(tabId);
    }
    if (button.text === "继续聊" || button.text === "已沟通")
      return { clicked: false, effect: false, already: true, unavailable: false };
    // 职位已暂停或已下线时没有聊一聊，关掉明细后继续下一岗。
    if (button.closed && button.text !== "聊一聊")
      return { clicked: false, effect: false, already: false, unavailable: true };
    if (button.text !== "聊一聊") throw new Error("明细页右上角没有聊一聊");
    point = await readLiepinDetailButton(tabId);
    if (point.text !== "聊一聊") throw new Error("明细页聊一聊按钮状态变化");
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left",
      buttons: 1, clickCount: 1, pointerType: "mouse",
    });
    pressed = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left",
      buttons: 0, clickCount: 1, pointerType: "mouse",
    });
    pressed = false;
    const effectDeadline = Date.now() + 5000;
    let effect = false;
    while (Date.now() < effectDeadline) {
      const after = await readLiepinDetailButton(tabId);
      if (after.panel || after.text === "继续聊" || after.text === "已沟通") {
        effect = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { clicked: true, effect, already: false, unavailable: false };
  } finally {
    if (pressed) await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    const popup =
      sender.id === chrome.runtime.id &&
      sender.url === chrome.runtime.getURL("popup.html");
    if (message.type === "pair" && popup) {
      const data = await request("/api/pair", {
        code: message.code,
        name: "本机 Chrome",
      });
      await chrome.storage.local.set({ deviceToken: data.token });
      return { paired: true };
    }
    if (message.type === "captureChatBaseline" && popup) {
      const stored = await chrome.storage.local.get("deviceToken");
      if (!stored.deviceToken) throw new Error("请先连接本机服务");
      if (!Number.isInteger(message.tabId) || message.tabId <= 0)
        throw new Error("请选择 BOSS 消息页");
      const tab = await chrome.tabs.get(message.tabId);
      const url = tab.url ? new URL(tab.url) : null;
      if (url?.origin !== "https://www.zhipin.com" ||
          url.pathname !== "/web/geek/chat")
        throw new Error("当前标签页不是 BOSS 消息页");
      const key = `bossChatProbe:${message.tabId}`;
      const probe = (await chrome.storage.session.get(key))[key] as
        (BossChatProbe & { seen_at: number }) | undefined;
      if (!probe || Date.now() - probe.seen_at > 5000 ||
          !probe.selected || !probe.conversation ||
          probe.account === "unverified" || !probe.panel_bound || !probe.complete)
        throw new Error("当前会话缺少稳定身份或完整消息基线，无法记录");
      await chrome.storage.session.set({
        [`bossChatBaseline:${message.tabId}`]: {
          ...probe,
          captured_at: Date.now(),
        },
      });
      return { captured: true };
    }
    if (message.type === "boot" && popup) return { boot: runtimeBoot };
    if (message.type === "recoverSiteRun") {
      // 弹窗或页面脚本都可触发；招聘页丢失时自动拉回搜索页并恢复。
      return recoverSiteRun();
    }
    if (message.type === "attach" && popup) {
      if (!Number.isInteger(message.tabId) || message.tabId <= 0)
        throw new Error("没有可连接的标签页");
      const tab = await chrome.tabs.get(message.tabId);
      const url = tab.url ?? "";
      const jobPage = url.startsWith("https://www.liepin.com/zhaopin/") ||
        url.startsWith("https://www.zhipin.com/web/geek/jobs") ||
        url.startsWith("http://127.0.0.1:17830/fixture");
      if (!jobPage) throw new Error("当前标签页不是招聘职位页");
      // 扩展重载后，已打开的猎聘页不会自动重新注入内容脚本。
      await chrome.scripting.executeScript({
        target: { tabId: message.tabId },
        files: ["content.js"],
      });
      return { attached: true };
    }
    if (message.type === "panel" && popup) {
      const stored = await chrome.storage.local.get("deviceToken");
      if (!stored.deviceToken) throw new Error("请先连接本机服务");
      if (message.action === "state")
        return request("/api/device/state", undefined, stored.deviceToken);
      if (message.action === "start")
        return request("/api/device/runs", message.body, stored.deviceToken);
      if (
        message.action === "control" &&
        /^[a-f0-9-]{36}$/.test(message.run_id)
      )
        return request(
          `/api/device/runs/${message.run_id}/control`,
          message.body,
          stored.deviceToken,
        );
      if (message.action === "resolve" &&
          /^[a-f0-9-]{36}$/.test(message.command_id))
        return request(
          `/api/device/commands/${message.command_id}/resolve`,
          message.body,
          stored.deviceToken,
        );
      throw new Error("未允许的扩展面板操作");
    }
    if (!fromPage(sender)) throw new Error("不允许的页面来源");
    if (message.type === "clickLiepinDetail") {
      const url = new URL(sender.url!);
      if (url.origin !== "https://www.liepin.com" || url.pathname !== "/zhaopin/" ||
          !isConfiguredLiepinJobsUrl(url, (await searchSettings()).liepinUrl))
        throw new Error("仅允许在猎聘北京职位列表打开明细");
      const path = message.path;
      if (typeof path !== "string" || !/^\/(a|job)\/\d+\.shtml$/.test(path))
        throw new Error("猎聘职位链接无效");
      const x = message.x;
      const y = message.y;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
          x > 10000 || y > 10000)
        throw new Error("职位标题坐标无效");
      const paired = await chrome.storage.local.get("deviceToken");
      if (!paired.deviceToken) throw new Error("请先连接本机服务");
      if (!await chrome.permissions.contains({ permissions: ["debugger"] }))
        throw new Error("猎聘真实点击需要一次性授予 Chrome 调试权限");
      const searchId = sender.tab!.id!;
      if (!sender.tab?.active) throw new Error("猎聘职位页不在当前标签页");
      const before = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
      await pointerClick(searchId, async () => {
        const fresh = await chrome.tabs.sendMessage(searchId, { type: "liepinFreshPoint" });
        return fresh?.ok && Number.isFinite(fresh.x) && Number.isFinite(fresh.y)
          ? { x: fresh.x as number, y: fresh.y as number }
          : { x, y };
      });
      const detailId = await waitForLiepinDetail(before, searchId, path);
      if (!detailId) throw new Error("点击职位后未打开明细页");
      let clicked = false;
      let effect = false;
      let already = false;
      let unavailable = false;
      let closed = false;
      try {
        await chrome.tabs.update(detailId, { active: true });
        const outcome = await clickLiepinDetailChat(detailId);
        clicked = outcome.clicked;
        effect = outcome.effect;
        already = outcome.already;
        unavailable = outcome.unavailable;
      } finally {
        await chrome.tabs.remove(detailId).then(() => { closed = true; }).catch(() => {});
        await chrome.tabs.update(searchId, { active: true }).catch(() => {});
      }
      return { clicked, effect, already, unavailable, closed };
    }
    if (message.type === "chatProbe") {
      if (new URL(sender.url!).pathname !== "/web/geek/chat")
        throw new Error("只允许 BOSS 消息页上报会话观察");
      const paired = await chrome.storage.local.get("deviceToken");
      if (!paired.deviceToken) return { stored: false };
      const probe = message.observation;
      if (!probe || typeof probe.selected !== "boolean" ||
          !(/^[a-f0-9]{24}$/.test(probe.account) || probe.account === "unverified") ||
          !/^(?:[a-f0-9]{64})?$/.test(probe.conversation) ||
          !["", "data-conversation-id", "data-chat-id", "data-encrypt-id", "data-uid", "display-triple"].includes(probe.identity_source) ||
          typeof probe.panel_bound !== "boolean" ||
          typeof probe.complete !== "boolean" ||
          !["READY", "WAITING_PEER", "UNAVAILABLE"].includes(probe.resume) ||
          !Array.isArray(probe.outgoing) || probe.outgoing.length > 100 ||
          !probe.outgoing.every((item: unknown) =>
            !!item && typeof item === "object" &&
            /^[a-f0-9]{64}$/.test((item as { id?: string }).id ?? "") &&
            typeof (item as { delivered?: unknown }).delivered === "boolean") ||
          typeof probe.reason !== "string" || probe.reason.length > 100)
        throw new Error("会话观察格式无效");
      const baselineKey = `bossChatBaseline:${sender.tab!.id}`;
      const baseline = (await chrome.storage.session.get(baselineKey))[baselineKey] as
        (BossChatProbe & { captured_at: number }) | undefined;
      const delta = baseline ? compareBossChat(baseline, probe) : null;
      await chrome.storage.session.set({
        [`bossChatProbe:${sender.tab!.id}`]: {
          ...probe,
          delta,
          baseline_at: baseline?.captured_at ?? null,
          seen_at: Date.now(),
        },
      });
      return { stored: true };
    }
    const stored = await chrome.storage.local.get([
      "deviceToken",
      "bossProfile",
    ]);
    const session = await chrome.storage.session.get("browserSession");
    const sessionId = session.browserSession ?? crypto.randomUUID();
    if (!session.browserSession)
      await chrome.storage.session.set({ browserSession: sessionId });
    if (message.type === "config") {
      // The first installed build stored its empty discovery template. Migrate
      // only that known template; retain any user-authored profile unchanged.
      const previousDefault = { ...discoveryProfile, name: "boss-read-v2" };
      if ((stored.bossProfile?.name === "boss-discovery-v1" &&
           stored.bossProfile?.calibrated === false) ||
          JSON.stringify(stored.bossProfile) === JSON.stringify(previousDefault)) {
        await chrome.storage.local.remove("bossProfile");
        stored.bossProfile = null;
      }
      return {
        paired: !!stored.deviceToken,
        boot: runtimeBoot,
        profile: stored.bossProfile ?? null,
        searchSettings: await searchSettings(),
      };
    }
    if (
      message.type !== "bridge" ||
      !/^\/api\/bridge\/(tick|halt|commands\/[a-f0-9-]+\/(claim|result))$/.test(
        message.path,
      )
    )
      throw new Error("未允许的命令");
    if (!stored.deviceToken) throw new Error("请先在扩展中输入配对码");
    const body = message.body;
    const snap = body.snapshot ?? body;
    snap.tab = sender.tab!.id;
    snap.session = sessionId;
    snap.document = sender.documentId ?? snap.document;
    const u = new URL(sender.url!);
    snap.url = u.origin + u.pathname;
    snap.source = u.origin === API ? "fixture" :
      u.origin === "https://www.liepin.com" ? "liepin" : "boss";
    const search = await searchSettings();
    if (snap.source === "boss") snap.search_limited = !isConfiguredBossJobsUrl(u, search.bossUrl);
    if (snap.source === "liepin") snap.search_limited = !isConfiguredLiepinJobsUrl(u, search.liepinUrl);
    await chrome.storage.local.set({
      lastDiagnostic: {
        at: Date.now(),
        source: snap.source,
        profile: snap.profile,
        blocked: snap.blocked,
        cards: snap.cards?.length ?? 0,
        detailKey: snap.detail?.key ?? null,
      },
    });
    return request(message.path, body, stored.deviceToken);
  })()
    .then((value) => respond({ ok: true, value }))
    .catch((error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : "连接失败",
      }),
    );
  return true;
});
