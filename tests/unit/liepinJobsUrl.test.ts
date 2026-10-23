import { expect, it } from "vitest";
import { isConfiguredLiepinJobsUrl, LIEPIN_JOBS_URL, parseLiepinJobsUrl } from "../../extension/src/liepinJobsUrl";

it("requires the AI product search and Beijing filter, not volatile tracking IDs", () => {
  expect(isConfiguredLiepinJobsUrl(LIEPIN_JOBS_URL)).toBe(true);
  expect(isConfiguredLiepinJobsUrl(`${LIEPIN_JOBS_URL}&ckId=changed&currentPage=2`)).toBe(true);
  expect(isConfiguredLiepinJobsUrl("https://www.liepin.com/zhaopin/?key=ai产品经理")).toBe(false);
  expect(isConfiguredLiepinJobsUrl("https://www.liepin.com/zhaopin/?city=010&dq=010&key=销售经理")).toBe(false);
  expect(isConfiguredLiepinJobsUrl(`${LIEPIN_JOBS_URL}&_security_check=1`)).toBe(false);
  expect(isConfiguredLiepinJobsUrl(
    "https://www.liepin.com/zhaopin/?city=010&dq=010&pubTime=&currentPage=1&pageSize=40&key=ai产品经理&suggestId=trace",
  )).toBe(true);
  expect(isConfiguredLiepinJobsUrl(`${LIEPIN_JOBS_URL}&pubTime=1`)).toBe(false);
  expect(isConfiguredLiepinJobsUrl(`${LIEPIN_JOBS_URL}&industry=internet`)).toBe(false);
});

it("accepts a configured Beijing keyword and rejects filters or foreign hosts", () => {
  const configured = LIEPIN_JOBS_URL.replace("ai%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86", "AI%20Agent%E4%BA%A7%E5%93%81");
  expect(parseLiepinJobsUrl(configured)).toBe(configured);
  expect(isConfiguredLiepinJobsUrl(configured + "&ckId=rotated", configured)).toBe(true);
  expect(isConfiguredLiepinJobsUrl(LIEPIN_JOBS_URL, configured)).toBe(false);
  expect(() => parseLiepinJobsUrl(configured.replace("city=010", "city=020"))).toThrow();
  expect(() => parseLiepinJobsUrl(configured + "&salaryCode=50")).toThrow();
  expect(() => parseLiepinJobsUrl(configured.replace("www.liepin.com", "evil.example"))).toThrow();
});
