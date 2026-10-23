export const LIEPIN_JOBS_URL =
  "https://www.liepin.com/zhaopin/?city=010&dq=010&key=ai%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&workYearCode=0&currentPage=0&pageSize=40";

// currentPage 只表示第几页，不要求和扩展里保存的页码相同。
const structural = new Set(["city", "dq", "key", "workYearCode", "currentPage", "pageSize"]);

function tracking(key: string): boolean {
  // 翻页时猎聘会改写 ckId、suggestId 等追踪参数，这些不改变城市或筛选。
  return /^(ckId|skId|fkId|inputFrom|scene|sfrom|headId|searchId|init|from)$/i.test(key) ||
    /Id$/i.test(key) || /^sugg/i.test(key);
}

function valid(url: URL): boolean {
  if (url.origin !== "https://www.liepin.com" || url.pathname !== "/zhaopin/") return false;
  if (url.searchParams.getAll("key").length !== 1 || !url.searchParams.get("key")?.trim()) return false;
  if (url.searchParams.getAll("city").length !== 1 || url.searchParams.get("city") !== "010") return false;
  if (url.searchParams.getAll("dq").length !== 1 || url.searchParams.get("dq") !== "010") return false;
  if (url.searchParams.getAll("workYearCode").length > 1) return false;
  if ((url.searchParams.get("workYearCode") ?? "0") !== "0") return false;
  for (const [key, value] of url.searchParams) {
    if (!value.trim() || structural.has(key) || tracking(key)) continue;
    return false;
  }
  return true;
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

export function liepinJobsUrlWithTitle(title: string, base = LIEPIN_JOBS_URL): string {
  const keyword = title.trim();
  if (!keyword) throw new Error("职位标题不能为空");
  const url = new URL(parseLiepinJobsUrl(base));
  url.searchParams.set("key", keyword);
  url.searchParams.set("currentPage", "0");
  return parseLiepinJobsUrl(url.href);
}
