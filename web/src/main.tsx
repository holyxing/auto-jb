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
  contact: string; resume: string; run_id: string;
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
  const latestRuns = runs.slice().sort((a, b) => b.created_at - a.created_at).slice(0, 6);
  const orderedCommands = commands.slice().sort((a, b) => b.issued_at - a.issued_at);

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
                ["已点击", jobs.filter((job) => job.contact === "CLICKED").length, "会话由人工确认"],
                ["结果未知", jobs.filter((job) => job.contact === "UNKNOWN").length, "保留去重，不自动重试"],
              ].map(([name, count, help]) => <div className="stat" key={name}>
                <span>{name}</span><strong>{state ? count : "—"}</strong><small>{help}</small>
              </div>)}
            </section>
            <div className="work-grid">
              <section className="panel">
                <div className="panel-title"><h2>最近批次</h2>
                  <span className="muted">按招聘平台汇总</span></div>
                {!latestRuns.length ? <Empty text="暂无执行批次。" /> :
                  <div className="table-scroll"><table>
                    <thead><tr><th>平台</th><th>开始时间</th><th>方式</th><th>状态</th><th>岗位</th></tr></thead>
                    <tbody>{latestRuns.map((run) => <tr key={run.id}>
                      <td>{platformTag(run.source, run.sample)}</td><td>{dateTime(run.created_at)}</td>
                      <td>{run.mode === "scan" ? "只读扫描" : run.mode === "verify" ? "单岗验证" : "自动批次"}</td>
                      <td>{status(run.status)}{run.reason && <small>{labels[run.reason] ?? run.reason}</small>}</td>
                      <td>{run.visited} / {run.budget}</td>
                    </tr>)}</tbody>
                  </table></div>}
              </section>
              <section className="panel">
                <div className="panel-title"><h2>记录说明</h2><span className="badge">只读</span></div>
                <p className="prose">“已点击”表示扩展完成一次按钮点击，不代表消息送达或简历发送。“结果未知”表示点击后缺少足够的平台反馈；该岗位保留去重，避免重复联系。</p>
                <p className="prose">开始、暂停和续接任务请在对应招聘平台页面打开扩展操作。工作台只展示记录。</p>
              </section>
            </div>
            <section className="panel">
              <div className="panel-title"><h2>最近岗位</h2>
                <button className="text-button" onClick={() => setPage("岗位记录")}>
                  查看全部 <ChevronRight size={14} /></button></div>
              <Jobs jobs={jobs.slice(-5).reverse()} onSelect={setSelectedJob} />
            </section>
          </>}

          {page === "岗位记录" && <section className="panel">
            <div className="panel-title"><h2>岗位记录 <span className="muted">{jobs.length}</span></h2>
              <select aria-label="范围判断" value={decision} onChange={(event) => setDecision(event.target.value)}>
                <option value="ALL">全部岗位</option><option value="INCLUDE">符合范围</option>
                <option value="NEEDS_REVIEW">待复核</option><option value="EXCLUDE">不在范围</option>
              </select>
            </div>
            <Jobs jobs={jobs.filter((job) => decision === "ALL" || job.decision === decision)}
              onSelect={setSelectedJob} />
          </section>}

          {page === "执行记录" && <section className="panel">
            <div className="panel-title"><h2>执行记录</h2>
              <span className="muted">最近 100 条及全部未决动作</span></div>
            {!orderedCommands.length ? <Empty text="暂无执行记录。" /> :
              <div className="table-scroll"><table>
                <thead><tr><th>平台</th><th>时间</th><th>动作</th><th>岗位</th><th>结果</th><th>证据</th></tr></thead>
                <tbody>{orderedCommands.map((command) => {
                  const job = state?.jobs.find((item) =>
                    item.scope === command.scope && item.key === command.job_key);
                  const note = command.result?.note;
                  return <tr key={command.id}>
                    <td>{platformTag(command.source, command.sample)}</td><td>{dateTime(command.issued_at)}</td>
                    <td>{labels[command.action] ?? command.action}</td>
                    <td>{job ? <><strong>{job.data.title}</strong><small>
                      {job.data.company} · {job.data.city}</small></> : command.job_key || "—"}</td>
                    <td>{status(command.status)}
                      {typeof note === "string" && note && <small>{note}</small>}</td>
                    <td><details><summary>查看记录</summary>
                      <pre>{JSON.stringify(command.result, null, 2)}</pre>
                    </details></td>
                  </tr>;
                })}</tbody>
              </table></div>}
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
              {!state?.connections.filter(matches).length
                ? <Empty text="暂无对应平台连接。" />
                : <div className="table-scroll"><table>
                  <thead><tr><th>平台</th><th>账号标识</th><th>最近连接</th><th>状态</th></tr></thead>
                  <tbody>{state.connections.filter(matches)
                    .map((connection) => <tr key={connection.id}>
                      <td>{platformTag(connection.source, connection.sample)}</td>
                      <td>{connection.account.slice(0, 8)}</td>
                      <td>{dateTime(connection.seen_at)}</td>
                      <td>{Date.now() / 1000 - connection.seen_at < 15 ? "在线" : "离线"}
                        {connection.blocked && <small>{connection.blocked}</small>}</td>
                    </tr>)}</tbody>
                </table></div>}
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
function Jobs({ jobs, onSelect }: { jobs: Job[]; onSelect: (job: Job) => void }) {
  return jobs.length ? <div className="table-scroll"><table>
    <thead><tr><th>平台</th><th>岗位 / 企业</th><th>地点</th>
      <th>范围判断</th><th>沟通</th><th>简历</th></tr></thead>
    <tbody>{jobs.map((job) => <tr key={job.id}>
      <td>{platformTag(job.source, job.sample)}</td>
      <td><button className="job-link" onClick={() => onSelect(job)}>
        {job.data.title}</button><small>{job.data.company || "企业名称待读取"}</small></td>
      <td>{job.data.city || "待读取"}</td><td>{status(job.decision)}</td>
      <td>{status(job.contact)}</td><td>{status(job.resume)}</td>
    </tr>)}</tbody>
  </table></div> : <Empty text="暂无岗位记录。请在招聘平台页面使用扩展读取岗位。" />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
