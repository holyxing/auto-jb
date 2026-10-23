import { Adapter } from "./adapter";
import { fixtureProfile, discoveryProfile, validateProfile } from "./profiles";
import type { Command } from "./types";
import { sameView } from "./snapshot";
import { observeBossChat } from "./bossChat";
import { LiepinAdapter, liepinProfile } from "./liepinAdapter";
import type { SearchSettings } from "./searchSettings";
async function rpc(message: unknown) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error ?? "扩展连接中断");
  return result.value;
}
const source = location.hostname === "www.zhipin.com"
  ? "boss" : location.hostname === "www.liepin.com" ? "liepin" : "fixture";
let localEpoch = 0;
let adapter: Adapter | LiepinAdapter;
let halted = false;
let looping = false;
let loopResult = Promise.resolve(false);
let runtimeBootSeen = "";
let loopError = "";
async function bridge(path: string, body: unknown) {
  return rpc({ type: "bridge", path, body });
}
let unloading = false;
type PageTurn = { at: number; commandId: string };
async function takeLiepinPageTurn(): Promise<PageTurn | null> {
  if (source !== "liepin") return null;
  try {
    const stored = await chrome.storage.session.get("liepinPageTurn");
    const turn = stored.liepinPageTurn as PageTurn | undefined;
    if (!turn || typeof turn.at !== "number" || !/^[a-f0-9-]{36}$/.test(turn.commandId ?? ""))
      return null;
    await chrome.storage.session.remove("liepinPageTurn");
    if (Date.now() - turn.at > 20000) return null;
    return turn;
  } catch {
    // 翻页标记读不到时继续连接，不能挡住心跳。
    return null;
  }
}
async function takeSiteRunRecover(): Promise<boolean> {
  try {
    const stored = await chrome.storage.session.get("siteRunRecover");
    const flag = stored.siteRunRecover as { at?: number } | undefined;
    if (!flag || typeof flag.at !== "number") return false;
    await chrome.storage.session.remove("siteRunRecover");
    return Date.now() - flag.at <= 20000;
  } catch {
    return false;
  }
}
async function loop() {
  if (looping) return loopResult;
  looping = true;
  let finish = (_connected: boolean) => {};
  loopResult = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let connected = false;
  try {
    const config = await rpc({ type: "config" });
    runtimeBootSeen = typeof config.boot === "string" ? config.boot : "";
    if (!config.paired) {
      loopError = "请先连接本机服务";
      return false;
    }
    const search = config.searchSettings as SearchSettings;
    const jobsUrl = source === "liepin" ? search.liepinUrl : search.bossUrl;
    const p = source === "liepin"
      ? liepinProfile
      : source === "fixture"
        ? fixtureProfile
        : config.profile
          ? validateProfile(config.profile)
          : discoveryProfile;
    const freshDocument = !adapter;
    const turn = freshDocument ? await takeLiepinPageTurn() : null;
    const recovering = freshDocument ? await takeSiteRunRecover() : false;
    if (freshDocument || JSON.stringify(adapter.profile) !== JSON.stringify(p) ||
        adapter.jobsUrl !== jobsUrl) {
      adapter = source === "liepin"
        ? new LiepinAdapter(crypto.randomUUID(), jobsUrl)
        : new Adapter(p as typeof fixtureProfile, source, crypto.randomUUID(), jobsUrl);
      // 翻页或自动拉回搜索页时，不按用户重载暂停。
      if (!turn && !recovering) await bridge("/api/bridge/halt", await adapter.snapshot());
    }
    if (turn) {
      try {
        await bridge(`/api/bridge/commands/${turn.commandId}/result`, {
          outcome: "OK",
          snapshot: await adapter.snapshot(),
          note: "",
          click_dispatched: false,
          effect_observed: false,
        });
      } catch {
        // 翻页前的页面可能已经交回结果。
      }
    }
    let snap = await adapter.snapshot();
    const result = await bridge("/api/bridge/tick", snap);
    connected = true;
    loopError = "";
    if (result.status === "RUNNING") halted = false;
    const cmd = result.command as Command | null;
    if (!cmd || halted) return true;
    const epoch = localEpoch;
    const fresh = await adapter.snapshot();
    if (!sameView(fresh, cmd.binding)) return true;
    const claim = await bridge(`/api/bridge/commands/${cmd.id}/claim`, fresh);
    const claimedAt = performance.now();
    const deadline = claimedAt + Math.min(
      ["SELECT", "SCROLL"].includes(cmd.action) ? 3000 :
        cmd.action === "CONTACT" && source === "liepin" ? 1500 : 500,
      claim.valid_for_ms,
    );
    const cleanupDeadline = claimedAt + Math.min(
      cmd.action === "CONTACT" && source === "liepin" ? 6500 : 2200,
      claim.valid_for_ms,
    );
    const validUntil = (localDeadline: number) =>
      !halted &&
      epoch === localEpoch &&
      performance.now() < localDeadline &&
      Date.now() / 1000 < claim.valid_until;
    const valid = () => validUntil(deadline);
    const cleanupValid = () => validUntil(cleanupDeadline);
    let outcome = "OK";
    let note = "";
    const liepinPageTurn = source === "liepin" && cmd.action === "SCROLL";
    if (liepinPageTurn) {
      try {
        await chrome.storage.session.set({
          liepinPageTurn: { at: Date.now(), commandId: cmd.id },
        });
      } catch {
        // 写不进翻页标记时，新页面会按普通重载暂停。
      }
    }
    adapter.contactClickDispatched = false;
    if (adapter instanceof LiepinAdapter) adapter.contactEffectObserved = false;
    try {
      if (!valid()) throw new Error("执行许可已过期");
      const finalCheck = await adapter.snapshot();
      if (!sameView(finalCheck, cmd.binding)) throw new Error("执行前页面变化");
      snap = await adapter.execute(cmd, valid, cleanupValid);
    } catch (e) {
      outcome = cmd.action === "CONTACT" && source === "liepin" &&
        !adapter.contactClickDispatched ? "NO_EFFECT" :
        ["CONTACT", "RESUME_SEND"].includes(cmd.action) ? "UNKNOWN" : "NO_EFFECT";
      note = e instanceof Error ? e.message : "执行失败";
      snap = await adapter.snapshot();
    }
    if (!unloading) {
      await bridge(`/api/bridge/commands/${cmd.id}/result`, {
        outcome,
        snapshot: snap,
        note,
        click_dispatched: cmd.action === "CONTACT" && adapter.contactClickDispatched,
        effect_observed: cmd.action === "CONTACT" &&
          adapter instanceof LiepinAdapter && adapter.contactEffectObserved,
      });
      if (liepinPageTurn) {
        try {
          await chrome.storage.session.remove("liepinPageTurn");
        } catch {
          // 标记过期后不再使用。
        }
      }
    }
    return true;
  } catch (e) {
    // 连接失败留在弹窗里显示，不自动重试同一个点击。
    loopError = e instanceof Error ? e.message : "连接失败";
    return false;
  } finally {
    looping = false;
    finish(connected);
  }
}
let pageGeneration = 0;
async function poll(generation: number) {
  await loop();
  if (generation === pageGeneration) setTimeout(() => void poll(generation), 1000);
}
async function pollChat(generation: number) {
  try {
    const observation = await observeBossChat(document);
    await chrome.runtime.sendMessage({ type: "chatProbe", observation });
  } catch {
    // 会话观察不执行外部动作，也不改变任务。
  }
  if (generation === pageGeneration) setTimeout(() => void pollChat(generation), 1500);
}
type PageArm = { stop: () => void };
const pageSlot = globalThis as { __autoJbContent?: PageArm };
function armPage() {
  pageSlot.__autoJbContent?.stop();
  const generation = ++pageGeneration;
  const onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, respond) => {
    // wake2 只由当前这次注入的脚本回答。扩展重载后残留的旧脚本不认识它。
    if (message?.type === "wake2") {
      loop().then((ok) => respond({
        ok: ok === true,
        boot: ok === true ? runtimeBootSeen : "",
        error: ok === true ? "" : loopError || "招聘页没有完成连接",
      })).catch((error) => {
        respond({ ok: false, error: error instanceof Error ? error.message : "唤醒失败" });
      });
      return true;
    }
    if (source !== "liepin" || message?.type !== "liepinFreshPoint") return;
    const liepin = adapter instanceof LiepinAdapter ? adapter : null;
    const point = liepin?.freshPointerPoint() ?? null;
    respond(point ? { ok: true, x: point.x, y: point.y } : { ok: false, error: "职位标题坐标失效" });
    return true;
  };
  const onHide = () => {
    unloading = true;
  };
  const onUser = (e: Event) => {
    if (!e.isTrusted || !adapter) return;
    if (e.type === "pointerdown" && adapter instanceof LiepinAdapter &&
        adapter.automatedPointerPoint &&
        performance.now() < adapter.automatedPointerUntil &&
        e instanceof PointerEvent && e.button === 0 &&
        Math.abs(e.clientX - adapter.automatedPointerPoint[0]) < 2 &&
        Math.abs(e.clientY - adapter.automatedPointerPoint[1]) < 2) return;
    halted = true;
    localEpoch++;
    void adapter
      .snapshot()
      .then((s) => bridge("/api/bridge/halt", s))
      .then(() => chrome.runtime.sendMessage({ type: "recoverSiteRun" }))
      .catch(() => {});
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener("pagehide", onHide);
  for (const event of ["pointerdown", "keydown", "wheel"])
    document.addEventListener(event, onUser, { capture: true, passive: true });
  pageSlot.__autoJbContent = {
    stop() {
      pageGeneration += 1;
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener("pagehide", onHide);
      for (const event of ["pointerdown", "keydown", "wheel"])
        document.removeEventListener(event, onUser, { capture: true });
    },
  };
  if (source === "fixture" || location.pathname === "/web/geek/jobs" ||
      (source === "liepin" && location.pathname === "/zhaopin/")) void poll(generation);
  else if (location.pathname === "/web/geek/chat") void pollChat(generation);
}
armPage();
