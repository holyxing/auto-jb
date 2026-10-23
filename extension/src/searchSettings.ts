import jobTitles from "../jobTitles.json";
import { BOSS_JOBS_URL, bossJobsUrlWithTitle, parseBossJobsUrl } from "./bossJobsUrl";
import { LIEPIN_JOBS_URL, liepinJobsUrlWithTitle, parseLiepinJobsUrl } from "./liepinJobsUrl";

export type SearchSettings = { bossUrl: string; liepinUrl: string };

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  bossUrl: BOSS_JOBS_URL,
  liepinUrl: LIEPIN_JOBS_URL,
};

// 建议职位标题来自 extension/jobTitles.json；弹窗也可直接输入任意标题。
export const BUILT_IN_JOB_TITLES: string[] = jobTitles
  .map((title) => title.trim())
  .filter((title) => title.length > 0);

export function parseSearchSettings(value: unknown): SearchSettings {
  if (value == null) return DEFAULT_SEARCH_SETTINGS;
  if (typeof value !== "object") throw new Error("搜索入口设置格式无效");
  const input = value as Record<string, unknown>;
  if (typeof input.bossUrl !== "string" || typeof input.liepinUrl !== "string")
    throw new Error("请填写两个招聘平台的搜索 URL");
  return {
    bossUrl: parseBossJobsUrl(input.bossUrl),
    liepinUrl: parseLiepinJobsUrl(input.liepinUrl),
  };
}

export function searchSettingsWithTitle(
  title: string,
  current: SearchSettings = DEFAULT_SEARCH_SETTINGS,
): SearchSettings {
  return {
    bossUrl: bossJobsUrlWithTitle(title, current.bossUrl),
    liepinUrl: liepinJobsUrlWithTitle(title, current.liepinUrl),
  };
}

export function titleFromSearchSettings(settings: SearchSettings): string {
  try {
    return new URL(settings.bossUrl).searchParams.get("query")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function matchedJobTitle(settings: SearchSettings): string {
  const title = titleFromSearchSettings(settings);
  return BUILT_IN_JOB_TITLES.find((item) => item === title) ?? "";
}

export function parseContactInterval(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120)
    throw new Error("点击间隔必须是 5–120 秒的整数");
  return seconds;
}
