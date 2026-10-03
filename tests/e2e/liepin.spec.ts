import { test, expect, chromium } from "@playwright/test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const base = "http://127.0.0.1:17830";
const admin = readFileSync(".env", "utf8").match(/^AUTOJB_ADMIN_TOKEN=(.+)$/m)![1].trim();
const liepinUrl = "https://www.liepin.com/zhaopin/?city=010&dq=010&key=AI产品&workYearCode=0";

test("Liepin fixture: open detail, click chat, close detail, skip contacted and out-of-city", async () => {
  const profile = mkdtempSync(path.resolve(".runtime/liepin-e2e-"));
  const extension = path.resolve("dist/extension");
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium", viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const headers = { Authorization: `Bearer ${admin}` };
    const code = await (await context.request.post(`${base}/api/pair-code`, { headers })).json();
    const paired = await (await context.request.post(`${base}/api/pair`, {
      data: { code: code.code, name: "Liepin local fixture" },
    })).json();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.evaluate((token) => chrome.storage.local.set({
      deviceToken: token,
      searchSettings: {
        bossUrl: "https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101010100&industry=&position=",
        liepinUrl: "https://www.liepin.com/zhaopin/?city=010&dq=010&key=AI%E4%BA%A7%E5%93%81&workYearCode=0",
      },
    }), paired.token);
    await popup.close();
    const jobId = String(Date.now());
    const account = createHash("sha256")
      .update(`你好，样本用户|https://www.liepin.com/avatar/test-account-${jobId}.png`)
      .digest("hex").slice(0, 24);
    const html = readFileSync("fixtures/liepin.html", "utf8")
      .replace("/a/123.shtml", `/a/${jobId}.shtml`)
      .replace("/a/124.shtml", `/a/${Number(jobId) + 1}.shtml`)
      .replace("/avatar/test-account.png", `/avatar/test-account-${jobId}.png`);
    await context.route("https://www.liepin.com/zhaopin/**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: html,
    }));
    await context.route("https://www.liepin.com/a/**", (route) => route.fulfill({
      status: 200, contentType: "text/html",
      body: readFileSync("fixtures/liepin-detail.html", "utf8"),
    }));
    const page = await context.newPage();
    await page.goto(liepinUrl);
    const tabId = await worker.evaluate(async () =>
      (await chrome.tabs.query({ url: "https://www.liepin.com/zhaopin/*" }))[0]?.id);
    const state = async () => (await (await context.request.get(`${base}/api/state`, { headers })).json());
    let connection = "";
    await expect.poll(async () => {
      const found = (await state()).connections.find((item: any) =>
        item.source === "liepin" && item.account === account &&
        item.contact_click_ready && item.tab === tabId &&
        Date.now() / 1000 - item.seen_at < 3);
      connection = found?.id ?? "";
      return !!connection;
    }, { timeout: 15000 }).toBe(true);
    const startResponse = await context.request.post(`${base}/api/runs`, {
      headers, data: { connection_id: connection, mode: "auto", max_jobs: 2, minutes: 2,
        contact_interval_seconds: 6 },
    });
    expect(startResponse.ok(), await startResponse.text()).toBe(true);
    const started = await startResponse.json();
    await expect.poll(async () =>
      (await state()).runs.find((run: any) => run.id === started.id)?.status,
    { timeout: 90000 }).toBe("COMPLETED");
    const final = await state();
    expect(final.runs.find((run: any) => run.id === started.id)?.sample).toBe(true);
    const commands = final.commands.filter((item: any) => item.run_id === started.id);
    expect(commands.every((item: any) => item.sample === true)).toBe(true);
    expect(commands.filter((item: any) => item.action === "CONTACT" && item.status === "SUCCEEDED"))
      .toHaveLength(2);
    expect(commands.filter((item: any) => item.action === "CONTACT")
      .map((item: any) => item.job_key).sort())
      .toEqual([`a:${jobId}`, `a:${Number(jobId) + 1}`].sort());
    const clickTimes = await page.evaluate(() => JSON.parse(localStorage.getItem("chatTimes") || "[]"));
    expect(clickTimes).toHaveLength(2);
    expect(clickTimes[1] - clickTimes[0]).toBeGreaterThanOrEqual(6000);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("chatTrusted") || "[]"))).toEqual([true, true]);
    expect(commands.filter((item: any) => item.action === "CONTACT")
      .every((item: any) => item.result?.effect_observed === true)).toBe(true);
    await expect(page.locator("#communication")).toBeHidden();
    expect(final.jobs.find((job: any) => job.key === `a:${jobId}`)?.contact).toBe("CLICKED");
    expect(final.jobs.find((job: any) => job.key === `a:${jobId}`)?.sample).toBe(true);
    expect(final.jobs.find((job: any) => job.key === "job:456" && job.scope === `liepin:${account}`)?.sample).toBe(true);
    expect(final.jobs.find((job: any) => job.key === `a:${Number(jobId) + 1}`)?.contact).toBe("CLICKED");
    expect(final.jobs.find((job: any) => job.key === "job:456")?.contact).not.toBe("CLICKED");
    expect(final.jobs.find((job: any) => job.key === "a:789")?.decision).not.toBe("INCLUDE");
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
