import { Adapter } from "./adapter";
import { fixtureProfile, discoveryProfile, validateProfile } from "./profiles";
import type { Command } from "./types";
import { sameView } from "./snapshot";
import { observeBossChat } from "./bossChat";
import { LiepinAdapter, liepinProfile } from "./liepinAdapter";
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
let loopDone = Promise.resolve();
async function bridge(path: string, body: unknown) {
  return rpc({ type: "bridge", path, body });
}
async function loop() {
  if (looping) return loopDone;
  looping = true;
  let finish = () => {};
  loopDone = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const config = await rpc({ type: "config" });
    if (!config.paired) return;
    const p = source === "liepin"
      ? liepinProfile
      : source === "fixture"
        ? fixtureProfile
        : config.profile
          ? validateProfile(config.profile)
          : discoveryProfile;
    if (!adapter || JSON.stringify(adapter.profile) !== JSON.stringify(p)) {
      adapter = source === "liepin"
        ? new LiepinAdapter(crypto.randomUUID())
        : new Adapter(p as typeof fixtureProfile, source, crypto.randomUUID());
      // New document/worker handshake must never silently resume an old action loop.
      await bridge("/api/bridge/halt", await adapter.snapshot());
    }
    let snap = await adapter.snapshot();
    const result = await bridge("/api/bridge/tick", snap);
    if (result.status === "RUNNING") halted = false;
    const cmd = result.command as Command | null;
    if (!cmd || halted) return;
    const epoch = localEpoch;
    const fresh = await adapter.snapshot();
    if (!sameView(fresh, cmd.binding)) return;
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
    await bridge(`/api/bridge/commands/${cmd.id}/result`, {
      outcome,
      snapshot: snap,
      note,
      click_dispatched: cmd.action === "CONTACT" && adapter.contactClickDispatched,
      effect_observed: cmd.action === "CONTACT" &&
        adapter instanceof LiepinAdapter && adapter.contactEffectObserved,
    });
  } catch (e) {
    /* Errors are surfaced through connection freshness and extension diagnostics; never replay. */
  } finally {
    looping = false;
    finish();
  }
}
async function poll() {
  await loop();
  setTimeout(poll, 1000);
}
async function pollChat() {
  try {
    const observation = await observeBossChat(document);
    await chrome.runtime.sendMessage({ type: "chatProbe", observation });
  } catch {
    // The chat probe never performs an external action or changes a run.
  }
  setTimeout(pollChat, 1500);
}
const installed = globalThis as { __autoJbContent?: boolean };
if (!installed.__autoJbContent) {
  installed.__autoJbContent = true;
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "wake") {
      loop().then(() => respond({ ok: true })).catch((error) => {
        respond({ ok: false, error: error instanceof Error ? error.message : "唤醒失败" });
      });
      return true;
    }
    if (source !== "liepin" || message?.type !== "liepinFreshPoint") return;
    const liepin = adapter instanceof LiepinAdapter ? adapter : null;
    const point = liepin?.freshPointerPoint() ?? null;
    respond(point ? { ok: true, x: point.x, y: point.y } : { ok: false, error: "职位标题坐标失效" });
    return true;
  });
  for (const event of ["pointerdown", "keydown", "wheel"])
    document.addEventListener(
      event,
      (e) => {
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
          .catch(() => {});
      },
      { capture: true, passive: true },
    );
  if (source === "fixture" || location.pathname === "/web/geek/jobs" ||
      (source === "liepin" && location.pathname === "/zhaopin/")) void poll();
  else if (location.pathname === "/web/geek/chat") void pollChat();
}
