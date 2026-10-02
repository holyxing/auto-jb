export type BossChatProbe = {
  selected: boolean;
  account: string;
  conversation: string;
  identity_source: string;
  panel_bound: boolean;
  complete: boolean;
  outgoing: { id: string; delivered: boolean }[];
  resume: "READY" | "WAITING_PEER" | "UNAVAILABLE";
  reason: string;
};

export type ChatDelta = {
  state: "NEW_DELIVERED" | "NO_NEW_MESSAGE" | "UNKNOWN";
  newIds: string[];
  reason: string;
};

const MAX_OUTGOING = 100;

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function accountIdentity(root: Document): Promise<string> {
  const avatar = root.querySelector<HTMLImageElement>(
    "#header .user-nav .nav-figure > a > img",
  );
  const src = avatar?.getAttribute("src") ?? "";
  try {
    const url = new URL(src, root.location?.origin ?? "https://www.zhipin.com");
    if (url.hostname !== "img.bosszhipin.com" ||
        !url.pathname.includes("/upload/avatar/")) return "unverified";
    return (await fingerprint(url.pathname.slice(0, 200))).slice(0, 24);
  } catch {
    return "unverified";
  }
}

async function conversationIdentity(selected: HTMLElement): Promise<{
  value: string;
  source: string;
}> {
  const names = ["data-conversation-id", "data-chat-id", "data-encrypt-id", "data-uid"];
  const candidates: { value: string; source: string }[] = [];
  let node: HTMLElement | null = selected;
  for (let depth = 0; depth < 3 && node && !node.classList.contains("user-list"); depth++) {
    for (const name of names) {
      const value = node.getAttribute(name)?.trim() ?? "";
      if (value && value.length <= 200) candidates.push({ value, source: name });
    }
    node = node.parentElement;
  }
  const unique = new Set(candidates.map(({ value }) => value));
  if (unique.size !== 1) return { value: "", source: "" };
  return {
    value: await fingerprint(`boss-conversation:${candidates[0].value}`),
    source: candidates[0].source,
  };
}

function displayParts(item: Element | null, selectors: [string, string, string]): string[] {
  return selectors.map((selector) =>
    (item?.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

async function displayConversationIdentity(
  root: Document,
  selected: Element,
  panel: Element | null,
): Promise<string> {
  const selectedParts = displayParts(selected, [
    ".title-box .name-text",
    ".title-box .name-box > span:nth-child(2)",
    ".title-box .name-box > span:nth-child(4)",
  ]);
  const panelParts = displayParts(panel, [
    ".base-info .name-text",
    ".base-info > span:nth-child(2)",
    ".base-info .base-title",
  ]);
  if (!selectedParts.every((value) => value && value.length <= 100) ||
      selectedParts.some((value, index) => value !== panelParts[index])) return "";
  const duplicateCount = [
    ...root.querySelectorAll(".user-list .friend-content"),
  ].filter((item) => {
    const parts = displayParts(item, [
      ".title-box .name-text",
      ".title-box .name-box > span:nth-child(2)",
      ".title-box .name-box > span:nth-child(4)",
    ]);
    return parts.every((value, index) => value === selectedParts[index]);
  }).length;
  if (duplicateCount !== 1) return "";
  return fingerprint(`boss-display-conversation:${JSON.stringify(selectedParts)}`);
}

// This is a candidate delta only. A CONTACT command must additionally bind the
// conversation to its job and prove that no user action intervened.
export function compareBossChat(before: BossChatProbe, after: BossChatProbe): ChatDelta {
  if (!before.selected || !after.selected ||
      before.account === "unverified" || before.account !== after.account ||
      !before.conversation || before.conversation !== after.conversation ||
      !before.panel_bound || !after.panel_bound ||
      !before.complete || !after.complete) {
    return { state: "UNKNOWN", newIds: [], reason: "账号、会话身份或消息基线不完整" };
  }
  const baseline = new Set(before.outgoing.map((item) => item.id));
  const added = after.outgoing.filter((item) => !baseline.has(item.id));
  if (!added.length) return { state: "NO_NEW_MESSAGE", newIds: [], reason: "未观察到新己方消息" };
  if (added.some((item) => !item.delivered))
    return { state: "UNKNOWN", newIds: [], reason: "新增消息尚无送达证据" };
  return { state: "NEW_DELIVERED", newIds: added.map((item) => item.id), reason: "" };
}

export async function observeBossChat(root: Document): Promise<BossChatProbe> {
  const selected = root.querySelectorAll(".user-list .friend-content.selected");
  if (selected.length !== 1)
    return {
      selected: false,
      account: await accountIdentity(root),
      conversation: "",
      identity_source: "",
      panel_bound: false,
      complete: false,
      outgoing: [],
      resume: "UNAVAILABLE",
      reason: "未选中唯一会话",
    };

  const account = await accountIdentity(root);
  const identity = await conversationIdentity(selected[0] as HTMLElement);
  const panels = root.querySelectorAll<HTMLElement>(".chat-conversation");
  const panel = panels.length === 1 ? panels[0] : null;
  const panelIdentity = panel ? await conversationIdentity(panel) : { value: "", source: "" };
  const displayIdentity = await displayConversationIdentity(root, selected[0], panel);
  const conversation = identity.value || displayIdentity;
  const identitySource = identity.value ? identity.source : displayIdentity ? "display-triple" : "";
  const panelBound = !!conversation &&
    (identity.value === panelIdentity.value || !!displayIdentity);
  const messageNodes = panel
    ? [...panel.querySelectorAll<HTMLElement>(".message-item.item-myself[data-mid]")]
      .filter((item) => !!item.dataset.mid?.trim())
    : [];

  const outgoing = await Promise.all(
    messageNodes
      .slice(-MAX_OUTGOING)
      .map(async (item) => ({
        id: await fingerprint(`boss-message:${item.dataset.mid}`),
        delivered: !!item.querySelector(".message-status.status-delivery"),
      })),
  );
  const base = {
    selected: true,
    account,
    conversation,
    identity_source: identitySource,
    panel_bound: panelBound,
    complete: !!panel && messageNodes.length <= MAX_OUTGOING &&
      new Set(outgoing.map((item) => item.id)).size === outgoing.length,
    outgoing,
  };
  const buttons = [
    ...root.querySelectorAll<HTMLElement>(".toolbar-btn"),
  ].filter((item) => item.textContent?.trim() === "发简历");
  if (buttons.length !== 1)
    return {
      ...base,
      resume: "UNAVAILABLE",
      reason: !conversation ? "无法匹配唯一会话名片" : !panelBound ? "消息区未绑定选中会话" : "未找到唯一简历入口",
    };
  const button = buttons[0];
  const unavailable =
    button.classList.contains("unable") ||
    button.hasAttribute("disabled") ||
    button.getAttribute("aria-disabled") === "true";
  const reason = (button.getAttribute("aria-label") ?? "").slice(0, 100);
  return {
    ...base,
    resume: unavailable
      ? reason.includes("双方回复")
        ? "WAITING_PEER"
        : "UNAVAILABLE"
      : "READY",
    reason: !conversation ? "无法匹配唯一会话名片" : !panelBound ? "消息区未绑定选中会话" : unavailable ? reason || "简历入口不可用" : "",
  };
}
