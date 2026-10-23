import hashlib
import hmac
import io
import os
import re
import secrets
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError

from . import engine as flow
from .contracts import Control, Pair, Resolve, Result, Snapshot, Start
from .db import Capability, Command, Connection, Device, Job, Pairing, Run, database

ROOT = Path(__file__).resolve().parents[2]


def token_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def create_app(database_url=None, admin_token=None, fixture_enabled=None):
    admin = admin_token or os.getenv("AUTOJB_ADMIN_TOKEN", "")
    if not admin:
        raise RuntimeError("Set AUTOJB_ADMIN_TOKEN with scripts/setup.py; refusing insecure startup")
    fixture = (
        fixture_enabled
        if fixture_enabled is not None
        else os.getenv("AUTOJB_FIXTURE_ENABLED", "false") == "true"
    )
    origin = os.getenv("AUTOJB_ORIGIN", "http://127.0.0.1:17830")
    engine, factory = database(database_url)

    def remember_sent_resumes():
        # 旧记录的简历文件名只存在命令快照里，启动时补写到岗位，避免工作台缺字段。
        with factory() as db:
            pending = list(db.scalars(select(Job).where(
                Job.resume.in_(("SENT", "ALREADY_SENT", "UNKNOWN")),
                or_(Job.resume_name == "", Job.resume_name.is_(None)),
            )))
            for job in pending:
                command = db.scalar(
                    select(Command)
                    .join(Run, Run.id == Command.run_id)
                    .where(
                        Run.scope == job.scope,
                        Command.job_key == job.key,
                        Command.action == "RESUME_SEND",
                    )
                    .order_by(Command.issued_at.desc())
                )
                chat = {}
                if command and isinstance(command.result, dict):
                    snapshot = command.result.get("snapshot")
                    if isinstance(snapshot, dict) and isinstance(snapshot.get("chat"), dict):
                        chat = snapshot["chat"]
                name = str(chat.get("resume_name") or "")
                if not name or command is None:
                    continue
                job.resume_name = name
                job.resume_at = float(chat.get("resume_at") or command.issued_at or 0)
            db.commit()

    @asynccontextmanager
    async def lifespan(app):
        remember_sent_resumes()
        yield
        engine.dispose()

    app = FastAPI(title="Auto JB", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.factory = factory

    def db_session():
        with factory() as session:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

    def bearer(request: Request):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise HTTPException(401, "请输入本机管理令牌或连接扩展")
        return header[7:]

    def is_admin(token=Depends(bearer)):
        if not hmac.compare_digest(token, admin):
            raise HTTPException(401, "管理令牌无效")

    def device(token=Depends(bearer), db=Depends(db_session)):
        item = db.scalar(select(Device).where(Device.token_hash == token_hash(token)))
        if not item:
            raise HTTPException(401, "扩展未配对或已撤销")
        return item

    @app.middleware("http")
    async def security(request, call_next):
        supplied_origin = request.headers.get("origin", "")
        allowed = supplied_origin in ["", origin, "http://127.0.0.1:17831"] or bool(
            re.fullmatch(r"chrome-extension://[a-p]{32}", supplied_origin)
        )
        if request.url.path.startswith("/api"):
            if not allowed:
                return JSONResponse({"detail": "拒绝非本地工作台或扩展来源"}, status_code=403)
            if request.headers.get("sec-fetch-site") == "cross-site" and not supplied_origin.startswith(
                "chrome-extension://"
            ):
                return JSONResponse({"detail": "拒绝跨站请求"}, status_code=403)
            length = request.headers.get("content-length", "0")
            if not length.isdigit():
                return JSONResponse({"detail": "无效请求长度"}, status_code=400)
            if int(length) > 250000:
                return JSONResponse({"detail": "请求体过大"}, status_code=413)
            if request.method == "OPTIONS":
                response = Response(status_code=204)
            else:
                response = await call_next(request)
            if supplied_origin:
                response.headers["Access-Control-Allow-Origin"] = supplied_origin
                response.headers["Vary"] = "Origin"
                response.headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type"
                response.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
        else:
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(IntegrityError)
    async def conflict(request, exc):
        return JSONResponse({"detail": "已有未结束任务或重复动作，请刷新后核对"}, status_code=409)

    @app.get("/api/health")
    def health(db=Depends(db_session)):
        db.execute(text("SELECT 1"))
        return {"ok": True}

    def observe(db, dev, snap):
        s = snap.model_dump()
        url = urlparse(s["url"])
        if s["source"] == "boss":
            if url.scheme != "https" or url.hostname != "www.zhipin.com":
                raise HTTPException(400, "BOSS 数据来源不正确")
        elif s["source"] == "liepin":
            if url.scheme != "https" or url.hostname != "www.liepin.com" or url.path != "/zhaopin/":
                raise HTTPException(400, "猎聘数据来源不正确")
        elif not fixture or url.hostname not in ["127.0.0.1", "localhost"] or url.path != "/fixture":
            raise HTTPException(400, "本地样本模式未启用或来源不正确")
        identity = token_hash(f"{dev.id}:{s['session']}:{s['tab']}")[:32]
        connection = db.scalar(select(Connection).where(Connection.id == identity).with_for_update())
        if connection is None:
            connection = Connection(
                id=identity,
                device_id=dev.id,
                source=s["source"],
                account=s["account"],
                profile=s["profile"],
                snapshot=s,
                seen_at=time.time(),
            )
            db.add(connection)
        else:
            connection.snapshot, connection.seen_at = s, time.time()
            connection.account, connection.profile, connection.source = (
                s["account"],
                s["profile"],
                s["source"],
            )
        db.flush()
        return connection, s

    @app.post("/api/pair-code", dependencies=[Depends(is_admin)])
    def pairing_code(db=Depends(db_session)):
        db.execute(delete(Pairing))
        code = secrets.token_hex(5).upper()
        db.add(Pairing(code_hash=token_hash(code), expires=time.time() + 300))
        return {"code": code, "expires_in": 300}

    @app.post("/api/pair")
    def pair(body: Pair, db=Depends(db_session)):
        candidate = db.scalar(select(Pairing).with_for_update())
        if not candidate or candidate.expires < time.time() or candidate.attempts >= 5:
            raise HTTPException(403, "配对码无效或过期，请重新生成")
        candidate.attempts += 1
        if not hmac.compare_digest(candidate.code_hash, token_hash(body.code.upper())):
            db.commit()
            raise HTTPException(403, "配对码不正确")
        value = secrets.token_urlsafe(32)
        dev = Device(token_hash=token_hash(value), name=body.name)
        db.add(dev)
        db.delete(candidate)
        db.flush()
        return {"token": value, "device_id": dev.id}

    @app.get("/api/state", dependencies=[Depends(is_admin)])
    def state(db=Depends(db_session)):
        runs = list(db.scalars(select(Run).order_by(Run.created_at.desc())))
        connections = list(db.scalars(select(Connection).order_by(Connection.seen_at.desc())))
        sample_devices = set(db.scalars(
            select(Device.id).where(Device.name.in_(("Liepin local fixture", "test_only:liepin-fixture")))
        ))
        sample_connections = {c.id for c in connections if c.device_id in sample_devices}
        sample_scopes = {
            f"{c.source}:{c.account}" for c in connections if c.id in sample_connections
        }
        sample_runs = set(db.scalars(
            select(Run.id).where(Run.connection_id.in_(sample_connections))
        )) if sample_connections else set()
        by_id = {c.id: c for c in connections}
        for run in runs:
            c = by_id.get(run.connection_id)
            if run.status == "RUNNING" and (not c or c.seen_at < time.time() - 25):
                db.refresh(run, with_for_update=True)
                if run.status == "RUNNING":
                    flow.pause(db, run, "浏览器连接中断；恢复前核验未决动作")
        jobs = list(db.scalars(select(Job).order_by(Job.created_at)))
        commands = list(db.execute(
            select(Command, Run.scope)
            .join(Run, Run.id == Command.run_id)
            .order_by(Command.issued_at.desc())
        ))
        return {
            "connections": [
                {
                    "id": c.id,
                    "source": c.source,
                    "sample": c.source == "fixture" or c.id in sample_connections,
                    "account": c.account,
                    "profile": c.profile,
                    "seen_at": c.seen_at,
                    "phase": c.snapshot["phase"],
                    "blocked": c.snapshot["blocked"],
                    "selected_key": c.snapshot["selected_key"],
                    "detail": c.snapshot["detail"],
                    "tab": c.snapshot["tab"],
                    "send_ready": c.snapshot.get("send_ready", False),
                    "contact_click_ready": c.snapshot.get("contact_click_ready", False),
                    "search_limited": c.snapshot.get("search_limited", False),
                }
                for c in connections
            ],
            "runs": [
                {
                    **{
                        k: getattr(r, k)
                        for k in [
                            "id",
                            "campaign_id",
                            "connection_id",
                            "scope",
                            "profile",
                            "mode",
                            "status",
                            "reason",
                            "budget",
                            "visited",
                            "created_at",
                            "deadline",
                            "lease_until",
                        ]
                    },
                    "cooldown_until": r.settings.get("cooldown_until", 0),
                    "contact_interval_seconds": flow.contact_interval(r),
                    "source": r.scope.partition(":")[0],
                    "sample": r.scope.startswith("fixture:") or r.scope in sample_scopes
                    or r.id in sample_runs,
                }
                for r in runs
            ],
            "jobs": [
                {
                    **{k: getattr(j, k) for k in [
                        "id",
                        "scope",
                        "key",
                        "data",
                        "decision",
                        "reason",
                        "evidence",
                        "contact",
                        "resume",
                        "resume_name",
                        "resume_at",
                        "run_id",
                    ]},
                    "source": j.scope.partition(":")[0],
                    "sample": j.scope.startswith("fixture:") or j.scope in sample_scopes
                    or j.run_id in sample_runs,
                }
                for j in jobs
            ],
            "commands": [
                {
                    **{
                        k: getattr(c, k)
                        for k in ["id", "run_id", "job_key", "action", "status", "issued_at", "result"]
                    },
                    "scope": run_scope,
                    "source": run_scope.partition(":")[0],
                    "sample": run_scope.startswith("fixture:") or run_scope in sample_scopes
                    or c.run_id in sample_runs,
                }
                for c, run_scope in commands
            ],
            "counts": [
                {"run_id": r, "action": a, "count": n}
                for r, a, n in db.execute(
                    select(Command.run_id, Command.action, func.count())
                    .where(Command.status == "SUCCEEDED", Command.action.in_(flow.EXTERNAL))
                    .group_by(Command.run_id, Command.action)
                )
            ],
            "capabilities": [
                {k: getattr(c, k) for k in ["scope", "profile", "action", "status", "proof"]}
                for c in db.scalars(select(Capability))
            ],
            "fixture_enabled": fixture,
            "model": {
                "provider": "Jev" if os.getenv("AUTOJB_USE_JEV") == "true" else "本地规则",
                "configured": bool(os.getenv("TYPESAFE_API_KEY")),
                "live_verified": False,
            },
        }

    @app.post("/api/runs", dependencies=[Depends(is_admin)])
    def start(body: Start, db=Depends(db_session)):
        connection = db.get(Connection, body.connection_id)
        if not connection or connection.seen_at < time.time() - 15:
            raise HTTPException(409, "请先连接在线的浏览器页面")
        s = connection.snapshot
        if s["blocked"] or s["phase"] != "LIST":
            raise HTTPException(409, "请返回可识别的岗位列表，先处理页面提示")
        site_click = s["source"] in flow.CLICK_SOURCES
        if site_click and s.get("search_limited"):
            raise HTTPException(409, "当前职位页与扩展配置的北京搜索入口不一致")
        if site_click and body.send_resume:
            raise HTTPException(409, "当前点击任务不发送简历，请取消自动发送简历")
        if body.mode != "scan" and site_click and (
            not s.get("contact_click_ready") or not flow.site_click_profile(s)
        ):
            raise HTTPException(409, "当前招聘页面尚未就绪，无法执行点击任务")
        if body.mode != "scan" and not site_click and not s.get("send_ready", False):
            raise HTTPException(409, "当前样本页面未就绪")
        account_scope = flow.scope(s)
        if (body.expected_scope and body.expected_scope != account_scope) or (
            body.expected_profile and body.expected_profile != connection.profile
        ):
            raise HTTPException(409, "启动时账号或页面配置已变化，请重新核对")
        if body.mode != "scan" and not site_click and db.scalar(
            select(Command.id)
            .join(Run, Run.id == Command.run_id)
            .where(Run.scope == account_scope, Command.status == "UNKNOWN")
            .limit(1)
        ):
            raise HTTPException(409, "该账号存在未决发送，请先核验；新任务不能绕过旧账本")
        if db.scalar(select(Run).where(Run.scope == account_scope, Run.status.in_(flow.ACTIVE))):
            raise HTTPException(409, "同账号已有未结束任务，请继续或停止该任务")
        if body.mode == "auto" and not site_click:
            capability = db.scalar(
                select(Capability).where(
                    Capability.scope == account_scope,
                    Capability.profile == connection.profile,
                    Capability.action == "CONTACT",
                    Capability.status == "VERIFIED",
                )
            )
            if not capability:
                raise HTTPException(409, "先执行当前岗位受控验证，验证通过后启用批量沟通")
        if body.mode == "verify" and (not s["detail"] or s["selected_key"] != s["detail"]["key"]):
            raise HTTPException(409, "请先选中一个身份明确的岗位用于验证")
        if body.mode == "verify" and site_click:
            prior = db.scalar(select(Job).where(Job.scope == account_scope, Job.key == s["selected_key"]))
            if prior and prior.contact != "NOT_STARTED":
                raise HTTPException(409, "当前岗位已有点击或未决记录，请换一个未联系岗位；不会重复点击")
        previous = db.get(Run, body.previous_run) if body.previous_run else None
        if previous and (previous.scope != account_scope or previous.status in flow.ACTIVE):
            raise HTTPException(409, "不能跨账号续接或重复启动未结束任务")
        if body.previous_run and not previous:
            raise HTTPException(404, "待续接任务不存在")
        settings = {
            "send_resume": body.send_resume and not site_click,
            "resume_name": body.resume_name,
            "contact_interval_seconds": body.contact_interval_seconds,
            "done": [],
            "no_progress": 0,
        }
        if site_click:
            settings["cooldown_until"] = flow.site_contact_cooldown_until(
                db, account_scope, body.contact_interval_seconds
            )
        if previous and previous.mode == body.mode:
            settings["done"] = previous.settings.get("done", [])
        if body.mode == "verify":
            settings["active_key"] = s["selected_key"]
            settings["pinned_key"] = s["selected_key"]
        run = Run(
            scope=account_scope,
            connection_id=connection.id,
            profile=connection.profile,
            mode=body.mode,
            budget=1 if body.mode == "verify" else body.max_jobs,
            deadline=time.time() + body.minutes * 60,
            settings=settings,
        )
        if previous:
            run.campaign_id = previous.campaign_id
        db.add(run)
        db.flush()
        return {"id": run.id}

    @app.post("/api/runs/{run_id}/control", dependencies=[Depends(is_admin)])
    def control(run_id: str, body: Control, db=Depends(db_session)):
        run = db.scalar(select(Run).where(Run.id == run_id).with_for_update())
        if not run:
            raise HTTPException(404, "任务不存在")
        if body.action == "resume":
            if run.status not in ["PAUSED_USER", "WAITING_HUMAN"]:
                raise HTTPException(409, "只有暂停任务可以恢复")
            site_click_run = any(run.scope.startswith(f"{source}:") for source in flow.CLICK_SOURCES)
            if not site_click_run and db.scalar(
                select(Command).where(Command.run_id == run.id, Command.status == "UNKNOWN")
            ):
                raise HTTPException(409, "存在未决动作，请先核验并登记结果")
            current = db.get(Connection, run.connection_id)
            if not current:
                raise HTTPException(409, "招聘页已断开，请刷新该标签页并保持在前台后再恢复")
            now = time.time()
            # 扩展重载会换新的页面连接。同一账号、同一配置的新连接可以接上这轮任务。
            usable = [
                item for item in db.scalars(select(Connection).where(Connection.device_id == current.device_id))
                if item.seen_at >= now - 15
                and flow.scope(item.snapshot) == run.scope
                and item.profile == run.profile
            ]
            usable.sort(key=lambda item: (item.id == run.connection_id, item.seen_at), reverse=True)
            if not usable:
                raise HTTPException(409, "招聘页已断开，请刷新该标签页并保持在前台后再恢复")
            open_pages = [item for item in usable if not item.snapshot.get("blocked")]
            if not open_pages:
                raise HTTPException(409, usable[0].snapshot.get("blocked") or "页面无法操作")
            c = open_pages[0]
            if c.id != run.connection_id:
                run.connection_id = c.id
            if run.deadline <= time.time():
                raise HTTPException(409, "本批次已到期，请停止后创建续接批次")
            latest_command = db.scalar(
                select(Command).where(Command.run_id == run.id)
                .order_by(Command.issued_at.desc()).limit(1)
            )
            cfg = dict(run.settings)
            active_key = cfg.get("active_key", "")
            selection_cancelled = (
                latest_command
                and latest_command.action == "SELECT"
                and latest_command.status in {"FAILED", "CANCELLED"}
                and active_key == latest_command.job_key
            )
            site_selection_drifted = (
                any(run.scope.startswith(f"{source}:") for source in flow.CLICK_SOURCES)
                and run.mode == "auto"
                and active_key
                and (
                    c.snapshot["selected_key"] != active_key
                    or (c.snapshot.get("detail") or {}).get("key") != active_key
                )
            )
            if selection_cancelled or site_selection_drifted:
                # Resume restarts with a read-only SELECT. A cancelled command
                # never grants permission to contact the old active job.
                cfg["active_key"] = ""
                run.settings = cfg
            run.status, run.reason, run.epoch = "RUNNING", "", run.epoch + 1
        else:
            if run.status not in flow.ACTIVE:
                raise HTTPException(409, "任务已经结束")
            flow.pause(db, run, "用户暂停" if body.action == "pause" else "用户停止")
            run.status = "PAUSED_USER" if body.action == "pause" else "STOPPED"
        return {"status": run.status, "stopping": run.lease_until > time.time()}

    def owned_connection(db, dev, connection_id):
        connection = db.get(Connection, connection_id)
        if not connection or connection.device_id != dev.id:
            raise HTTPException(403, "该页面不属于当前扩展")
        return connection

    @app.get("/api/device/state")
    def device_state(dev=Depends(device), db=Depends(db_session)):
        view = state(db)
        ids = set(db.scalars(select(Connection.id).where(Connection.device_id == dev.id)))
        view["connections"] = [c for c in view["connections"] if c["id"] in ids]
        view["runs"] = [r for r in view["runs"] if r["connection_id"] in ids]
        scopes = {f"{c['source']}:{c['account']}" for c in view["connections"]}
        run_ids = {r["id"] for r in view["runs"]}
        view["jobs"] = [j for j in view["jobs"] if j["scope"] in scopes]
        view["capabilities"] = [c for c in view["capabilities"] if c["scope"] in scopes]
        view["commands"] = [c for c in view["commands"] if c["run_id"] in run_ids]
        view["counts"] = [c for c in view["counts"] if c["run_id"] in run_ids]
        return view

    @app.post("/api/device/runs")
    def device_start(body: Start, dev=Depends(device), db=Depends(db_session)):
        owned_connection(db, dev, body.connection_id)
        return start(body, db)

    @app.post("/api/device/runs/{run_id}/control")
    def device_control(run_id: str, body: Control, dev=Depends(device), db=Depends(db_session)):
        run = db.get(Run, run_id)
        if not run:
            raise HTTPException(404, "任务不存在")
        owned_connection(db, dev, run.connection_id)
        return control(run_id, body, db)

    @app.post("/api/bridge/tick")
    def tick(body: Snapshot, dev=Depends(device), db=Depends(db_session)):
        connection, snap = observe(db, dev, body)
        return {"connection_id": connection.id, **flow.plan(db, connection, snap)}

    @app.post("/api/bridge/commands/{command_id}/claim")
    def claim(command_id: str, body: Snapshot, dev=Depends(device), db=Depends(db_session)):
        connection, snap = observe(db, dev, body)
        return flow.claim(db, command_id, connection, snap)

    @app.post("/api/bridge/commands/{command_id}/result")
    def finish(command_id: str, body: Result, dev=Depends(device), db=Depends(db_session)):
        connection, _ = observe(db, dev, body.snapshot)
        cmd = db.get(Command, command_id)
        if not cmd:
            raise HTTPException(404, "命令不存在")
        flow.finish(db, cmd, connection, body.model_dump())
        return {"status": cmd.status}

    @app.post("/api/bridge/halt")
    def halt(body: Snapshot, dev=Depends(device), db=Depends(db_session)):
        connection, _ = observe(db, dev, body)
        run = db.scalar(
            select(Run)
            .where(Run.connection_id == connection.id, Run.status == "RUNNING")
            .with_for_update()
        )
        if run:
            flow.pause(db, run, "用户操作页面或扩展重新启动，请核对后继续")
        return {"ok": True}

    def resolve_unknown(command_id: str, body: Resolve, db):
        cmd = db.get(Command, command_id)
        if not cmd or cmd.status != "UNKNOWN":
            raise HTTPException(409, "仅能登记结果未知的动作")
        if cmd.action not in flow.EXTERNAL:
            raise HTTPException(400, "仅能登记沟通或简历动作")
        run = db.scalar(select(Run).where(Run.id == cmd.run_id).with_for_update())
        db.refresh(cmd)
        if cmd.status != "UNKNOWN":
            raise HTTPException(409, "结果已被登记，不能覆盖")
        expected = "CONTACT_INITIATED" if cmd.action == "CONTACT" else "SENT"
        if body.outcome not in ["NO_EFFECT", expected]:
            raise HTTPException(400, "结果与动作类型不符")
        job = flow.job_for(db, run, cmd.job_key)
        if not job:
            raise HTTPException(409, "对应岗位记录不存在")
        setattr(
            job,
            "contact" if cmd.action == "CONTACT" else "resume",
            expected if body.outcome == expected else "FAILED",
        )
        cmd.status = "MANUALLY_RESOLVED"
        cmd.result = {"manual": True, "outcome": body.outcome, "note": body.note, "at": time.time()}
        return {"ok": True}

    @app.post("/api/commands/{command_id}/resolve", dependencies=[Depends(is_admin)])
    def resolve(command_id: str, body: Resolve, db=Depends(db_session)):
        return resolve_unknown(command_id, body, db)

    @app.post("/api/device/commands/{command_id}/resolve")
    def device_resolve(command_id: str, body: Resolve, dev=Depends(device), db=Depends(db_session)):
        cmd = db.get(Command, command_id)
        if not cmd:
            raise HTTPException(404, "命令不存在")
        run = db.get(Run, cmd.run_id)
        owned_connection(db, dev, run.connection_id)
        return resolve_unknown(command_id, body, db)

    @app.get("/api/extension.zip", dependencies=[Depends(is_admin)])
    def download():
        stream = io.BytesIO()
        folder = ROOT / "dist/extension"
        if not folder.exists():
            raise HTTPException(404, "请先构建扩展")
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in folder.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(folder))
        return Response(
            stream.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=auto-jb-extension.zip"},
        )

    @app.get("/fixture")
    def fixture_page():
        if not fixture:
            raise HTTPException(404)
        return FileResponse(ROOT / "fixtures/boss.html")

    web = ROOT / "dist/web"
    if web.exists():
        app.mount("/", StaticFiles(directory=web, html=True), name="web")
    return app


# Uvicorn imports only in a configured runtime. Unit tests use the app factory.
if os.getenv("AUTOJB_ADMIN_TOKEN"):
    app = create_app()
