import { expect, it } from "vitest";
import { BOSS_JOBS_URL, isConfiguredBossJobsUrl } from "../../extension/src/bossJobsUrl";

it("uses the user-specified Beijing AI product manager search URL", () => {
  expect(new URL(BOSS_JOBS_URL).searchParams.get("query")).toBe("AI产品经理");
  expect(isConfiguredBossJobsUrl(BOSS_JOBS_URL)).toBe(true);
  expect(isConfiguredBossJobsUrl(BOSS_JOBS_URL + "&page=2")).toBe(true);
});

it("rejects other cities, keywords and extra filters", () => {
  expect(isConfiguredBossJobsUrl(BOSS_JOBS_URL.replace("101010100", "101020100"))).toBe(false);
  expect(isConfiguredBossJobsUrl(BOSS_JOBS_URL.replace("query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86", "query=算法"))).toBe(false);
  expect(isConfiguredBossJobsUrl(BOSS_JOBS_URL + "&experience=104")).toBe(false);
  expect(isConfiguredBossJobsUrl(BOSS_JOBS_URL + "&query=算法")).toBe(false);
  expect(isConfiguredBossJobsUrl("https://www.zhipin.com/web/geek/jobs?city=101010100")).toBe(false);
});
