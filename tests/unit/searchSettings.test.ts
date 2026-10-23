import { expect, it } from "vitest";
import {
  BUILT_IN_JOB_TITLES,
  DEFAULT_SEARCH_SETTINGS,
  matchedJobTitle,
  parseContactInterval,
  parseSearchSettings,
  searchSettingsWithTitle,
} from "../../extension/src/searchSettings";

it("defaults to the two Beijing searches", () => {
  expect(parseSearchSettings(null)).toEqual(DEFAULT_SEARCH_SETTINGS);
});

it("validates both configured URLs as a unit", () => {
  expect(parseSearchSettings(DEFAULT_SEARCH_SETTINGS)).toEqual(DEFAULT_SEARCH_SETTINGS);
  expect(() => parseSearchSettings({ ...DEFAULT_SEARCH_SETTINGS, liepinUrl: "https://evil.example/" })).toThrow();
});

it("requires an integer interval from 5 to 120 seconds", () => {
  expect(parseContactInterval("5")).toBe(5);
  expect(parseContactInterval("120")).toBe(120);
  for (const value of ["4", "121", "7.5", "oops"]) expect(() => parseContactInterval(value)).toThrow();
});

it("loads suggested titles from the config file and rewrites both search URLs for any title", () => {
  expect(BUILT_IN_JOB_TITLES).toEqual(["AI产品经理", "AI解决方案专家", "AI交付经理"]);
  const next = searchSettingsWithTitle("AI解决方案专家");
  expect(new URL(next.bossUrl).searchParams.get("query")).toBe("AI解决方案专家");
  expect(new URL(next.liepinUrl).searchParams.get("key")).toBe("AI解决方案专家");
  expect(matchedJobTitle(next)).toBe("AI解决方案专家");
  expect(matchedJobTitle(DEFAULT_SEARCH_SETTINGS)).toBe("AI产品经理");
  const custom = searchSettingsWithTitle("产品经理");
  expect(new URL(custom.bossUrl).searchParams.get("query")).toBe("产品经理");
  expect(new URL(custom.liepinUrl).searchParams.get("key")).toBe("产品经理");
  expect(matchedJobTitle(custom)).toBe("");
});
