import { webcrypto } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { compareBossChat, observeBossChat } from "../../extension/src/bossChat";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: webcrypto,
});
afterEach(() => document.body.replaceChildren());

it("reports the observed reply gate without treating delivered chat as a resume", async () => {
  document.body.innerHTML = `
    <div id="header"><div class="user-nav"><div class="nav-figure"><a><img src="https://img.bosszhipin.com/beijin/upload/avatar/private-avatar.webp?size=100"></a></div></div></div>
    <div class="user-list"><div class="friend-content selected" data-uid="private-conversation"></div></div>
    <div class="chat-conversation" data-uid="private-conversation">
      <div class="message-item item-myself" data-mid="private-mid"><span class="message-status status-delivery"></span></div>
    </div>
    <div class="toolbar-btn unable" aria-label="求简历：双方回复后可用">发简历</div>`;
  const probe = await observeBossChat(document);
  expect(probe.selected).toBe(true);
  expect(probe.resume).toBe("WAITING_PEER");
  expect(probe.outgoing).toHaveLength(1);
  expect(probe.outgoing[0].delivered).toBe(true);
  expect(probe.outgoing[0].id).toMatch(/^[a-f0-9]{64}$/);
  expect(probe.account).toMatch(/^[a-f0-9]{24}$/);
  expect(probe.conversation).toMatch(/^[a-f0-9]{64}$/);
  expect(probe.identity_source).toBe("data-uid");
  expect(probe.panel_bound).toBe(true);
  expect(probe.complete).toBe(true);
  expect(JSON.stringify(probe)).not.toContain("private-mid");
  expect(JSON.stringify(probe)).not.toContain("private-conversation");
  expect(JSON.stringify(probe)).not.toContain("private-avatar");
});

it("reports only a candidate new delivered message in the same stable conversation", async () => {
  document.body.innerHTML = `
    <div id="header"><div class="user-nav"><div class="nav-figure"><a><img src="https://img.bosszhipin.com/beijin/upload/avatar/private-avatar.webp"></a></div></div></div>
    <div class="user-list"><div class="friend-content selected" data-conversation-id="conversation-123"></div></div>
    <div class="chat-conversation" data-conversation-id="conversation-123"><div class="message-item item-myself" data-mid="old"><span class="message-status status-delivery"></span></div></div>
    <div class="toolbar-btn">发简历</div>`;
  const before = await observeBossChat(document);
  expect(compareBossChat(before, before).state).toBe("NO_NEW_MESSAGE");
  const added = document.createElement("div");
  added.className = "message-item item-myself";
  added.dataset.mid = "new";
  document.querySelector(".chat-conversation")!.append(added);
  expect(compareBossChat(before, await observeBossChat(document)).state).toBe("UNKNOWN");
  added.innerHTML = '<span class="message-status status-delivery"></span>';
  const after = await observeBossChat(document);
  const delta = compareBossChat(before, after);
  expect(delta.state).toBe("NEW_DELIVERED");
  expect(delta.newIds).toHaveLength(1);
  document.querySelector(".friend-content")!.setAttribute("data-conversation-id", "other-conversation");
  expect(compareBossChat(before, await observeBossChat(document)).state).toBe("UNKNOWN");
  document.querySelector(".friend-content")!.setAttribute("data-conversation-id", "conversation-123");
  document.querySelector(".chat-conversation")!.removeAttribute("data-conversation-id");
  expect(compareBossChat(before, await observeBossChat(document)).state).toBe("UNKNOWN");
});

it("does not infer a message delta from a display name or incomplete baseline", async () => {
  document.body.innerHTML = `
    <div id="header"><div class="user-nav"><div class="nav-figure"><a><img src="https://img.bosszhipin.com/beijin/upload/avatar/private-avatar.webp"></a></div></div></div>
    <div class="user-list"><div class="friend-content selected">张招聘</div></div>
    <div class="chat-conversation"><div class="message-item item-myself" data-mid="old"></div></div>`;
  const before = await observeBossChat(document);
  expect(before.conversation).toBe("");
  expect(compareBossChat(before, before).state).toBe("UNKNOWN");
  document.querySelector(".friend-content")!.setAttribute("data-uid", "conversation-123");
  const identified = await observeBossChat(document);
  expect(compareBossChat({ ...identified, complete: false }, identified).state).toBe("UNKNOWN");
});

it("rejects truncated message histories even if a new delivered ID appears", async () => {
  document.body.innerHTML = `
    <div id="header"><div class="user-nav"><div class="nav-figure"><a><img src="https://img.bosszhipin.com/beijin/upload/avatar/private-avatar.webp"></a></div></div></div>
    <div class="user-list"><div class="friend-content selected" data-uid="conversation-123"></div></div>
    <div class="chat-conversation" data-uid="conversation-123"></div>`;
  const panel = document.querySelector(".chat-conversation")!;
  for (let index = 0; index <= 100; index++) {
    const item = document.createElement("div");
    item.className = "message-item item-myself";
    item.dataset.mid = `message-${index}`;
    item.innerHTML = '<span class="message-status status-delivery"></span>';
    panel.append(item);
  }
  const before = await observeBossChat(document);
  expect(before.complete).toBe(false);
  expect(before.outgoing).toHaveLength(100);
  expect(compareBossChat(before, before).state).toBe("UNKNOWN");
});

it("uses an observed unique recruiter/company/title card only as a read-only identity candidate", async () => {
  document.body.innerHTML = `
    <div id="header"><div class="user-nav"><div class="nav-figure"><a><img src="https://img.bosszhipin.com/beijin/upload/avatar/private-avatar.webp"></a></div></div></div>
    <div class="user-list">
      <div class="friend-content selected"><div class="title-box"><span class="name-box"><span class="name-text">招聘人甲</span><span>甲公司</span><i></i><span>产品招聘</span></span></div></div>
      <div class="friend-content"><div class="title-box"><span class="name-box"><span class="name-text">招聘人乙</span><span>乙公司</span><i></i><span>产品招聘</span></span></div></div>
    </div>
    <div class="chat-conversation"><div class="base-info"><div class="name-content"><span class="name-text">招聘人甲</span></div><span>甲公司</span><i></i><span class="base-title">产品招聘</span></div><div class="message-item item-myself" data-mid="message-1"><span class="message-status status-delivery"></span></div></div>
    <div class="toolbar-btn unable" aria-label="求简历：双方回复后可用">发简历</div>`;
  const before = await observeBossChat(document);
  expect(before.identity_source).toBe("display-triple");
  expect(before.panel_bound).toBe(true);
  expect(before.conversation).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(before)).not.toContain("招聘人甲");
  const duplicate = document.querySelector(".friend-content.selected")!.cloneNode(true) as HTMLElement;
  duplicate.classList.remove("selected");
  document.querySelector(".user-list")!.append(duplicate);
  expect((await observeBossChat(document)).conversation).toBe("");
  duplicate.remove();
  document.querySelector(".base-info .base-title")!.textContent = "算法招聘";
  expect((await observeBossChat(document)).conversation).toBe("");
});

it("only reports a ready entrance for one selected conversation and one enabled control", async () => {
  document.body.innerHTML = `
    <div class="user-list"><div class="friend-content selected"></div></div>
    <div class="toolbar-btn">发简历</div>`;
  expect((await observeBossChat(document)).resume).toBe("READY");
  document
    .querySelector(".user-list")!
    .append(document.querySelector(".friend-content")!.cloneNode(true));
  expect((await observeBossChat(document)).selected).toBe(false);
});
