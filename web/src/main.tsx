import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight, BriefcaseBusiness, ChevronRight, Download, LayoutDashboard,
  ListChecks, LogOut, Plug, RefreshCw, ShieldCheck,
} from "lucide-react";
import "./style.css";

type Source = "boss" | "liepin" | "fixture";
type PlatformFilter = "ALL" | Source;
type Connection = {
  id: string; source: Source; sample: boolean; account: string; seen_at: number;
  phase: string; blocked: string;
};
type Run = {
  id: string; source: Source; sample: boolean; scope: string; mode: string; status: string;
  reason: string; visited: number; budget: number; created_at: number;
};
type Job = {
  id: string; source: Source; sample: boolean; scope: string; key: string;
  data: { title: string; company: string; city: string; description?: string };
  decision: string; reason: string; evidence: string[];
  contact: string; resume: string; resume_name?: string; resume_at?: number; run_id: string;
};
type Cmd = {
  id: string; run_id: string; source: Source; sample: boolean; scope: string; job_key: string;
  action: string; status: string; issued_at: number;
  result: Record<string, unknown> | null;
};
type State = {
  connections: Connection[]; runs: Run[]; jobs: Job[]; commands: Cmd[];
  fixture_enabled: boolean;
};
const platforms: Record<Source, string> = {
  boss: "BOSS 直聘", liepin: "猎聘", fixture: "本地样本",
};
const labels: Record<string, string> = {
  RUNNING: "执行中", PAUSED_USER: "已暂停", WAITING_HUMAN: "需要处理",
  COMPLETED: "本轮结束", STOPPED: "已停止", FAILED: "失败",
  PENDING: "待读取详情", INCLUDE: "符合范围", EXCLUDE: "不在范围",
  NEEDS_REVIEW: "待复核", NOT_STARTED: "未发起", INITIATING: "发起中",
  CHAT_OPENED: "聊天已打开", CONTACT_INITIATED: "已发起沟通",
  CLICKED: "已点击·待人工确认", ALREADY_CONTACTED: "历史已沟通",
  CLOSED: "职位已下线",
  UNKNOWN: "结果未知", NOT_CHECKED: "尚未检查",
  UNAVAILABLE: "暂无可用入口", WAITING_PEER: "等待对方",
  READY: "可发送", SENDING: "发送中", SENT: "已发送简历",
  ALREADY_SENT: "历史已发送", SUCCEEDED: "动作完成",
  ISSUED: "待执行", CLAIMED: "执行中", CANCELLED: "已撤销",
  MANUALLY_RESOLVED: "人工核验", CONTACT: "点击沟通入口",
  RESUME_SEND: "发送简历", SELECT: "选择岗位", SCROLL: "加载列表",
  RESTORE: "返回列表", BUDGET_REACHED: "达到本轮预算",
  VERIFICATION_FINISHED: "当前岗位验证结束",
  END_OF_VISIBLE_RESULTS: "当前列表已读完", LIST_NO_PROGRESS: "列表未出现新岗位",
};
const dateTime = (value: number) =>
  new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
const PAGE_SIZE = 20;
type ChartDim = "day" | "company" | "city" | "resume" | "result";
type ChartStyle = "bar" | "column" | "line" | "area";
type ChartRow = { label: string; counts: Record<Source, number>; total: number };
const chartDims: { id: ChartDim; label: string }[] = [
  { id: "day", label: "日期" },
  { id: "company", label: "公司" },
  { id: "city", label: "城市" },
  { id: "resume", label: "简历名称" },
  { id: "result", label: "结果" },
];
const chartStyles: { id: ChartStyle; label: string }[] = [
  { id: "bar", label: "条形" },
  { id: "column", label: "柱状" },
  { id: "line", label: "曲线" },
  { id: "area", label: "面积" },
];
const chartSources: Source[] = ["boss", "liepin", "fixture"];
// 扩展已成功点击或已成功发出简历即计入，不等待人工确认。
const extensionSuccess = (job: Job) =>
  job.contact === "CLICKED" || job.contact === "CONTACT_INITIATED"
  || job.resume === "SENT" || job.resume === "ALREADY_SENT";
const shanghaiDay = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
function recentDays(count = 14) {
  const days: string[] = [];
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = new Date(start);
    day.setDate(start.getDate() - offset);
    days.push(day.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }));
  }
  return days;
}
function pageOf<T>(items: T[], page: number) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * PAGE_SIZE;
  return { rows: items.slice(start, start + PAGE_SIZE), page: current, pages, total: items.length };
}
const status = (value: string) => (
  <span className={
    "badge " +
    (["INCLUDE", "SENT", "SUCCEEDED", "CONTACT_INITIATED", "CLICKED", "COMPLETED"].includes(value)
      ? "good" : ["UNKNOWN", "WAITING_HUMAN", "NEEDS_REVIEW", "FAILED"].includes(value)
        ? "attention" : "")
  }>
    {labels[value] ?? value}
  </span>
);
const platformTag = (source: Source, sample = false) =>
  <span className="badge platform-tag">{platforms[source] ?? source}{sample && source !== "fixture" ? " · 本地样本" : ""}</span>;

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("autojb-token") ?? "");
  const [draftToken, setDraftToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState("工作台");
  const [platform, setPlatform] = useState<PlatformFilter>("ALL");
  const [decision, setDecision] = useState("ALL");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [chartDim, setChartDim] = useState<ChartDim>("day");
  const [listPage, setListPage] = useState({
    runs: 1, recentJobs: 1, jobs: 1, commands: 1, connections: 1,
  });

  const api = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch("/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(typeof data.detail === "string" ? data.detail : "请求失败，请检查输入");
    return data;
  }, [token]);
  const load = useCallback(async () => {
    if (!token) return;
    try {
      setState(await api("/state"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [token, api]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    setListPage({ runs: 1, recentJobs: 1, jobs: 1, commands: 1, connections: 1 });
  }, [platform, decision]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  async function login(event: React.FormEvent) {
    event.preventDefault();
    try {
      const response = await fetch("/api/state", {
        headers: { Authorization: "Bearer " + draftToken.trim() },
      });
      if (!response.ok) throw new Error("令牌不正确或服务未就绪");
      sessionStorage.setItem("autojb-token", draftToken.trim());
      setToken(draftToken.trim());
      setDraftToken("");
      setState(await response.json());
    } catch (cause) {
      setLoginError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function download() {
    const response = await fetch("/api/extension.zip", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) throw new Error("扩展下载失败");
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "auto-jb-extension.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // History is grouped by recruitment platform, never by the currently open tab.
  const matches = (item: { source: Source; sample: boolean }) =>
    platform === "fixture" ? item.sample :
      !item.sample && (platform === "ALL"
        ? item.source === "boss" || item.source === "liepin"
        : item.source === platform);
  const jobs = state?.jobs.filter(matches) ?? [];
  const runs = state?.runs.filter(matches) ?? [];
  const commands = state?.commands.filter(matches) ?? [];
  const online = state?.connections.filter(
    (connection) => matches(connection) && Date.now() / 1000 - connection.seen_at < 15,
  ) ?? [];
  const orderedRuns = runs.slice().sort((a, b) => b.created_at - a.created_at);
  const orderedJobs = jobs.slice().reverse();
  const orderedCommands = commands.slice().sort((a, b) => b.issued_at - a.issued_at);
  const filteredJobs = jobs.filter((job) => decision === "ALL" || job.decision === decision);
  const connections = state?.connections.filter(matches) ?? [];
  const runPage = pageOf(orderedRuns, listPage.runs);
  const recentJobPage = pageOf(orderedJobs, listPage.recentJobs);
  const jobPage = pageOf(filteredJobs, listPage.jobs);
  const commandPage = pageOf(orderedCommands, listPage.commands);
  const connectionPage = pageOf(connections, listPage.connections);
  const sentResumes = jobs.filter(extensionSuccess);
  const turn = (key: keyof typeof listPage, page: number) =>
    setListPage((current) => ({ ...current, [key]: page }));

  if (!token) return (
    <main className="login">
      <div className="brandmark">JB</div>
      <h1>连接本机求职工作台</h1>
      <p>使用本机管理令牌查看 BOSS 与猎聘的历史记录。</p>
      <form onSubmit={login}>
        <label>管理令牌
          <input type="password" autoComplete="off" value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)} required
            placeholder="输入本机 .env 中的管理令牌" />
        </label>
        <button className="primary">进入工作台 <ChevronRight size={16} /></button>
      </form>
      {loginError && <div role="alert" className="notice error">{loginError}</div>}
    </main>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brandmark">JB</span>
          <div>求职工作台<small>招聘平台记录</small></div>
        </div>
        <div className="nav-label">工作空间</div>
        {[
          [LayoutDashboard, "工作台"], [BriefcaseBusiness, "岗位记录"],
          [ListChecks, "执行记录"], [Plug, "连接设置"],
        ].map(([Icon, name]) => {
          const IconView = Icon as typeof LayoutDashboard;
          return <button key={String(name)} className={page === name ? "nav active" : "nav"}
            onClick={() => setPage(String(name))}>
            <IconView size={18} />{String(name)}
          </button>;
        })}
        <div className="sidebar-bottom"><ShieldCheck size={17} />
          <span>操作由浏览器扩展执行</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span>个人工作空间 <ChevronRight size={14} /> {page}</span>
          <div>
            <span className={"connection-dot " + (online.length ? "on" : "")} />
            {online.length ? "平台扩展在线" : "暂无在线招聘页面"}
            <button className="icon" title="退出" onClick={() => {
              sessionStorage.removeItem("autojb-token");
              setToken("");
              setState(null);
            }}><LogOut size={16} /></button>
          </div>
        </header>
        <main className="workspace">
          <div className="page-heading">
            <div>
              <div className="eyebrow">招聘平台历史记录</div>
              <h1>{page}</h1>
              <p>按平台查看岗位、点击和执行证据；页面操作在浏览器扩展中完成。</p>
            </div>
            <button className="secondary" onClick={() => void load()}>
              <RefreshCw size={15} />刷新
            </button>
          </div>
          {error && <div className="notice error" role="alert">
            {error}<button onClick={() => setError("")}>关闭</button>
          </div>}
          <div className="context">
            <label>招聘平台
              <select aria-label="招聘平台" value={platform}
                onChange={(event) => { setPlatform(event.target.value as PlatformFilter); setSelectedJob(null); }}>
                <option value="ALL">全部招聘平台</option>
                <option value="boss">BOSS 直聘</option>
                <option value="liepin">猎聘</option>
                {state?.fixture_enabled && <option value="fixture">本地样本</option>}
              </select>
            </label>
            <span className="context-rule">北京 <span>／</span> AI 与产品相关
              <span>／</span> 薪资、职级不限</span>
            {platform === "fixture" && <span className="badge attention">本地样本，不联系招聘方</span>}
          </div>

          {page === "工作台" && <>
            <section className="stats">
              {[
                ["已记录岗位", jobs.length, "按平台和账号归档"],
                ["符合范围", jobs.filter((job) => job.decision === "INCLUDE").length, "北京 AI 与产品岗位"],
                ["已点击", jobs.filter((job) => job.contact === "CLICKED").length, "扩展点击成功"],
                ["结果未知", jobs.filter((job) => job.contact === "UNKNOWN").length, "保留去重，不自动重试"],
              ].map(([name, count, help]) => <div className="stat" key={name}>
                <span>{name}</span><strong>{state ? count : "—"}</strong><small>{help}</small>
              </div>)}
            </section>
            <ResumeChart jobs={sentResumes} commands={commands} dim={chartDim} onDim={setChartDim} />
            <div className="work-grid">
              <section className="panel">
                <div className="panel-title"><h2>最近批次</h2>
                  <span className="muted">按招聘平台汇总</span></div>
                {!orderedRuns.length ? <Empty text="暂无执行批次。" /> : <>
                  <div className="table-scroll"><table>
                    <thead><tr><th>平台</th><th>开始时间</th><th>方式</th><th>状态</th><th>岗位</th></tr></thead>
                    <tbody>{runPage.rows.map((run) => <tr key={run.id}>
                      <td>{platformTag(run.source, run.sample)}</td><td>{dateTime(run.created_at)}</td>
                      <td>{run.mode === "scan" ? "只读扫描" : run.mode === "verify" ? "单岗验证" : "自动批次"}</td>
                      <td>{status(run.status)}{run.reason && <small>{labels[run.reason] ?? run.reason}</small>}</td>
                      <td>{run.visited} / {run.budget}</td>
                    </tr>)}</tbody>
                  </table></div>
                  <Pager page={runPage.page} pages={runPage.pages} total={runPage.total}
                    onPage={(value) => turn("runs", value)} />
                </>}
              </section>
              <section className="panel">
                <div className="panel-title"><h2>记录说明</h2><span className="badge">只读</span></div>
                <p className="prose">“已点击”表示扩展完成一次按钮点击，不代表消息送达或简历发送。“结果未知”表示点击后缺少足够的平台反馈；该岗位保留去重，避免重复联系。</p>
                <p className="prose">开始、暂停和续接任务请在对应招聘平台页面打开扩展操作。工作台只展示记录。扩展点击成功和简历发送成功都计入上方统计。</p>
              </section>
            </div>
            <section className="panel">
              <div className="panel-title"><h2>最近岗位</h2>
                <button className="text-button" onClick={() => setPage("岗位记录")}>
                  查看全部 <ChevronRight size={14} /></button></div>
              <Jobs jobs={recentJobPage.rows} onSelect={setSelectedJob} />
              <Pager page={recentJobPage.page} pages={recentJobPage.pages} total={recentJobPage.total}
                onPage={(value) => turn("recentJobs", value)} />
            </section>
          </>}

          {page === "岗位记录" && <section className="panel">
            <div className="panel-title"><h2>岗位记录 <span className="muted">{jobs.length}</span></h2>
              <select aria-label="范围判断" value={decision} onChange={(event) => setDecision(event.target.value)}>
                <option value="ALL">全部岗位</option><option value="INCLUDE">符合范围</option>
                <option value="NEEDS_REVIEW">待复核</option><option value="EXCLUDE">不在范围</option>
              </select>
            </div>
            <Jobs jobs={jobPage.rows} onSelect={setSelectedJob} />
            <Pager page={jobPage.page} pages={jobPage.pages} total={jobPage.total}
              onPage={(value) => turn("jobs", value)} />
          </section>}

          {page === "执行记录" && <section className="panel">
            <div className="panel-title"><h2>执行记录</h2>
              <span className="muted">全部记录，每页 {PAGE_SIZE} 条</span></div>
            {!orderedCommands.length ? <Empty text="暂无执行记录。" /> : <>
              <div className="table-scroll"><table>
                <thead><tr><th>平台</th><th>时间</th><th>动作</th><th>岗位</th><th>结果</th><th>证据</th></tr></thead>
                <tbody>{commandPage.rows.map((command) => {
                  const job = state?.jobs.find((item) =>
                    item.scope === command.scope && item.key === command.job_key);
                  const note = command.result?.note;
                  const chat = (command.result?.snapshot as { chat?: { resume_name?: string } } | undefined)?.chat;
                  return <tr key={command.id}>
                    <td>{platformTag(command.source, command.sample)}</td><td>{dateTime(command.issued_at)}</td>
                    <td>{labels[command.action] ?? command.action}</td>
                    <td>{job ? <><strong>{job.data.title}</strong><small>
                      {job.data.company} · {job.data.city}
                      {(job.resume_name || chat?.resume_name) && command.action === "RESUME_SEND"
                        ? ` · ${job.resume_name || chat?.resume_name}` : ""}
                    </small></> : command.job_key || "—"}</td>
                    <td>{status(command.status)}
                      {typeof note === "string" && note && <small>{note}</small>}</td>
                    <td><details><summary>查看记录</summary>
                      <pre>{JSON.stringify(command.result, null, 2)}</pre>
                    </details></td>
                  </tr>;
                })}</tbody>
              </table></div>
              <Pager page={commandPage.page} pages={commandPage.pages} total={commandPage.total}
                onPage={(value) => turn("commands", value)} />
            </>}
          </section>}

          {page === "连接设置" && <div className="work-grid">
            <section className="panel">
              <div className="panel-title"><h2>连接 Chrome 扩展</h2>
                <span className="badge">本机连接</span></div>
              <ol className="steps">
                <li><strong>安装扩展</strong><p>下载解压，在 Chrome 扩展管理中加载已解压目录。</p>
                  <button className="secondary" disabled={busy} onClick={() => void act(download)}>
                    <Download size={15} />下载扩展</button></li>
                <li><strong>生成一次性配对码</strong>
                  <p>在扩展弹窗输入配对码。配对码 5 分钟有效，只能使用一次。</p>
                  <button className="secondary" disabled={busy} onClick={() => void act(async () => {
                    const result = await api("/pair-code", {});
                    setPairCode(result.code);
                  })}>生成配对码</button>
                  {pairCode && <output className="pair-code">{pairCode}</output>}
                </li>
                <li><strong>打开招聘平台</strong><p>以下是默认北京搜索页；如已在扩展中修改关键词，请用扩展弹窗打开配置的页面。保持登录，在岗位列表页使用扩展操作。</p>
                  <div className="platform-links">
                    <a className="button secondary" target="_blank" rel="noreferrer"
                      href="https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101010100&industry=&position=">
                      BOSS 直聘 <ArrowUpRight size={14} /></a>
                    <a className="button secondary" target="_blank" rel="noreferrer"
                      href="https://www.liepin.com/zhaopin/?city=010&dq=010&key=ai%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&workYearCode=0&currentPage=0&pageSize=40">
                      猎聘 <ArrowUpRight size={14} /></a>
                  </div>
                </li>
              </ol>
            </section>
            <section className="panel">
              <div className="panel-title"><h2>平台连接状态</h2>
                <span className="muted">仅显示连接，不控制页面</span></div>
              {!connections.length
                ? <Empty text="暂无对应平台连接。" />
                : <>
                  <div className="table-scroll"><table>
                    <thead><tr><th>平台</th><th>账号标识</th><th>最近连接</th><th>状态</th></tr></thead>
                    <tbody>{connectionPage.rows.map((connection) => <tr key={connection.id}>
                      <td>{platformTag(connection.source, connection.sample)}</td>
                      <td>{connection.account.slice(0, 8)}</td>
                      <td>{dateTime(connection.seen_at)}</td>
                      <td>{Date.now() / 1000 - connection.seen_at < 15 ? "在线" : "离线"}
                        {connection.blocked && <small>{connection.blocked}</small>}</td>
                    </tr>)}</tbody>
                  </table></div>
                  <Pager page={connectionPage.page} pages={connectionPage.pages} total={connectionPage.total}
                    onPage={(value) => turn("connections", value)} />
                </>}
            </section>
          </div>}
        </main>
        <footer>Auto JB · 招聘平台记录 <span>页面操作由浏览器扩展执行</span></footer>
      </div>
      {selectedJob && <div className="drawer-backdrop" onClick={() => setSelectedJob(null)}>
        <aside className="drawer" onClick={(event) => event.stopPropagation()}>
          <button className="secondary" onClick={() => setSelectedJob(null)}>关闭详情</button>
          <h2>{selectedJob.data.title}</h2>
          <p>{platformTag(selectedJob.source, selectedJob.sample)} {selectedJob.data.company} · {selectedJob.data.city}</p>
          {status(selectedJob.decision)}
          <h3>判断依据</h3><p>{selectedJob.reason}</p>
          {selectedJob.evidence.map((item, index) => <blockquote key={index}>{item}</blockquote>)}
          <h3>沟通与简历记录</h3><p>{status(selectedJob.contact)} {status(selectedJob.resume)}</p>
          {selectedJob.resume_name && <p>简历文件：{selectedJob.resume_name}</p>}
          {!!selectedJob.resume_at && <p>简历时间：{dateTime(selectedJob.resume_at)}</p>}
          <h3>职位描述</h3><p className="description">
            {selectedJob.data.description || "尚未读取详情"}</p>
        </aside>
      </div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><BriefcaseBusiness size={28} /><p>{text}</p></div>;
}
function Pager({ page, pages, total, onPage }: {
  page: number; pages: number; total: number; onPage: (page: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  return <div className="pager">
    <span>共 {total} 条</span>
    <button className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
    <span>{page} / {pages}</span>
    <button className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
  </div>;
}
function ResumeChart({ jobs, commands, dim, onDim }: {
  jobs: Job[]; commands: Cmd[]; dim: ChartDim; onDim: (dim: ChartDim) => void;
}) {
  const [style, setStyle] = useState<ChartStyle>("bar");
  const rows = chartRows(jobs, commands, dim);
  const max = Math.max(1, ...rows.map((row) => row.total));
  return <section className="panel chart-panel">
    <div className="panel-title">
      <h2>简历发送统计</h2>
      <div className="segment" role="tablist" aria-label="统计维度">
        {chartDims.map((item) => <button key={item.id} role="tab"
          aria-selected={dim === item.id} className={dim === item.id ? "active" : ""}
          onClick={() => onDim(item.id)}>{item.label}</button>)}
      </div>
    </div>
    <p className="prose">统计扩展已成功完成的发送，包括沟通点击成功和简历发送成功。可按日期、公司、城市、简历名称和结果查看，并切换条形、柱状、曲线和面积。日期按北京时间。</p>
    {!jobs.length ? <Empty text="尚无扩展发送成功的记录。" /> : <>
      <div className="segment chart-styles" role="tablist" aria-label="图表样式">
        {chartStyles.map((item) => <button key={item.id} role="tab"
          aria-selected={style === item.id} className={style === item.id ? "active" : ""}
          onClick={() => setStyle(item.id)}>{item.label}</button>)}
      </div>
      {style === "bar" ? <div className="chart">
        {rows.map((row) => <div className="chart-row" key={row.label}>
          <span className="chart-label" title={row.label}>{row.label}</span>
          <div className="chart-track" role="img" aria-label={`${row.label} ${row.total}`}>
            {chartSources.map((source) => row.counts[source] ? (
              <span key={source} className={"chart-part " + source}
                style={{ width: `${(row.counts[source] / max) * 100}%` }} />
            ) : null)}
          </div>
          <strong>{row.total}</strong>
        </div>)}
      </div> : <TrendChart rows={rows} style={style} />}
      <div className="chart-legend">
        <span><i className="boss" />BOSS 直聘</span>
        <span><i className="liepin" />猎聘</span>
        <span><i className="fixture" />本地样本</span>
      </div>
    </>}
  </section>;
}
function smoothLine(points: { x: number; y: number }[]) {
  // 相邻点的中点作控制点，把折线收成曲线。
  if (!points.length) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const mid = (current.x + next.x) / 2;
    path += ` C ${mid} ${current.y}, ${mid} ${next.y}, ${next.x} ${next.y}`;
  }
  return path;
}
function TrendChart({ rows, style }: { rows: ChartRow[]; style: Exclude<ChartStyle, "bar"> }) {
  const width = 640;
  const height = 240;
  const pad = { left: 36, right: 12, top: 16, bottom: 46 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const peak = Math.max(1, ...rows.map((row) =>
    style === "line" ? Math.max(...chartSources.map((source) => row.counts[source])) : row.total));
  const slot = innerW / Math.max(rows.length, 1);
  const xAt = (index: number) => pad.left + slot * index + slot / 2;
  const yAt = (value: number) => pad.top + innerH - (value / peak) * innerH;
  const ticks = [...new Set([0, Math.round(peak / 2), peak])];
  const summary = rows.map((row) => `${row.label} ${row.total}`).join("，");
  return <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
    {ticks.map((tick) => <g key={tick}>
      <line className="grid" x1={pad.left} x2={width - pad.right} y1={yAt(tick)} y2={yAt(tick)} />
      <text x={pad.left - 6} y={yAt(tick) + 3} textAnchor="end">{tick}</text>
    </g>)}
    {style === "column" && rows.map((row, index) => {
      const barW = Math.max(8, Math.min(32, slot * 0.62));
      let cursor = yAt(0);
      return chartSources.map((source) => {
        const barH = (row.counts[source] / peak) * innerH;
        cursor -= barH;
        return barH > 0 ? <rect key={source} className={source}
          x={xAt(index) - barW / 2} y={cursor} width={barW} height={barH} rx={2}>
          <title>{`${row.label} ${platforms[source]} ${row.counts[source]}`}</title>
        </rect> : null;
      });
    })}
    {style === "line" && chartSources.map((source, sourceIndex) => {
      // 同一天两个平台数量接近时错开，避免后画的线把前一条完全盖住。
      const shift = (sourceIndex - (chartSources.length - 1) / 2) * 7;
      const points = rows.map((row, index) => ({
        x: xAt(index) + shift,
        y: yAt(row.counts[source]),
      }));
      if (points.every((point) => point.y === yAt(0))) return null;
      return <g key={source} className={source}>
        {points.length > 1 && <path className="line" d={smoothLine(points)} />}
        {points.map((point, index) => <circle key={rows[index].label} cx={point.x} cy={point.y} r={3.5}>
          <title>{`${rows[index].label} ${platforms[source]} ${rows[index].counts[source]}`}</title>
        </circle>)}
      </g>;
    })}
    {style === "area" && rows.length < 2 && rows.map((row, index) => {
      const barW = 36;
      let cursor = yAt(0);
      return chartSources.map((source) => {
        const barH = (row.counts[source] / peak) * innerH;
        cursor -= barH;
        return barH > 0 ? <rect key={source} className={"area " + source}
          x={xAt(index) - barW / 2} y={cursor} width={barW} height={barH} rx={2}>
          <title>{`${row.label} ${platforms[source]} ${row.counts[source]}`}</title>
        </rect> : null;
      });
    })}
    {style === "area" && rows.length >= 2 && chartSources.map((source, sourceIndex) => {
      const lower = rows.map((row, index) => {
        const base = chartSources.slice(0, sourceIndex)
          .reduce((sum, name) => sum + row.counts[name], 0);
        return { x: xAt(index), y: yAt(base) };
      });
      const upper = rows.map((row, index) => {
        const value = chartSources.slice(0, sourceIndex + 1)
          .reduce((sum, name) => sum + row.counts[name], 0);
        return { x: xAt(index), y: yAt(value) };
      });
      if (upper.every((point, index) => point.y === lower[index].y)) return null;
      const forward = smoothLine(upper);
      const back = smoothLine([...lower].reverse()).replace(/^M/, "L");
      return <path key={source} className={"area " + source} d={`${forward} ${back} Z`}>
        <title>{platforms[source]}</title>
      </path>;
    })}
    {rows.map((row, index) => <text key={row.label} x={xAt(index)} y={height - 16} textAnchor="middle">
      <title>{row.label}</title>
      {row.label.length > 6 ? row.label.slice(0, 6) : row.label}
    </text>)}
  </svg>;
}
function successTimes(commands: Cmd[]) {
  const times = new Map<string, number>();
  for (const command of commands) {
    if (command.status !== "SUCCEEDED") continue;
    if (command.action !== "CONTACT" && command.action !== "RESUME_SEND") continue;
    const recorded = command.result?.click_recorded_at;
    const stamp = typeof recorded === "number" && recorded > 0 ? recorded : command.issued_at;
    const id = `${command.scope}\0${command.job_key}`;
    times.set(id, Math.max(times.get(id) ?? 0, stamp));
  }
  return times;
}
function chartRows(jobs: Job[], commands: Cmd[], dim: ChartDim) {
  const blank = (): Record<Source, number> => ({ boss: 0, liepin: 0, fixture: 0 });
  const grouped = new Map<string, Record<Source, number>>();
  const stamps = successTimes(commands);
  const add = (label: string, source: Source) => {
    const row = grouped.get(label) ?? blank();
    row[source] += 1;
    grouped.set(label, row);
  };
  if (dim === "day") {
    const days = recentDays();
    for (const day of days) grouped.set(day, blank());
    for (const job of jobs) {
      const stamp = job.resume_at || stamps.get(`${job.scope}\0${job.key}`) || 0;
      if (!stamp) continue;
      const day = shanghaiDay(stamp);
      if (grouped.has(day)) add(day, job.source);
    }
    return days.map((day) => {
      const counts = grouped.get(day) ?? blank();
      return { label: day.slice(5), counts, total: counts.boss + counts.liepin + counts.fixture };
    });
  }
  for (const job of jobs) {
    const label = dim === "company" ? (job.data.company || "未填写公司")
      : dim === "city" ? (job.data.city || "未填写城市")
      : dim === "resume" ? (job.resume_name || "沟通点击")
      : "发送成功";
    add(label, job.source);
  }
  return [...grouped.entries()]
    .map(([label, counts]) => ({
      label, counts, total: counts.boss + counts.liepin + counts.fixture,
    }))
    .sort((left, right) => right.total - left.total)
    .slice(0, 12);
}
function Jobs({ jobs, onSelect }: { jobs: Job[]; onSelect: (job: Job) => void }) {
  return jobs.length ? <div className="table-scroll"><table>
    <thead><tr><th>平台</th><th>岗位 / 企业</th><th>地点</th>
      <th>范围判断</th><th>沟通</th><th>简历</th></tr></thead>
    <tbody>{jobs.map((job) => <tr key={job.id}>
      <td>{platformTag(job.source, job.sample)}</td>
      <td><button className="job-link" onClick={() => onSelect(job)}>
        {job.data.title}</button><small>{job.data.company || "企业名称待读取"}</small></td>
      <td>{job.data.city || "待读取"}</td><td>{status(job.decision)}</td>
      <td>{status(job.contact)}</td><td>{status(job.resume)}
        {job.resume_name && <small>{job.resume_name}</small>}
        {!!job.resume_at && <small>{dateTime(job.resume_at)}</small>}</td>
    </tr>)}</tbody>
  </table></div> : <Empty text="暂无岗位记录。请在招聘平台页面使用扩展读取岗位。" />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
