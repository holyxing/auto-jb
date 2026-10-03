export const LIEPIN_JOBS_URL =
  "https://www.liepin.com/zhaopin/?city=010&dq=010&key=ai%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&workYearCode=0&currentPage=0&pageSize=40";

const keys = new Set([
  "city", "dq", "key", "workYearCode", "currentPage", "pageSize",
  "ckId", "skId", "fkId", "inputFrom", "scene",
]);

function valid(url: URL): boolean {
  return url.origin === "https://www.liepin.com" &&
    url.pathname === "/zhaopin/" &&
    url.searchParams.getAll("key").length === 1 &&
    !!url.searchParams.get("key")?.trim() &&
    url.searchParams.getAll("city").length === 1 &&
    url.searchParams.get("city") === "010" &&
    url.searchParams.getAll("dq").length === 1 &&
    url.searchParams.get("dq") === "010" &&
    url.searchParams.getAll("workYearCode").length <= 1 &&
    (url.searchParams.get("workYearCode") ?? "0") === "0" &&
    [...url.searchParams.keys()].every((key) => keys.has(key));
}

export function parseLiepinJobsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("猎聘搜索 URL 无效"); }
  if (!valid(url))
    throw new Error("猎聘 URL 必须是 liepin.com 的北京职位搜索页，且不附加经验、薪资或学历筛选");
  return url.href;
}

export function isConfiguredLiepinJobsUrl(value: string | URL, configured = LIEPIN_JOBS_URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const expected = new URL(parseLiepinJobsUrl(configured));
    return valid(url) && url.searchParams.get("key")?.trim().toLowerCase() ===
      expected.searchParams.get("key")?.trim().toLowerCase();
  } catch { return false; }
}
