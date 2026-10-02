export const LIEPIN_JOBS_URL =
  "https://www.liepin.com/zhaopin/?city=010&dq=010&key=ai%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&workYearCode=0&currentPage=0&pageSize=40";

export function isConfiguredLiepinJobsUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.origin === "https://www.liepin.com" &&
      url.pathname === "/zhaopin/" &&
      url.searchParams.get("key")?.trim().toLowerCase() === "ai产品经理" &&
      url.searchParams.get("city") === "010" &&
      url.searchParams.get("dq") === "010" &&
      (url.searchParams.get("workYearCode") ?? "0") === "0" &&
      ![...url.searchParams.keys()].some((key) =>
        key.startsWith("_security") || key === "verify" || key === "captcha"
      );
  } catch {
    return false;
  }
}
