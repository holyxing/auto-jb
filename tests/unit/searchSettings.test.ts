import { expect, it } from "vitest";
import { DEFAULT_SEARCH_SETTINGS, parseContactInterval, parseSearchSettings } from "../../extension/src/searchSettings";

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
