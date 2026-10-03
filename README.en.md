# Auto JB · Local job search workbench

[中文](README.md) · [Extension guide](docs/EXTENSION_USAGE.en.md) · [扩展使用说明](docs/EXTENSION_USAGE.md)

Auto JB uses one Chrome extension for BOSS Zhipin and Liepin. A local FastAPI/PostgreSQL service stores run state, job decisions, click receipts, and deduplication history. The React workbench is a **read-only, platform-filtered history viewer** and a pairing entry point; starts, pauses, resumes, stops, and manual reconciliation happen in the extension.

The extension considers jobs in Beijing whose title and responsibilities relate to both AI and product work. Search keywords can change, but a search URL is only the source of candidates: it does not replace the per-job scope check. Salary, seniority, and experience are not exclusion criteria. A run processes the results it can reach on the opened search page; it does not claim to cover every job on a platform.

For BOSS, task completion means one click on **立即沟通** (Start chat) for an eligible job. For Liepin, the extension opens the job detail, makes one real pointer click on the detail page's **聊一聊** (Chat) button, observes the page response, and closes the detail. The resulting **CLICKED / 已点击·待人工确认** status is a local click record, not proof that a message was delivered or a résumé was sent. You review subsequent conversations and résumé steps yourself. Previously clicked, already contacted, and uncertain-result jobs are not retried automatically. See the [Liepin integration status](docs/LIEPIN_INTEGRATION_PLAN.md) for the live-validation boundary.

## Requirements and local setup

Install Docker Compose, Node.js 22+, and uv. From the repository root:

```sh
uv run python scripts/setup.py
npm ci
npm run build
docker compose up -d --build --wait
```

Open [http://127.0.0.1:17830](http://127.0.0.1:17830) and sign in with `AUTOJB_ADMIN_TOKEN` from your local `.env`. Setup generates random credentials with restricted file permissions. Do not commit or share `.env`. The extension's local-service address is fixed at `127.0.0.1:17830`; changing `AUTOJB_PORT` alone will break it. PostgreSQL stays inside the Compose network. `docker compose stop` pauses the stack; `docker compose up -d --wait` restarts it. Keep the database volume to preserve click history and deduplication.

## Install and pair the extension

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/extension`. Alternatively, download and unpack the extension ZIP from the workbench's connection page. After rebuilding an already installed extension, click **Reload** in Chrome and refresh the recruitment tabs. Chrome will disclose the extension's `debugger` permission, used for Liepin pointer clicks; review that browser-level permission before installing.
2. Generate a one-time pairing code on the workbench's connection page. Enter it in the extension popup within five minutes. The extension stores a device token, not the administrator token.
3. Optionally test with [the local fixture](http://127.0.0.1:17830/fixture). It has fictional jobs and sends no messages to recruiters. The popup labels this source as a local sample.
4. Sign in to BOSS or Liepin, open the configured Beijing search page using the popup, keep the tab foregrounded, and select its **current page** connection. You may run **read and judge only** before starting a click batch. For a real site, clicking the single-job or batch button may send its default greeting.

The [detailed extension guide](docs/EXTENSION_USAGE.en.md) covers button availability, read-only scanning, batch runs, takeover, and status reconciliation. Chrome Web Store packaging notes are in [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md); GitHub publication does not install or publish the extension to the Store.

## Configure search URLs and click interval

In the popup, expand **搜索入口与点击间隔** (Search and click settings). Set one URL per site, set the interval, and save. The default URLs are:

- BOSS: `https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101010100&industry=&position=`
- Liepin: `https://www.liepin.com/zhaopin/?city=010&dq=010&key=ai%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&workYearCode=0&currentPage=0&pageSize=40`

You can change each **keyword**, but the URL must remain on that site's Beijing search page: BOSS `city=101010100`, Liepin `city=010&dq=010`. Extra experience, salary, education, industry, and position filters are rejected. The shared interval accepts an integer from **5 to 120 seconds**, default **5**. It is frozen in each run and checked again by the server before a click, including across batches for the same account. Pause or stop a running batch and wait for any claimed action to finish before changing search URLs; a paused batch must be rechecked and continued. Reopen and refresh the configured search tab after saving. This local pacing does not guarantee that a recruitment platform will not restrict the account.

## Records and limits

The workbench displays job, run, and execution history by platform; it neither filters by the current browser tab nor operates a recruitment site. `UNKNOWN` means a click may have happened but its effect could not be confirmed. Check the corresponding site manually and reconcile the uncertain action in the extension; never automatically click that job again. Legacy Liepin `liepin-click-v1` DOM-click records are retained for deduplication but were not proof of an actual conversation.

The current real-site workflow does not send résumés, draft greetings, reply to recruiters, or bypass logins, CAPTCHAs, or site checks. A separate fixture exercises earlier chat/résumé paths without contacting real employers. Site UI changes or lost page visibility may pause a run for manual takeover. Real-platform acceptance must be distinguished from local fixture tests.

Optional Jev classification is off by default. If enabled through `AUTOJB_USE_JEV=true`, `TYPESAFE_API_KEY`, and `TYPESAFE_MODEL` in `.env`, it sends limited job-title/responsibility excerpts to Typesafe and can incur provider charges. Only mock tests exist for this integration; see the Chinese README for its precise limits.

## Developer checks

```sh
uv sync --locked
uv run ruff check backend scripts/setup.py
uv run pytest -q
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The E2E suite requires the local Compose stack and fixture. It uses an isolated temporary Chromium profile; it does not operate your personal Chrome profile or either recruitment site. The backend currently creates an initial database schema without a production migration path. Do not deploy this version as a shared, public multi-user service.
