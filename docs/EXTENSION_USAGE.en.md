# BOSS / Liepin extension guide

[中文](EXTENSION_USAGE.md) · [Project README](../README.en.md)

The real-site task ends at a controlled click: BOSS **立即沟通** (Start chat), or Liepin's **聊一聊** (Chat) on a job detail page after a visible page response. The extension does not send a résumé or confirm message delivery. You review the conversation and résumé manually. It never automatically retries a job with a prior click or uncertain outcome.

## Install and connect

1. From the repository root, run `npm ci`, `npm run build`, and `docker compose up -d --build --wait`. Open [the local workbench](http://127.0.0.1:17830).
2. In Chrome, go to `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the repository's `dist/extension` directory. On updates, reload the extension and refresh your BOSS/Liepin tabs. Chrome's `debugger` permission is browser-wide; the implementation uses it for pointer events on verified Liepin job/search pages and detaches after the operation. Review the permission before installing.
3. In the workbench's **连接设置** (Connection settings), generate a one-time code. Enter it in the extension popup. The popup should show **已配对·本机执行** (Paired · local execution).
4. Sign in to the recruitment site yourself. Open the Beijing search page from the popup and keep the tab in the foreground. Choose **当前页 · BOSS** or **当前页 · 猎聘** in the popup.

## Search and pacing settings

Expand **搜索入口与点击间隔** in the popup. Paste the full search URL for each platform. BOSS requires `https://www.zhipin.com/web/geek/jobs` and `city=101010100`; Liepin requires `https://www.liepin.com/zhaopin/` and `city=010&dq=010`. Both require a nonempty keyword, which you may change. Additional filters that narrow experience, education, salary, industry, or position are not part of this scope. The extension still checks that each actual job is in Beijing and related to both AI and product work.

Set **两次沟通点击的最短间隔** (click interval) to an integer from **5–120 seconds**; the default is 5. Click **保存设置**. Open the configured search page and refresh that tab. The interval is frozen when a run starts and checked by the local server before every external click. The same account's previous click is considered when a new batch starts. The popup shows the current run's interval and remaining wait. Pause or stop a running batch and wait for any claimed action to finish before changing search URLs. Recheck and continue a paused batch after the change. This pacing is no guarantee against platform restrictions.

## BOSS batch

After the left job list and right detail have loaded, select the current-page connection. **只读取与判断** (Read and judge only) inspects jobs without contacting recruiters. **点击当前岗位一次** clicks only the selected eligible job. To process a batch, choose the eligible-job limit and maximum minutes, then click **开始自动点击立即沟通**. These click actions may send BOSS's default greeting.

The extension selects each left-hand job, checks the stable ID and corresponding right-hand detail, confirms Beijing and AI/product relevance, and clicks **立即沟通** once only when eligible. It skips prior clicks, already-contacted jobs, and unresolved actions. After BOSS's recognized sent-message dialog, it chooses **留在此页** (Stay on this page), then proceeds to the next job. It scrolls for more results and stops on its budget, time limit, end of visible results, or repeated lack of new job IDs. A finished run is not a claim that the whole platform was scanned. Closing the popup does not stop the run; losing the job tab's foreground state may pause it.

## Liepin batch

On the configured Beijing Liepin search page, select the current-page Liepin connection. Set the job/time budgets and click **开始自动点击聊一聊**. The extension checks each card's stable job ID, Beijing location, and AI/product relevance; it skips previously clicked, uncertain, and already-contacted jobs. It clicks the job title to open `/a/<id>.shtml` or `/job/<id>.shtml`, clicks the detail page's top-right **聊一聊** once with a real pointer event, waits for **我的沟通** (My conversations) or **继续聊** (Continue chat), closes the detail, then moves on. It does not rely on hovering a list row. If the detail is already **继续聊** or **已沟通**, it skips without clicking. Missing page response, obstruction, account/page change, or verification prompts pause the run. A DOM `.click()` return value alone is not success evidence.

## Why buttons are gray

The top **暂停 / 接管**, **恢复**, and **停止** buttons are gray before a run starts. Start buttons require a paired service, an online configured search page, a recognized account, and a page/job state that the adapter can verify. The single-job button also needs a selected job. If all start buttons are gray, check the message beneath the current job title: it reports the blocking condition. Reload the extension and refresh the job page after rebuilding; select the current tab again. A login page, security check, wrong city/keyword URL, stale adapter version, mismatched BOSS left/right job IDs, or loss of foreground visibility must be resolved on the site. Do not clear the database to get around a blocked or uncertain record.

If the popup shows **需接管** (Needs takeover), read the reason and use **继续本轮自动点击** or **续接本轮自动点击** after the page is correct again. Existing clicks remain deduplicated. **结果未知 / UNKNOWN** means an external click may have occurred but the visible effect was not established. Check the site manually; record an evidence-backed resolution in the extension's uncertain-action section. The workbench only shows history by platform and cannot start, resume, or reconcile tasks.

The local fixture at [http://127.0.0.1:17830/fixture](http://127.0.0.1:17830/fixture) contains fictional jobs and is useful for read-only and run-flow tests. Its chat/résumé behavior does not validate either live recruitment site. Legacy `liepin-click-v1` DOM-click records remain deduplicated and require individual manual review.

If the popup is paired but a start request says the local service does not recognize `contact_interval_seconds`, the extension is newer than the running Docker backend. Stop the current batch, rebuild the app with `docker compose up -d --build --no-deps --wait app`, reload the extension at `chrome://extensions`, and refresh the recruitment tab. Before rebuilding, ensure the local `.env` administrator token matches the running service. Preserve the database volume and its deduplication history.
