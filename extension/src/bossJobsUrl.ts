export const BOSS_JOBS_URL =
  "https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101010100&industry=&position=";

const keys = new Set(["query", "city", "industry", "position", "page", "ka"]);

function valid(url: URL): boolean {
  return url.origin === "https://www.zhipin.com" &&
    url.pathname === "/web/geek/jobs" &&
    url.searchParams.getAll("query").length === 1 &&
    !!url.searchParams.get("query")?.trim() &&
    url.searchParams.getAll("city").length === 1 &&
    url.searchParams.get("city") === "101010100" &&
    ["industry", "position"].every((key) =>
      url.searchParams.getAll(key).length <= 1 && !url.searchParams.get(key)) &&
    [...url.searchParams.keys()].every((key) => keys.has(key));
}

export function parseBossJobsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("BOSS 搜索 URL 无效"); }
  if (!valid(url))
    throw new Error("BOSS URL 必须是 zhipin.com 的北京职位搜索页，且不附加行业或职位筛选");
  return url.href;
}

export function isConfiguredBossJobsUrl(value: string | URL, configured = BOSS_JOBS_URL): boolean {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    const expected = new URL(parseBossJobsUrl(configured));
    return valid(url) && url.searchParams.get("query") === expected.searchParams.get("query");
  } catch { return false; }
}

export function bossJobsUrlWithTitle(title: string, base = BOSS_JOBS_URL): string {
  const keyword = title.trim();
  if (!keyword) throw new Error("职位标题不能为空");
  const url = new URL(parseBossJobsUrl(base));
  url.searchParams.set("query", keyword);
  return parseBossJobsUrl(url.href);
}
