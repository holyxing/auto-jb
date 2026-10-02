// The user-selected BOSS entry point. Keep it in one place so popup navigation
// and page validation cannot silently disagree about the search scope.
export const BOSS_JOBS_URL =
  "https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101010100&industry=&position=";

export function isConfiguredBossJobsUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    return false;
  }
  if (url.origin !== "https://www.zhipin.com" ||
      url.pathname !== "/web/geek/jobs" ||
      ["query", "city"].some((key) => url.searchParams.getAll(key).length !== 1) ||
      ["industry", "position"].some((key) => url.searchParams.getAll(key).length > 1) ||
      url.searchParams.get("query") !== "AI产品经理" ||
      url.searchParams.get("city") !== "101010100" ||
      (url.searchParams.get("industry") ?? "") !== "" ||
      (url.searchParams.get("position") ?? "") !== "") return false;
  return [...url.searchParams.keys()].every((key) =>
    ["query", "city", "industry", "position", "page", "ka"].includes(key),
  );
}
