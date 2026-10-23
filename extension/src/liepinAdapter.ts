import type { Card, Command, Detail, Snapshot } from "./types";
import { isConfiguredLiepinJobsUrl, LIEPIN_JOBS_URL } from "./liepinJobsUrl";

export const liepinProfile = { name: "liepin-click-v2" };

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
    style.visibility !== "hidden";
}

function jobKey(link: HTMLAnchorElement): string {
  try {
    const url = new URL(link.getAttribute("href") ?? "", location.origin);
    if (url.origin !== "https://www.liepin.com") return "";
    const match = url.pathname.match(/^\/(a|job)\/(\d+)\.shtml$/);
    return match ? `${match[1]}:${match[2]}` : "";
  } catch {
    return "";
  }
}

function jobLinks(root: ParentNode): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(
    (link) => visible(link) && !!jobKey(link),
  );
}

function rowFor(link: HTMLAnchorElement): HTMLElement | null {
  let node = link.parentElement;
  let row: HTMLElement | null = null;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    if (jobLinks(node).length !== 1 || (node.textContent?.length ?? 0) > 4000) break;
    row = node;
  }
  return row;
}

function listContact(row: HTMLElement): Detail["contact_button"] {
  const contacted = [...row.querySelectorAll<HTMLElement>("button,a,[role='button'],span,div")]
    .filter((element) => {
      const label = element.textContent?.trim();
      return (label === "继续聊" || label === "已沟通") && visible(element);
    });
  const leaves = contacted.filter((element) =>
    !contacted.some((other) => other !== element && element.contains(other))
  );
  return leaves.length === 1 ? "ALREADY_CONTACTED" : "READY";
}

async function fingerprint(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function accountEvidence(): string {
  const greeting = [...document.querySelectorAll<HTMLElement>("header *,nav *,[class*='header'] *")]
    .find((element) => /^你好[，,、]?\s*\S+/.test(element.textContent?.trim() ?? "") &&
      (element.textContent?.trim().length ?? 0) < 35);
  if (!greeting) return "";
  const group = greeting.closest("li,div")?.parentElement;
  const avatars = [...(group?.querySelectorAll<HTMLImageElement>("img[src]") ?? [])]
    .filter((image) => visible(image) && !image.src.startsWith("data:"));
  if (avatars.length !== 1) return "";
  return `${greeting.textContent?.trim()}|${avatars[0].currentSrc || avatars[0].src}`;
}

function cardFor(link: HTMLAnchorElement, row: HTMLElement): Card {
  const label = (link.innerText ?? link.textContent ?? "").trim().replace(/\s+/g, " ");
  const city = label.match(/【\s*([^】]+)\s*】/)?.[1].trim() ?? "";
  const title = label.split("【")[0].trim().slice(0, 300);
  const company = [...row.querySelectorAll<HTMLElement>("[class*='company']")]
    .map((element) => element.textContent?.trim() ?? "")
    .find((value) => value && value.length < 200) ?? "";
  return { key: jobKey(link), title, city, company };
}

function pageNumbers(): { page: number; target: HTMLElement; active: boolean }[] {
  const root = document.querySelector(".list-pagination-box, .ant-pagination, [class*='pagination']");
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>("a,button,[role='button']")].flatMap((target) => {
    const text = target.textContent?.trim() ?? "";
    if (!/^\d+$/.test(text) || !visible(target)) return [];
    const item = target.closest("li") ?? target;
    const active = target.getAttribute("aria-current") === "page" ||
      item.getAttribute("aria-current") === "page" ||
      /\bactive\b/i.test(target.className) || /\bactive\b/i.test(item.className);
    const disabled = target.hasAttribute("disabled") || item.hasAttribute("disabled") ||
      target.getAttribute("aria-disabled") === "true" || item.getAttribute("aria-disabled") === "true";
    return disabled ? [] : [{ page: Number(text), target, active }];
  });
}

function nextPageButton(): HTMLElement | null {
  const pages = pageNumbers();
  const current = pages.filter((item) => item.active);
  if (current.length !== 1) return null;
  const next = pages.filter((item) => item.page === current[0].page + 1);
  return next.length === 1 ? next[0].target : null;
}

function communicationPanel(): { present: boolean; close: HTMLElement | null } {
  // 页头导航里的「我的沟通」不是已打开的沟通窗，不能因此停住整页。
  const titles = [...document.querySelectorAll<HTMLElement>("div,span,p,h2,h3")]
    .filter((element) => visible(element) && element.textContent?.trim() === "我的沟通" &&
      !element.closest("header, nav") &&
      ![...element.children].some((child) => child.textContent?.trim() === "我的沟通"));
  for (const title of titles) {
    let node: HTMLElement | null = title;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.closest("header, nav") || jobLinks(node).length) break;
      const controls = [...node.querySelectorAll<HTMLElement>(
        "button,[role='button'],img[alt],svg[aria-label]",
      )].filter((element) => visible(element) &&
        /^(close|关闭)$/i.test(element.getAttribute("aria-label")?.trim() ||
          element.getAttribute("title")?.trim() || element.getAttribute("alt")?.trim() ||
          element.textContent?.trim() || ""));
      const outermost = controls.filter((element) =>
        !controls.some((other) => other !== element && other.contains(element)));
      if (outermost.length === 1) return { present: true, close: outermost[0] };
    }
  }
  return { present: false, close: null };
}

export class LiepinAdapter {
  profile = liepinProfile;
  epoch = 0;
  selectedKey = "";
  contactClickDispatched = false;
  contactEffectObserved = false;
  pointerAnchor: HTMLElement | null = null;
  automatedPointerTarget: HTMLElement | null = null;
  automatedPointerPoint: readonly [number, number] | null = null;
  automatedPointerUntil = 0;
  constructor(public documentId: string, public jobsUrl = LIEPIN_JOBS_URL) {}

  private rows(): { card: Card; row: HTMLElement }[] {
    const rows: { card: Card; row: HTMLElement }[] = [];
    for (const link of jobLinks(document).slice(0, 100)) {
      const row = rowFor(link);
      const key = jobKey(link);
      if (!row || rows.some((item) => item.card.key === key)) continue;
      rows.push({ card: cardFor(link, row), row });
    }
    return rows;
  }

  async snapshot(): Promise<Snapshot> {
    const searchLimited = !isConfiguredLiepinJobsUrl(location.href, this.jobsUrl);
    let blocked = "";
    const evidence = accountEvidence();
    const account = evidence ? (await fingerprint(evidence)).slice(0, 24) : "unverified";
    const rows = this.rows();
    const selected = rows.find((item) => item.card.key === this.selectedKey);
    const state = selected ? listContact(selected.row) : "MISSING";
    const detail: Detail | null = selected ? {
      ...selected.card,
      description: "",
      recruiter: "",
      contact_button: state,
    } : null;
    if (searchLimited) blocked = "请打开已配置的猎聘北京搜索页";
    else if (account === "unverified") blocked = "无法确认猎聘登录账号的稳定头像标识";
    else if (!rows.length) blocked = "未找到猎聘岗位列表";
    else if (this.selectedKey && !selected) blocked = "待选岗位已从猎聘列表消失";
    if (communicationPanel().present) blocked = "猎聘沟通面板仍打开，需关闭后继续";
    if (document.visibilityState !== "visible") blocked = "猎聘职位页不在前台，已暂停页面操作";
    const next = nextPageButton();
    return {
      source: "liepin", account, session: "worker-stamps", tab: 0,
      document: this.documentId, profile: `liepin:${this.profile.name}:${(await fingerprint(this.jobsUrl)).slice(0, 12)}`,
      url: location.origin + location.pathname, selection_epoch: this.epoch,
      phase: blocked ? "BLOCKED" : "LIST",
      cards: rows.map((item) => item.card), detail, chat: null, blocked,
      list_end: pageNumbers().filter((item) => item.active).length === 1 && !next,
      loading: !rows.length,
      list_signature: await fingerprint(rows.map((item) => item.card.key).join("|")),
      selected_key: selected?.card.key ?? "", send_ready: false,
      contact_click_ready: !blocked && !searchLimited && account !== "unverified",
      search_limited: searchLimited,
    };
  }

  private click(target: HTMLElement): void {
    if (!visible(target)) throw new Error("目标不可操作");
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    const points = [0.5, 0.25, 0.75].flatMap((fractionY) =>
      [0.5, 0.25, 0.75].map((fractionX) => [
        rect.x + rect.width * fractionX,
        rect.y + rect.height * fractionY,
      ] as const));
    if (!points.some(([x, y]) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (target === top || target.contains(top));
    })) throw new Error("目标被遮挡");
    target.click();
  }

  freshPointerPoint(): { x: number; y: number } | null {
    const target = this.pointerAnchor;
    if (!target) return null;
    const point = this.hitPoint(target);
    if (!point) return null;
    this.automatedPointerTarget = target;
    this.automatedPointerPoint = point;
    this.automatedPointerUntil = performance.now() + 8000;
    return { x: point[0], y: point[1] };
  }

  private hitPoint(target: HTMLElement): readonly [number, number] | null {
    if (!visible(target)) throw new Error("职位标题不可见");
    const rect = target.getBoundingClientRect();
    const points = [0.5, 0.25, 0.75].flatMap((fractionY) =>
      [0.5, 0.25, 0.75].map((fractionX) => [
        rect.x + rect.width * fractionX,
        rect.y + rect.height * fractionY,
      ] as const));
    return points.find(([x, y]) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (target === top || target.contains(top));
    }) ?? null;
  }

  private titleLink(row: HTMLElement, key: string): HTMLAnchorElement {
    const link = jobLinks(row).find((item) => jobKey(item) === key);
    if (!link) throw new Error("猎聘职位标题已消失");
    return link;
  }

  async execute(cmd: Command, stillAllowed: () => boolean, postClickAllowed = stillAllowed): Promise<Snapshot> {
    if (!stillAllowed()) throw new Error("用户已接管或命令过期");
    if (cmd.action === "SELECT") {
      const item = this.rows().find((row) => row.card.key === cmd.job_key);
      if (!item) throw new Error("猎聘岗位卡片已消失");
      const link = this.titleLink(item.row, cmd.job_key);
      link.scrollIntoView({ block: "center", behavior: "instant" });
      if (!this.hitPoint(link)) throw new Error("猎聘职位标题不可见或被遮挡");
      if (!stillAllowed()) throw new Error("用户已接管或命令过期");
      this.selectedKey = cmd.job_key;
      this.epoch++;
      return this.snapshot();
    }
    if (cmd.action === "SCROLL") {
      const before = (await this.snapshot()).list_signature;
      const next = nextPageButton();
      if (!next) throw new Error("猎聘下一页数字不可识别");
      this.click(next);
      this.selectedKey = "";
      this.epoch++;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (!stillAllowed()) throw new Error("用户已接管或命令过期");
        const current = await this.snapshot();
        if (current.list_signature !== before && current.cards.length) return current;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("猎聘翻页后列表未更新");
    }
    if (cmd.action === "CONTACT") {
      const item = this.rows().find((row) => row.card.key === cmd.job_key);
      const snap = await this.snapshot();
      if (!item || snap.blocked || snap.selected_key !== cmd.job_key)
        throw new Error("猎聘岗位或按钮状态变化");
      if (snap.detail?.contact_button === "ALREADY_CONTACTED") return snap;
      if (snap.detail?.contact_button !== "READY") throw new Error("猎聘岗位或按钮状态变化");
      const link = this.titleLink(item.row, cmd.job_key);
      link.scrollIntoView({ block: "center", behavior: "instant" });
      const point = this.hitPoint(link);
      if (!point) throw new Error("猎聘职位标题被遮挡");
      if (!stillAllowed()) throw new Error("用户已接管或命令过期");
      const path = new URL(link.href).pathname;
      this.pointerAnchor = link;
      this.automatedPointerTarget = link;
      this.automatedPointerPoint = point;
      this.automatedPointerUntil = performance.now() + 8000;
      let result: {
        ok?: boolean;
        error?: string;
        value?: { clicked?: boolean; effect?: boolean; already?: boolean; unavailable?: boolean; closed?: boolean };
      } | undefined;
      try {
        result = await chrome.runtime.sendMessage({
          type: "clickLiepinDetail", x: point[0], y: point[1], path,
        });
      } catch {
        this.contactClickDispatched = true;
        throw new Error("猎聘明细页点击未收到回执");
      } finally {
        this.pointerAnchor = null;
        this.automatedPointerTarget = null;
        this.automatedPointerPoint = null;
        this.automatedPointerUntil = 0;
      }
      if (result?.value?.clicked) this.contactClickDispatched = true;
      if (!result?.ok) throw new Error(result?.error ?? "猎聘明细页点击失败");
      const value = result.value ?? {};
      // 没有点击聊一聊。职位下线或已沟通都继续下一岗，不因明细页打开较慢而暂停。
      if (!value.clicked && (value.unavailable || value.already)) {
        if (value.closed === false) throw new Error("猎聘明细页未能关闭");
        const current = await this.snapshot();
        if (current.detail)
          current.detail.contact_button = value.unavailable ? "MISSING" : "ALREADY_CONTACTED";
        return current;
      }
      if (!postClickAllowed()) throw new Error("点击前页面已由用户接管");
      if (!value.clicked) throw new Error(result.error ?? "明细页未点击聊一聊");
      if (!value.effect) throw new Error("真实点击后未观察到猎聘会话或已沟通状态");
      if (value.closed === false) throw new Error("猎聘明细页未能关闭");
      this.contactEffectObserved = true;
      return this.snapshot();
    }
    throw new Error("猎聘页面不支持该动作");
  }
}
