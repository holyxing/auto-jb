import { test, expect, chromium } from "@playwright/test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const base = "http://127.0.0.1:17830";
const token = readFileSync(".env", "utf8")
  .match(/^AUTOJB_ADMIN_TOKEN=(.+)$/m)![1]
  .trim();

test("extension + workbench + PostgreSQL: scan, verify, automatic queue, unknown outcome", async () => {
  mkdirSync(".runtime/screenshots", { recursive: true });
  const profile = mkdtempSync(path.resolve(".runtime/e2e-"));
  const extension = path.resolve("dist/extension");
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const errors: string[] = [];
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const api = async (url: string, body?: unknown) => {
      const response = await context.request.fetch(base + "/api" + url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}` },
        data: body,
      });
      expect(response.ok(), `${url}: ${response.status()}`).toBeTruthy();
      return response.json();
    };
    const work = await context.newPage();
    await work.goto(base);
    await work.getByLabel("管理令牌").fill(token);
    await work.getByRole("button", { name: "进入工作台" }).click();
    await work.getByRole("button", { name: "连接设置", exact: true }).click();
    const pairingResponse = work.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/pair-code",
    );
    await work.getByRole("button", { name: "生成配对码", exact: true }).click();
    const generated = await pairingResponse;
    expect(generated.request().method()).toBe("POST");
    expect(generated.status()).toBe(200);
    const code = await generated.json();
    await expect(work.locator(".pair-code")).toBeVisible();
    expect((await work.locator(".pair-code").textContent()) === code.code).toBe(
      true,
    );
    let popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    );
    await popup.locator("#pairing summary").click();
    await popup.locator("#code").fill(code.code);
    await popup.locator("#pair").click();
    await expect(popup.locator("#status")).toContainText("已配对");
    const fixture = await context.newPage();
    await fixture.goto(base + "/fixture");
    const account = "e2e-" + Date.now();
    await fixture
      .locator("[data-account]")
      .evaluate((el, id) => el.setAttribute("data-account", id), account);
    await work.getByRole("button", { name: "工作台", exact: true }).click();
    const state = () => api("/state");
    let connection: string;
    let scope: string;
    await expect
      .poll(async () => {
        const s = await state();
        const c = s.connections.find(
          (c: any) =>
            c.source === "fixture" &&
            c.account ===
              createHash("sha256").update(account).digest("hex").slice(0, 24) &&
            Date.now() / 1000 - c.seen_at < 3,
        );
        connection = c?.id;
        scope = c ? `${c.source}:${c.account}` : "";
        return !!c;
      })
      .toBe(true);
    const current = async () => {
      const s = await state();
      return {
        ...s,
        runs: s.runs.filter((r: any) => r.scope === scope),
        jobs: s.jobs.filter((j: any) => j.scope === scope),
      };
    };
    await work.getByLabel("招聘平台").selectOption("fixture");
    await expect(work.getByText("本地样本，不联系招聘方")).toBeVisible();
    await expect(work.getByRole("button", { name: "开始自动沟通与投递" })).toHaveCount(0);
    await popup.locator("#scan").click();
    await expect
      .poll(async () => (await current()).runs[0]?.status, { timeout: 60000 })
      .toBe("COMPLETED");
    let s = await current();
    expect(s.jobs).toHaveLength(8);
    expect(s.jobs.filter((j: any) => j.decision === "INCLUDE")).toHaveLength(5);
    expect(s.jobs.filter((j: any) => j.decision === "EXCLUDE")).toHaveLength(2);
    expect(s.jobs.every((j: any) => j.contact === "NOT_STARTED")).toBe(true);
    await work.getByRole("button", { name: "岗位记录", exact: true }).click();
    await expect(work.locator("table thead")).toContainText("平台");
    await expect(work.locator("table tbody tr").first()).toContainText("本地样本");
    await work.getByRole("button", { name: "执行记录", exact: true }).click();
    await expect(work.locator("table thead")).toContainText("平台");
    await expect(work.locator("table tbody tr").first()).toContainText("本地样本");
    await work.getByRole("button", { name: "工作台", exact: true }).click();
    expect(
      s.commands.filter(
        (c: any) => c.run_id === s.runs[0].id && c.action === "CONTACT",
      ),
    ).toHaveLength(0);
    await fixture.locator('.job-card[data-key="director"]').click();
    await expect(fixture.locator("#detail")).toHaveAttribute(
      "data-key",
      "director",
    );
    await expect
      .poll(
        async () =>
          (await current()).connections.find((c: any) => c.id === connection)
            ?.selected_key,
      )
      .toBe("director");
    await popup.locator("#send-resume").check();
    await popup.locator("#resume-name").fill("AI产品经理.pdf");
    await popup.locator("#verify").click();
    await expect
      .poll(async () => (await current()).runs[0]?.mode)
      .toBe("verify");
    await expect
      .poll(async () => (await current()).runs[0]?.status, { timeout: 30000 })
      .toBe("COMPLETED");
    s = await current();
    expect(s.jobs.find((j: any) => j.key === "director")).toMatchObject({
      contact: "CONTACT_INITIATED",
      resume: "SENT",
    });
    expect(s.capabilities.filter((c: any) => c.scope === scope)).toHaveLength(
      2,
    );
    await popup.locator("#auto").click();
    await popup.close();
    await expect.poll(async () => (await current()).runs[0]?.mode).toBe("auto");
    await expect
      .poll(async () => (await current()).runs[0]?.status, { timeout: 70000 })
      .toBe("COMPLETED");
    s = await current();
    expect(
      s.jobs.filter((j: any) => j.contact === "CONTACT_INITIATED"),
    ).toHaveLength(5);
    expect(s.jobs.filter((j: any) => j.resume === "SENT")).toHaveLength(5);
    expect(
      s.commands.filter(
        (c: any) =>
          c.action === "CONTACT" &&
          c.job_key === "director" &&
          s.runs.some((r: any) => r.id === c.run_id),
      ),
    ).toHaveLength(1);
    await expect(work.getByText("本轮结束", { exact: true }).first()).toBeVisible();
    popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    );
    await expect(popup.locator("#state")).toHaveText("本轮结束");
    await expect(popup.locator("#send-resume")).toBeChecked();
    await expect(popup.locator("#resume-name")).toHaveValue("AI产品经理.pdf");
    await popup.setViewportSize({ width: 390, height: 600 });
    await popup.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect((await popup.locator("#pause").boundingBox())!.y).toBeLessThan(60);
    await popup.evaluate(() => window.scrollTo(0, 0));
    await popup.screenshot({
      path: ".runtime/screenshots/extension.png",
      fullPage: true,
    });
    await work.screenshot({
      path: ".runtime/screenshots/desktop.png",
      fullPage: true,
    });
    await work.setViewportSize({ width: 390, height: 844 });
    expect(
      await work.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await work.screenshot({
      path: ".runtime/screenshots/mobile.png",
      fullPage: true,
    });
    // A fresh isolated local account verifies the negative chat-only branch.
    await fixture.reload();
    const openAccount = "e2e-open-" + Date.now();
    await fixture
      .locator("[data-account]")
      .evaluate((el, id) => el.setAttribute("data-account", id), openAccount);
    const expectedAccount = createHash("sha256")
      .update(openAccount)
      .digest("hex")
      .slice(0, 24);
    await fixture.locator("#scenario").selectOption("open");
    await expect
      .poll(async () => {
        const c = (await state()).connections.find(
          (c: any) => c.id === connection,
        );
        if (c && c.account === expectedAccount) {
          scope = `${c.source}:${c.account}`;
          return true;
        }
        return false;
      })
      .toBe(true);
    const started = await api("/runs", {
      connection_id: connection!,
      mode: "verify",
      max_jobs: 1,
      minutes: 5,
      send_resume: false,
      resume_name: "",
    });
    await expect
      .poll(
        async () =>
          (await current()).runs.find((r: any) => r.id === started.id)?.status,
        { timeout: 15000 },
      )
      .toBe("WAITING_HUMAN");
    s = await current();
    expect(s.jobs.find((j: any) => j.key === "director").contact).toBe(
      "CHAT_OPENED",
    );
    expect(s.capabilities.filter((c: any) => c.scope === scope)).toHaveLength(
      0,
    );
    const pending = s.commands.filter(
      (c: any) => c.run_id === started.id && c.action === "CONTACT",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("UNKNOWN");
    await popup.locator("#connection").selectOption(connection!);
    await expect(popup.locator("#unknown-records")).toBeVisible();
    await popup.locator("#unknown-records summary").click();
    await expect(popup.locator("#unknown-command")).toHaveValue(pending[0].id);
    await expect(popup.locator("#unknown-save")).toBeDisabled();
    await popup.locator("#unknown-outcome").selectOption("NO_EFFECT");
    await popup.locator("#unknown-note").fill("已在本地样本核对，未产生沟通效果");
    await popup.locator("#unknown-save").click();
    await expect.poll(async () =>
      (await current()).commands.find((c: any) => c.id === pending[0].id)?.status,
    ).toBe("MANUALLY_RESOLVED");
    expect((await current()).jobs.find((j: any) => j.key === "director").contact).toBe("FAILED");
    await api(`/runs/${started.id}/control`, { action: "stop" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test("PostgreSQL concurrent claims grant once and stopped unknown blocks verification", async ({
  request,
}) => {
  const admin = { Authorization: `Bearer ${token}` };
  const code = await (
    await request.post(base + "/api/pair-code", { headers: admin })
  ).json();
  const paired = await (
    await request.post(base + "/api/pair", { data: { code: code.code } })
  ).json();
  const bridge = { Authorization: `Bearer ${paired.token}` };
  const account = "pg-race-" + Date.now();
  const card = {
    key: "race-job",
    title: "AI产品经理",
    company: "本地并发样本",
    city: "北京",
  };
  const snapshot = {
    source: "fixture",
    account,
    session: account,
    tab: 1,
    document: "doc",
    profile: "concurrency-test",
    url: base + "/fixture",
    selection_epoch: 0,
    phase: "LIST",
    cards: [card],
    detail: { ...card, description: "负责AI产品规划", contact_button: "READY" },
    chat: null,
    blocked: "",
    list_end: true,
    loading: false,
    list_signature: card.key,
    selected_key: card.key,
    send_ready: true,
    search_limited: false,
  };
  const observed = await (
    await request.post(base + "/api/bridge/tick", {
      headers: bridge,
      data: snapshot,
    })
  ).json();
  const run = await (
    await request.post(base + "/api/runs", {
      headers: admin,
      data: { connection_id: observed.connection_id, mode: "verify" },
    })
  ).json();
  const tick = await (
    await request.post(base + "/api/bridge/tick", {
      headers: bridge,
      data: snapshot,
    })
  ).json();
  const claim = () =>
    request.post(`${base}/api/bridge/commands/${tick.command.id}/claim`, {
      headers: bridge,
      data: snapshot,
    });
  const results = await Promise.all([claim(), claim()]);
  expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
  const granted = await results.find((r) => r.status() === 200)!.json();
  expect(granted.valid_until).toBeLessThanOrEqual(Date.now() / 1000 + 1);
  await request.post(`${base}/api/runs/${run.id}/control`, {
    headers: admin,
    data: { action: "stop" },
  });
  expect(
    (
      await request.post(base + "/api/runs", {
        headers: admin,
        data: { connection_id: observed.connection_id, mode: "verify" },
      })
    ).status(),
  ).toBe(409);
  await request.post(`${base}/api/commands/${tick.command.id}/resolve`, {
    headers: admin,
    data: { outcome: "NO_EFFECT", note: "本地并发测试没有执行任何页面点击" },
  });
});
