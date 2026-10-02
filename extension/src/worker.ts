import { compareBossChat, type BossChatProbe } from "./bossChat";
import { isConfiguredBossJobsUrl } from "./bossJobsUrl";
import { discoveryProfile } from "./profiles";
import { isConfiguredLiepinJobsUrl } from "./liepinJobsUrl";
const API = "http://127.0.0.1:17830";
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
    throw new Error(
      typeof data.detail === "string" ? data.detail : "请求被拒绝",
    );
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
  const pick = options[0] || null;
  return { text: pick ? pick.text : "", x: pick ? pick.x : 0, y: pick ? pick.y : 0, panel };
})()`;

async function readLiepinDetailButton(tabId: number) {
  const raw = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: liepinDetailButton,
    returnByValue: true,
  }) as { result?: { value?: { text: string; x: number; y: number; panel: boolean } } };
  return raw.result?.value ?? { text: "", x: 0, y: 0, panel: false };
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
      return { clicked: false, effect: false, already: true };
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
    return { clicked: true, effect, already: false };
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
          !isConfiguredLiepinJobsUrl(url))
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
      let closed = false;
      try {
        await chrome.tabs.update(detailId, { active: true });
        const outcome = await clickLiepinDetailChat(detailId);
        clicked = outcome.clicked;
        effect = outcome.effect;
        already = outcome.already;
      } finally {
        await chrome.tabs.remove(detailId).then(() => { closed = true; }).catch(() => {});
        await chrome.tabs.update(searchId, { active: true }).catch(() => {});
      }
      return { clicked, effect, already, closed };
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
        profile: stored.bossProfile ?? null,
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
    if (snap.source === "boss") snap.search_limited = !isConfiguredBossJobsUrl(u);
    if (snap.source === "liepin") snap.search_limited = !isConfiguredLiepinJobsUrl(u);
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
