import type { Profile, Snapshot, Card, Command, Detail, Chat } from "./types";
import { BOSS_JOBS_URL, isConfiguredBossJobsUrl } from "./bossJobsUrl";
declare const __ADAPTER_VERSION__: string;
const implementation =
  typeof __ADAPTER_VERSION__ === "undefined"
    ? "development"
    : __ADAPTER_VERSION__;
export function one(root: ParentNode, selector: string): HTMLElement | null {
  if (!selector) return null;
  const items = [...root.querySelectorAll<HTMLElement>(selector)].filter(
    visible,
  );
  if (items.length > 1) throw new Error(`元素不唯一：${selector}`);
  return items[0] ?? null;
}
export function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    getComputedStyle(el).visibility !== "hidden" &&
    getComputedStyle(el).display !== "none"
  );
}
function txt(root: ParentNode, selector: string): string {
  const el = selector ? one(root, selector) : null;
  return (el?.innerText ?? el?.textContent ?? "").trim();
}
function identity(root: HTMLElement, field: string): string {
  const [selector, attribute] = field.startsWith("@")
    ? ["", field.slice(1)]
    : field.split("@");
  const node = selector ? one(root, selector) : root;
  if (!node) return "";
  const value = attribute
    ? (node.getAttribute(attribute === "srcPath" ? "src" : attribute) ?? "")
    : (node.innerText ?? node.textContent ?? "");
  if (attribute === "srcPath") {
    try {
      const url = new URL(value, location.origin);
      return url.hostname === "img.bosszhipin.com" && url.pathname.includes("/upload/avatar/")
        ? url.pathname.slice(0, 200)
        : "";
    } catch {
      return "";
    }
  }
  if (attribute === "href") {
    const match = value.match(/\/job_detail\/([^/?#.]+)/);
    return match?.[1] ?? "";
  }
  return value.trim().slice(0, 200);
}
function sentAt(root: HTMLElement, selector: string, field: string): number {
  const element = one(root, selector);
  if (!element || !field) return 0;
  const value = identity(element, field);
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric
    : Date.parse(value) / 1000;
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
}
async function hash(text: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export class Adapter {
  epoch = 0;
  contactClickDispatched = false;
  constructor(
    public profile: Profile,
    public source: "boss" | "fixture",
    public documentId: string,
    public jobsUrl = BOSS_JOBS_URL,
  ) {}
  async snapshot(): Promise<Snapshot> {
    const p = this.profile;
    let blocked = "";
    let detail: Detail | null = null;
    let chat: Chat | null = null;
    const cards: Card[] = [];
    let selected = "";
    let account = "unverified";
    let listSignature = "";
    let listEnd = false;
    let loading = false;
    const searchLimited =
      this.source === "boss" && !isConfiguredBossJobsUrl(location.href, this.jobsUrl);
    try {
      listEnd = !!one(document, p.end);
      loading = !!one(document, p.loading);
      const accountNode = one(document, p.account);
      // Only the explicitly calibrated stable identity; display names can collide.
      const accountValue = accountNode
        ? identity(accountNode, p.accountKey)
        : "";
      account = accountValue
        ? (await hash(accountValue)).slice(0, 24)
        : "unverified";
      const list = one(document, p.list);
      if (!list) throw new Error("未找到岗位列表，请打开 BOSS 职位页");
      const nodes = [...list.querySelectorAll<HTMLElement>(p.card)].filter(
        visible,
      );
      for (const node of nodes.slice(-100)) {
        const key = identity(node, p.cardKey);
        if (!key) continue;
        const c = {
          key,
          title:
            txt(node, p.title) || node.textContent?.trim().slice(0, 300) || "",
          company: txt(node, p.company),
          city: txt(node, p.city),
        };
        if (!cards.some((x) => x.key === key)) cards.push(c);
      }
      listSignature = await hash(cards.map((c) => c.key).join("|"));
      const selectedKeys = new Set(
        [...list.querySelectorAll<HTMLElement>(p.selected)]
          .filter(visible)
          .map((node) => identity(node, p.cardKey))
          .filter(Boolean),
      );
      if (selectedKeys.size > 1) throw new Error("多个不同岗位同时处于选中状态");
      selected = [...selectedKeys][0] ?? "";
      const d = one(document, p.detail);
      if (d) {
        const button = one(d, p.contact);
        const text = button?.textContent?.trim() ?? "";
        const detailKey = identity(d, p.detailKey);
        const recruiter = txt(d, p.detailCompany);
        const matchingCard = cards.find((c) => c.key === detailKey);
        detail = {
          key: detailKey,
          title: txt(d, p.detailTitle),
          company: this.source === "boss" ? matchingCard?.company ?? "" : recruiter,
          city: txt(d, p.detailCity),
          description: txt(d, p.description).slice(0, 16000),
          recruiter: this.source === "boss" ? recruiter : "",
          contact_button:
            text === "立即沟通"
              ? button?.hasAttribute("disabled")
                ? "DISABLED"
                : "READY"
              : /已沟通|继续沟通/.test(text)
                ? "ALREADY_CONTACTED"
                : "MISSING",
        };
        if (!detail.key) detail = null;
      }
      const c = one(document, p.chat);
      if (c) {
        const sent = txt(c, p.sent),
          resumeSent = txt(c, p.resumeSent);
        chat = {
          contact_at: sentAt(c, p.sent, p.sentTime),
          resume_at: sentAt(c, p.resumeSent, p.resumeTime),
          key: identity(c, p.chatKey),
          conversation: identity(c, p.conversation),
          contact: sent ? "CONTACT_INITIATED" : "CHAT_OPENED",
          resume: resumeSent
            ? "SENT"
            : one(c, p.waiting)
              ? "WAITING_PEER"
              : one(c, p.resumeButton)
                ? "READY"
                : "UNAVAILABLE",
          resume_name: txt(c, p.resumeName),
          evidence: [sent, resumeSent].filter(Boolean).join("；").slice(0, 800),
        };
      }
      blocked = txt(document, p.blocked).slice(0, 300);
      if (account === "unverified")
        blocked = "无法确认登录账号：未找到稳定的个人头像标识";
      if (detail && selected && detail.key !== selected)
        blocked = "右侧详情仍未同步到选中岗位";
      if (detail && selected && detail.key === selected) {
        const card = cards.find((c) => c.key === selected);
        if (
          card &&
          (card.title !== detail.title || card.company !== detail.company ||
            (detail.city && card.city !== detail.city &&
              !(detail.city === "北京" && card.city.startsWith("北京·"))))
        ) blocked = "左右岗位标题、公司或地点不一致";
      }
      if (searchLimited)
        blocked = "当前职位页不是扩展配置的北京搜索入口，请展开下方搜索入口，点击「打开配置的 BOSS 北京搜索页」";
    } catch (e) {
      blocked = e instanceof Error ? e.message : "页面读取异常";
    }
    if (this.source === "boss" && document.visibilityState !== "visible")
      blocked = "BOSS 职位标签页不在前台，已暂停页面操作";
    return {
      source: this.source,
      account,
      session: "worker-stamps",
      tab: 0,
      document: this.documentId,
      profile: `${implementation}:${p.name}:${(await hash(JSON.stringify(p) + this.jobsUrl)).slice(0, 12)}`,
      url: location.origin + location.pathname,
      selection_epoch: this.epoch,
      phase: blocked ? "BLOCKED" : chat ? "CHAT" : "LIST",
      cards,
      detail,
      chat,
      blocked,
      list_end: listEnd,
      loading,
      list_signature: listSignature,
      selected_key: selected,
      send_ready: this.source === "fixture" && p.calibrated,
      contact_click_ready: this.source === "boss" && p.name === "boss-click-v1" &&
        !blocked && account !== "unverified" && !searchLimited,
      search_limited: searchLimited,
    };
  }
  click(el: HTMLElement | null) {
    if (
      !el ||
      !visible(el) ||
      el.hasAttribute("disabled") ||
      el.classList.contains("unable") ||
      el.getAttribute("aria-disabled") === "true"
    )
      throw new Error("目标不可操作");
    // BOSS has a fixed header. "nearest" can leave an offscreen job title
    // behind it, and smooth scrolling can make the immediate hit-test stale.
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    if (!top || !(el === top || el.contains(top)))
      throw new Error("目标被遮挡");
    el.click();
  }
  async clickSelection(el: HTMLElement | null, stillAllowed: () => boolean, timeoutMs = 1200) {
    if (!el || !visible(el) || el.getAttribute("aria-disabled") === "true")
      throw new Error("目标不可操作");
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const end = performance.now() + timeoutMs;
    let coveringElement: Element | null = null;
    do {
      if (!stillAllowed()) throw new Error("用户已接管或命令过期");
      if (!el.isConnected || !visible(el)) throw new Error("岗位卡片已消失");
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const right = Math.min(window.innerWidth, r.right);
      const top = Math.max(0, r.top);
      const bottom = Math.min(window.innerHeight, r.bottom);
      if (right > left && bottom > top) {
        for (const x of [0.5, 0.25, 0.75]) {
          for (const y of [0.5, 0.25, 0.75]) {
            const hit = document.elementFromPoint(
              left + (right - left) * x,
              top + (bottom - top) * y,
            );
            coveringElement = hit;
            if (hit && (hit === el || el.contains(hit))) {
              if (!stillAllowed()) throw new Error("用户已接管或命令过期");
              el.click();
              return;
            }
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    } while (performance.now() < end);
    const covering = coveringElement
      ? `${coveringElement.tagName.toLowerCase()}.${[...coveringElement.classList].slice(0, 2).join(".")}`.slice(0, 80)
      : "视口外或无命中元素";
    throw new Error(`目标被遮挡；滚动后仍无可点击区域（${covering}）`);
  }
  async dismissBossGreeting(stillAllowed: () => boolean) {
    if (this.source !== "boss") return;
    const layer = document.querySelector<HTMLElement>(".greet-boss-layer");
    if (!layer || !visible(layer)) return;
    // BOSS renders the dark backdrop and the confirmation dialog as siblings.
    const headings = [...document.querySelectorAll<HTMLElement>("h3")].filter(
      (node) => visible(node) && node.textContent?.trim() === "已向BOSS发送消息",
    );
    const choices = [...document.querySelectorAll<HTMLElement>("a, button")].filter(
      (node) => visible(node) && node.textContent?.trim() === "留在此页",
    );
    if (headings.length !== 1 || choices.length !== 1)
      throw new Error("沟通后弹层状态未知，需要人工核对");
    if (!stillAllowed()) throw new Error("用户已接管或命令过期");
    this.click(choices[0]);
    await this.wait(async () => {
      const current = document.querySelector<HTMLElement>(".greet-boss-layer");
      return !current || !visible(current);
    }, 1000);
  }
  async execute(
    cmd: Command,
    stillAllowed: () => boolean,
    postClickAllowed = stillAllowed,
  ): Promise<Snapshot> {
    const p = this.profile;
    const check = () => {
      if (!stillAllowed()) throw new Error("用户已接管或命令过期");
    };
    check();
    if (cmd.action === "SELECT") {
      await this.dismissBossGreeting(stillAllowed);
      check();
      const list = one(document, p.list) ?? document;
      const targets = [...list.querySelectorAll<HTMLElement>(p.card)].filter(
        (n) => visible(n) && identity(n, p.cardKey) === cmd.job_key,
      );
      if (!targets.length) throw new Error("卡片已消失");
      const names = new Set(targets.map((n) => txt(n, p.title)));
      if (names.size !== 1) throw new Error("同一岗位 ID 对应不同标题");
      this.epoch++;
      // BOSS binds list/detail selection to the job-title link, not its card.
      const target = this.source === "boss" ? one(targets[0], p.title) : targets[0];
      await this.clickSelection(target, stillAllowed);
      await this.wait(async () => {
        const s = await this.snapshot();
        return s.selected_key === cmd.job_key && s.detail?.key === cmd.job_key;
      });
    } else if (cmd.action === "SCROLL") {
      await this.dismissBossGreeting(stillAllowed);
      check();
      const list = one(document, p.list);
      if (!list)
        throw new Error("未找到可滚动的岗位列表");
      const before = await this.snapshot();
      let scrollable: HTMLElement | null = list;
      while (scrollable && scrollable !== document.body) {
        const style = getComputedStyle(scrollable);
        if (scrollable.scrollHeight > scrollable.clientHeight + 2 &&
            /(auto|scroll)/.test(style.overflowY)) break;
        scrollable = scrollable.parentElement;
      }
      if (scrollable && scrollable !== document.body) {
        scrollable.scrollBy({ top: scrollable.clientHeight * 0.85, behavior: "instant" });
      } else {
        const root = document.scrollingElement;
        if (!root || root.scrollHeight <= root.clientHeight + 2)
          throw new Error("岗位列表无法继续滚动");
        window.scrollBy({ top: window.innerHeight * 0.85, behavior: "instant" });
      }
      await this.wait(
        async () => {
          const s = await this.snapshot();
          return (
            !s.loading &&
            (s.list_signature !== before.list_signature || s.list_end)
          );
        },
        6000,
        false,
      );
    } else if (cmd.action === "CONTACT") {
      this.contactClickDispatched = false;
      const s = await this.snapshot();
      check();
      if (
        s.blocked ||
        s.selected_key !== cmd.job_key ||
        s.detail?.key !== cmd.job_key
      )
        throw new Error("岗位已变化");
      const d = one(document, p.detail);
      const target = d && one(d, p.contact);
      if (target?.textContent?.trim() !== "立即沟通")
        throw new Error("按钮状态变化");
      this.click(target);
      this.contactClickDispatched = true;
      if (this.source === "boss") {
        // The confirmation may render just after the click. Close it within
        // this command so the final job in a bounded batch is cleaned up too.
        await this.wait(async () => {
          if (!postClickAllowed()) throw new Error("沟通后清理许可已过期");
          const layer = document.querySelector<HTMLElement>(".greet-boss-layer");
          return !!layer && visible(layer);
        }, 1000, false);
        await this.dismissBossGreeting(postClickAllowed);
        return this.snapshot();
      }
      await this.wait(async () => {
        const next = await this.snapshot();
        return !!next.chat || !!next.blocked;
      }, 6000);
      // Wait for a definitive sent state; opening a composer is not proof of contact.
      await this.wait(
        async () => {
          const next = await this.snapshot();
          return next.chat?.contact === "CONTACT_INITIATED" || !!next.blocked;
        },
        2000,
        false,
      );
    } else if (cmd.action === "RESUME_SEND") {
      const s = await this.snapshot();
      check();
      if (
        s.chat?.key !== cmd.job_key ||
        s.chat.resume !== "READY" ||
        s.chat.resume_name !== cmd.resume_name
      )
        throw new Error("附件或会话不匹配");
      const c = one(document, p.chat);
      this.click(c && one(c, p.resumeButton));
      await this.wait(
        async () => (await this.snapshot()).chat?.resume === "SENT",
        6000,
      );
    } else if (cmd.action === "RESTORE") {
      const c = one(document, p.chat);
      this.click(c && one(c, p.restore));
      await this.wait(async () => (await this.snapshot()).phase === "LIST");
    }
    return this.snapshot();
  }
  async wait(predicate: () => Promise<boolean>, ms = 6000, required = true) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (required) throw new Error("等待页面状态超时");
  }
}
