import type { Profile } from "./types";
export const fixtureProfile: Profile = {
  name: "fixture-v1",
  calibrated: true,
  account: "[data-account]",
  accountKey: "@data-account",
  list: "#job-list",
  card: ".job-card",
  cardKey: "@data-key",
  title: ".title",
  company: ".company",
  city: ".city",
  selected: ".job-card.selected",
  detail: "#detail",
  detailKey: "@data-key",
  detailTitle: ".title",
  detailCompany: ".company",
  detailCity: ".city",
  description: ".description",
  contact: "button[data-contact]",
  loading: "[data-loading]",
  end: "[data-end]",
  blocked: "[data-blocked]",
  chat: "#chat",
  chatKey: "@data-key",
  conversation: "@data-conversation",
  sent: "[data-contact-sent]",
  resumeButton: "[data-resume-send]",
  resumeName: "[data-resume-name]",
  resumeSent: "[data-resume-sent]",
  sentTime: "@data-sent-at",
  resumeTime: "@data-sent-at",
  waiting: "[data-waiting]",
  restore: "[data-restore]",
};
// Observed on the logged-in BOSS jobs page. This profile permits a single
// '立即沟通' click per qualified job; chat and resume sending remain separate.
export const discoveryProfile: Profile = {
  name: "boss-click-v1",
  calibrated: false,
  account: "#header .user-nav .nav-figure > a > img",
  accountKey: "@srcPath",
  list: ".rec-job-list",
  card: ".job-card-wrap",
  cardKey: ".job-name@href",
  title: ".job-name",
  company: ".boss-name",
  city: ".company-location",
  selected: ".job-card-wrap.active",
  detail: ".job-detail-box",
  detailKey: ".more-job-btn@href",
  detailTitle: ".job-header-info .job-name",
  detailCompany: ".boss-info-attr",
  detailCity: ".job-detail-header .tag-list a[href^='/c']",
  description: ".job-detail-body p.desc",
  contact: ".job-detail-header .op-btn-chat",
  loading: "",
  end: "",
  blocked: "",
  chat: "",
  chatKey: "",
  conversation: "",
  sent: "",
  resumeButton: "",
  resumeName: "",
  resumeSent: "",
  sentTime: "",
  resumeTime: "",
  waiting: "",
  restore: "",
};
export function validateProfile(value: unknown): Profile {
  if (!value || typeof value !== "object") throw new Error("配置必须为对象");
  const p = value as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.length > 40)
    throw new Error("配置名称最长 40 字符");
  for (const key of Object.keys(discoveryProfile)) {
    if (key === "calibrated") {
      if (typeof p[key] !== "boolean")
        throw new Error("calibrated 必须为布尔值");
    } else if (typeof p[key] !== "string" || (p[key] as string).length > 500)
      throw new Error(`配置字段无效：${key}`);
  }
  if (p.calibrated)
    for (const key of [
      "account",
      "accountKey",
      "list",
      "card",
      "cardKey",
      "title",
      "selected",
      "detail",
      "detailKey",
      "detailTitle",
      "detailCity",
      "description",
      "contact",
      "chat",
      "chatKey",
      "conversation",
      "restore",
    ])
      if (!p[key]) throw new Error(`校准配置缺少 ${key}`);
  for (const [key, value] of Object.entries(p)) {
    if (
      key === "name" ||
      typeof value !== "string" ||
      !value ||
      value.startsWith("@")
    )
      continue;
    try {
      document.querySelector(value.split("@")[0]);
    } catch {
      throw new Error(`无效选择器：${key}`);
    }
  }
  return p as unknown as Profile;
}
