import { afterEach, expect, it, vi } from "vitest";
import { Adapter, one } from "../../extension/src/adapter";
import { discoveryProfile, fixtureProfile, validateProfile } from "../../extension/src/profiles";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function layout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 40,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 40,
    toJSON() {},
  });
  document.body.innerHTML =
    '<button class="target">一</button><button class="target">二</button>';
}
it("ambiguous visible elements cannot be selected", () => {
  layout();
  expect(() => one(document, ".target")).toThrow("不唯一");
});
it("occluded target is not clicked", () => {
  layout();
  const adapter = new Adapter(fixtureProfile, "fixture", "doc");
  const el = document.querySelector("button")!;
  const click = vi.fn();
  el.onclick = click;
  el.scrollIntoView = vi.fn();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => document.body,
  });
  expect(() => adapter.click(el)).toThrow("遮挡");
  expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
  expect(click).not.toHaveBeenCalled();
});
it("selection waits for a transient overlay and clicks once when the title is exposed", async () => {
  layout();
  const adapter = new Adapter(fixtureProfile, "fixture", "doc");
  const el = document.querySelector("button")!;
  el.scrollIntoView = vi.fn();
  const click = vi.fn();
  el.onclick = click;
  let checks = 0;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => (++checks <= 9 ? document.body : el),
  });
  await adapter.clickSelection(el, () => true, 400);
  expect(el.scrollIntoView).toHaveBeenCalledWith({
    block: "center", inline: "nearest", behavior: "instant",
  });
  expect(click).toHaveBeenCalledTimes(1);
});
it("selection never clicks through a persistent overlay or expired lease", async () => {
  layout();
  const adapter = new Adapter(fixtureProfile, "fixture", "doc");
  const el = document.querySelector("button")!;
  el.scrollIntoView = vi.fn();
  const click = vi.fn();
  el.onclick = click;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => document.body,
  });
  await expect(adapter.clickSelection(el, () => true, 90)).rejects.toThrow("遮挡");
  expect(click).not.toHaveBeenCalled();
  await expect(adapter.clickSelection(el, () => false)).rejects.toThrow("接管或命令过期");
  expect(click).not.toHaveBeenCalled();
});
it("dismisses only the observed post-contact greeting and stays on the jobs page", async () => {
  layout();
  document.body.innerHTML = `
    <div class="greet-boss-layer"></div>
    <div class="greet-boss-dialog">
      <h3>已向BOSS发送消息</h3>
      <a class="stay">留在此页</a><a class="chat">继续沟通</a>
    </div>`;
  const stay = document.querySelector<HTMLElement>(".stay")!;
  stay.scrollIntoView = vi.fn();
  const stayClick = vi.fn(() => {
    document.querySelector(".greet-boss-layer")!.remove();
    document.querySelector(".greet-boss-dialog")!.remove();
  });
  stay.onclick = stayClick;
  const chatClick = vi.fn();
  document.querySelector<HTMLElement>(".chat")!.onclick = chatClick;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => stay,
  });
  await new Adapter(discoveryProfile, "boss", "doc").dismissBossGreeting(() => true);
  expect(stayClick).toHaveBeenCalledTimes(1);
  expect(chatClick).not.toHaveBeenCalled();
  expect(document.querySelector(".greet-boss-layer")).toBeNull();
});
it("does not dismiss an unfamiliar overlay", async () => {
  layout();
  document.body.innerHTML = '<div class="greet-boss-layer"></div><div><h3>请验证身份</h3><a>留在此页</a></div>';
  const stay = document.querySelector<HTMLElement>("a")!;
  const click = vi.fn();
  stay.onclick = click;
  await expect(
    new Adapter(discoveryProfile, "boss", "doc").dismissBossGreeting(() => true),
  ).rejects.toThrow("弹层状态未知");
  expect(click).not.toHaveBeenCalled();
});
it("BOSS disabled-looking resume control cannot be clicked", () => {
  layout();
  const adapter = new Adapter(discoveryProfile, "boss", "doc");
  const el = document.querySelector("button")!;
  const click = vi.fn();
  el.classList.add("unable");
  el.onclick = click;
  expect(() => adapter.click(el)).toThrow("不可操作");
  expect(click).not.toHaveBeenCalled();
});
it("revoked command produces no page action", async () => {
  layout();
  const adapter = new Adapter(fixtureProfile, "fixture", "doc");
  await expect(
    adapter.execute(
      {
        id: "1",
        action: "CONTACT",
        job_key: "a",
        epoch: 1,
        binding: {},
        expires: 0,
        resume_name: "",
      },
      () => false,
    ),
  ).rejects.toThrow("用户已接管");
});
it("background BOSS tab pauses page operations", async () => {
  layout();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const snap = await new Adapter(discoveryProfile, "boss", "doc").snapshot();
  expect(snap.blocked).toContain("不在前台");
});
it("calibrated profile cannot omit stable job identity", () => {
  expect(() => validateProfile({ ...fixtureProfile, detailKey: "" })).toThrow(
    "detailKey",
  );
});
it("observed BOSS list binds left and right by job id without enabling send", async () => {
  vi.stubGlobal("location", new URL("https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101010100&industry=&position="));
  layout();
  document.body.innerHTML = `
    <div id="header"><div class="user-nav"><div class="nav-figure"><a><img src="https://img.bosszhipin.com/beijin/upload/avatar/private-image.webp?size=100"></a></div></div></div>
    <ul class="rec-job-list"><div class="job-card-wrap active"><a class="job-name" href="/job_detail/job-1.html">AI 产品经理</a><span class="boss-name">甲公司</span><span class="company-location">北京·朝阳区·酒仙桥</span></div></ul>
    <div class="job-detail-box"><div class="job-detail-header"><div class="job-header-info"><span class="job-name">AI 产品经理</span></div><ul class="tag-list"><a href="/c101010100/">北京</a></ul><a class="op-btn-chat">立即沟通</a></div><div class="boss-info-attr">甲公司 · HR</div><div class="job-detail-body"><p class="desc">负责 AI 产品规划</p></div><a class="more-job-btn" href="/job_detail/job-1.html?securityId=secret">详情</a></div>`;
  const snap = await new Adapter(discoveryProfile, "boss", "doc").snapshot();
  expect(snap.account).not.toBe("unverified");
  expect(snap.cards).toMatchObject([{ key: "job-1", company: "甲公司", city: "北京·朝阳区·酒仙桥" }]);
  expect(snap.selected_key).toBe("job-1");
  expect(snap.detail).toMatchObject({ key: "job-1", company: "甲公司", city: "北京", contact_button: "READY" });
  expect(snap.blocked).toBe("");
  expect(snap.send_ready).toBe(false);
  expect(snap.contact_click_ready).toBe(true);
  document.querySelector<HTMLElement>(".op-btn-chat")!.textContent = "继续沟通";
  expect((await new Adapter(discoveryProfile, "boss", "doc").snapshot()).detail?.contact_button)
    .toBe("ALREADY_CONTACTED");
  document.querySelector<HTMLElement>(".op-btn-chat")!.textContent = "立即沟通";
  const contact = document.querySelector<HTMLElement>(".op-btn-chat")!;
  const stayClick = vi.fn(() => {
    document.querySelector(".greet-boss-layer")!.remove();
    document.querySelector(".greet-boss-dialog")!.remove();
  });
  const onClick = vi.fn(() => {
    const layer = document.createElement("div");
    layer.className = "greet-boss-layer";
    const dialog = document.createElement("div");
    dialog.className = "greet-boss-dialog";
    dialog.innerHTML = "<h3>已向BOSS发送消息</h3><a class='stay'>留在此页</a><a>继续沟通</a>";
    const stay = dialog.querySelector<HTMLElement>(".stay")!;
    stay.onclick = stayClick;
    stay.scrollIntoView = vi.fn();
    document.body.append(layer, dialog);
  });
  contact.onclick = onClick;
  contact.scrollIntoView = vi.fn();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => document.querySelector(".stay") ?? contact,
  });
  const adapter = new Adapter(discoveryProfile, "boss", "doc");
  const afterClick = await adapter.execute({
    id: "once", action: "CONTACT", job_key: "job-1", epoch: 1,
    binding: {}, expires: 0, resume_name: "",
  }, () => true);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(stayClick).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".greet-boss-layer")).toBeNull();
  expect(adapter.contactClickDispatched).toBe(true);
  expect(afterClick.send_ready).toBe(false);
  document.querySelector(".rec-job-list")!.append(
    document.querySelector(".job-card-wrap")!.cloneNode(true),
  );
  const duplicate = await new Adapter(discoveryProfile, "boss", "doc").snapshot();
  expect(duplicate.cards).toHaveLength(1);
  expect(duplicate.selected_key).toBe("job-1");
  const priorSignature = duplicate.list_signature;
  for (let i = 2; i <= 18; i++) {
    const item = document.querySelector(".job-card-wrap")!.cloneNode(true) as HTMLElement;
    item.classList.remove("active");
    item.querySelector<HTMLAnchorElement>(".job-name")!.href = `/job_detail/job-${i}.html`;
    document.querySelector(".rec-job-list")!.append(item);
  }
  expect((await new Adapter(discoveryProfile, "boss", "doc").snapshot()).list_signature).not.toBe(priorSignature);
  document.querySelector<HTMLElement>(".boss-info-attr")!.textContent = "乙猎头 · 猎头顾问";
  const agency = await new Adapter(discoveryProfile, "boss", "doc").snapshot();
  expect(agency.blocked).toBe("");
  expect(agency.detail).toMatchObject({ company: "甲公司", recruiter: "乙猎头 · 猎头顾问" });
  document.querySelector<HTMLElement>(".boss-info-attr")!.textContent = "乙公司 · HR";
  expect((await new Adapter(discoveryProfile, "boss", "doc").snapshot()).detail?.company).toBe("甲公司");
  document.querySelector<HTMLElement>(".boss-info-attr")!.textContent = "甲公司 · HR";
  document.querySelector<HTMLAnchorElement>(".more-job-btn")!.href = "/job_detail/other.html";
  expect((await new Adapter(discoveryProfile, "boss", "doc").snapshot()).blocked).toContain("未同步");
});
