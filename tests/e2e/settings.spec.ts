import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

test("popup saves Beijing keywords and interval, rejects another city", async () => {
  const profile = mkdtempSync(path.resolve(".runtime/settings-e2e-"));
  const extension = path.resolve("dist/extension");
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.locator("#automation-settings summary").click();
    await popup.locator("#boss-search-url").fill(
      "https://www.zhipin.com/web/geek/jobs?query=AI%20Agent%E4%BA%A7%E5%93%81&city=101010100&industry=&position=",
    );
    await popup.locator("#liepin-search-url").fill(
      "https://www.liepin.com/zhaopin/?city=020&dq=010&key=AI%E4%BA%A7%E5%93%81&workYearCode=0",
    );
    await popup.locator("#contact-interval").fill("11");
    await popup.locator("#save-search-settings").click();
    await expect(popup.locator("#error")).toContainText("北京职位搜索页");
    expect(await popup.evaluate(() => chrome.storage.local.get("searchSettings")))
      .not.toHaveProperty("searchSettings");

    await popup.locator("#liepin-search-url").fill(
      "https://www.liepin.com/zhaopin/?city=010&dq=010&key=AI%E4%BA%A7%E5%93%81&workYearCode=0",
    );
    await popup.locator("#save-search-settings").click();
    await expect(popup.locator("#settings-status")).toContainText("11 秒");
    const stored = await popup.evaluate(() => chrome.storage.local.get(["searchSettings", "taskOptions"]));
    expect(stored.searchSettings.bossUrl).toContain("AI%20Agent");
    expect(stored.searchSettings.liepinUrl).toContain("city=010&dq=010");
    expect(stored.taskOptions.contactIntervalSeconds).toBe("11");
    await popup.reload();
    await popup.locator("#automation-settings summary").click();
    await expect(popup.locator("#contact-interval")).toHaveValue("11");
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
