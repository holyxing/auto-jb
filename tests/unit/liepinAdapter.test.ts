import { afterEach, expect, it, vi } from "vitest";
import { LiepinAdapter } from "../../extension/src/liepinAdapter";

const address = "https://www.liepin.com/zhaopin/?city=010&dq=010&key=ai产品经理&workYearCode=0";

function setup() {
  vi.stubGlobal("location", new URL(address));
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn().mockImplementation(async (message) => {
    if (message.type === "clickLiepinDetail")
      return { ok: true, value: { clicked: true, effect: true, already: false, closed: true } };
    return { ok: false, error: "未预期的扩展消息" };
  }) } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100, height: 40, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, toJSON() {},
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <header><div class="user"><img src="https://image.liepin.com/avatar/account-1.png"><span>你好，测试用户</span></div></header>
    <main><article class="card"><a href="/a/123.shtml" target="_blank">AI产品经理 【 北京-朝阳区 】 30-50k</a><span class="company">测试企业</span><button class="chat"><span>聊一聊</span></button></article>
    <article class="card"><a href="/job/456.shtml">AI产品经理 【 北京 】 20-40k</a><span class="company">另一企业</span><button class="continued">继续聊</button></article></main>
    <nav class="list-pagination-box"><a aria-current="page" class="active">1</a></nav>`;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true, value: () => document.querySelector("a[href='/a/123.shtml']"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("ignores the header chat link and blocks only a closable communication panel", async () => {
  setup();
  document.querySelector("header")!.insertAdjacentHTML("beforeend", `<span>我的沟通</span>`);
  expect((await new LiepinAdapter("doc").snapshot()).blocked).toBe("");
  document.body.insertAdjacentHTML("beforeend",
    `<aside><h2>我的沟通</h2><button aria-label="关闭">×</button></aside>`);
  expect((await new LiepinAdapter("doc").snapshot()).blocked).toBe("猎聘沟通面板仍打开，需关闭后继续");
});

it("binds hunter and direct job IDs and skips a card that already says continue-chat", async () => {
  setup();
  const adapter = new LiepinAdapter("doc");
  const before = await adapter.snapshot();
  expect(before.account).toMatch(/^[a-f0-9]{24}$/);
  expect(before.cards.map((card) => card.key)).toEqual(["a:123", "job:456"]);
  expect(before.cards[0].city).toBe("北京-朝阳区");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true, value: () => document.querySelector("a[href='/job/456.shtml']"),
  });
  await adapter.execute({ action: "SELECT", job_key: "job:456" } as never, () => true);
  expect((await adapter.snapshot()).detail?.contact_button).toBe("ALREADY_CONTACTED");
  await adapter.execute({ action: "CONTACT", job_key: "job:456" } as never, () => true);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(adapter.contactClickDispatched).toBe(false);
});

it("opens the job detail from the title link instead of hovering the list button", async () => {
  setup();
  const adapter = new LiepinAdapter("doc");
  await adapter.execute({ action: "SELECT", job_key: "a:123" } as never, () => true);
  await adapter.execute({ action: "CONTACT", job_key: "a:123" } as never, () => true);
  expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.map(([message]) => message))
    .toEqual([{ type: "clickLiepinDetail", x: 50, y: 20, path: "/a/123.shtml" }]);
  expect(adapter.contactClickDispatched).toBe(true);
  expect(adapter.contactEffectObserved).toBe(true);
});

it("records an already-contacted detail page without clicking chat", async () => {
  setup();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    ok: true, value: { clicked: false, effect: false, already: true, closed: true },
  });
  const adapter = new LiepinAdapter("doc");
  await adapter.execute({ action: "SELECT", job_key: "a:123" } as never, () => true);
  const after = await adapter.execute({ action: "CONTACT", job_key: "a:123" } as never, () => true);
  expect(after.detail?.contact_button).toBe("ALREADY_CONTACTED");
  expect(adapter.contactClickDispatched).toBe(false);
});

it("skips a paused or offline detail page without clicking chat", async () => {
  setup();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    ok: true, value: { clicked: false, effect: false, already: false, unavailable: true, closed: true },
  });
  const adapter = new LiepinAdapter("doc");
  await adapter.execute({ action: "SELECT", job_key: "a:123" } as never, () => true);
  const after = await adapter.execute({ action: "CONTACT", job_key: "a:123" } as never, () => true);
  expect(after.detail?.contact_button).toBe("MISSING");
  expect(adapter.contactClickDispatched).toBe(false);
});

it("skips a paused detail after the click window has expired", async () => {
  setup();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    ok: true, value: { clicked: false, effect: false, already: false, unavailable: true, closed: true },
  });
  const adapter = new LiepinAdapter("doc");
  await adapter.execute({ action: "SELECT", job_key: "a:123" } as never, () => true);
  const after = await adapter.execute(
    { action: "CONTACT", job_key: "a:123" } as never,
    () => true,
    () => false,
  );
  expect(after.detail?.contact_button).toBe("MISSING");
  expect(adapter.contactClickDispatched).toBe(false);
});

it("continues by clicking the next pagination number", async () => {
  setup();
  document.querySelector(".list-pagination-box")!.insertAdjacentHTML("beforeend", `<a class="page-next">2</a>`);
  const next = document.querySelector<HTMLAnchorElement>(".page-next")!;
  const link = document.querySelector<HTMLAnchorElement>("a[href='/a/123.shtml']")!;
  next.onclick = () => { link.href = "/a/999.shtml"; };
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true, value: () => next,
  });
  const adapter = new LiepinAdapter("doc");
  expect((await adapter.snapshot()).list_end).toBe(false);
  const before = (await adapter.snapshot()).list_signature;
  const after = await adapter.execute({ action: "SCROLL" } as never, () => true);
  expect(after.list_signature).not.toBe(before);
  expect(after.cards.some((card) => card.key === "a:999")).toBe(true);
});

it("refuses a covered job title", async () => {
  setup();
  const adapter = new LiepinAdapter("doc");
  await adapter.execute({ action: "SELECT", job_key: "a:123" } as never, () => true);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
  await expect(adapter.execute({ action: "CONTACT", job_key: "a:123" } as never, () => true))
    .rejects.toThrow("职位标题被遮挡");
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("does not accept a detail click without a chat response", async () => {
  setup();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    ok: true, value: { clicked: true, effect: false, already: false, closed: true },
  });
  const adapter = new LiepinAdapter("doc");
  await adapter.execute({ action: "SELECT", job_key: "a:123" } as never, () => true);
  await expect(adapter.execute({ action: "CONTACT", job_key: "a:123" } as never, () => true))
    .rejects.toThrow("未观察到猎聘会话或已沟通状态");
  expect(adapter.contactClickDispatched).toBe(true);
  expect(adapter.contactEffectObserved).toBe(false);
});
