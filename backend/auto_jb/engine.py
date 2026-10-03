import hashlib
import json
import time

from fastapi import HTTPException
from sqlalchemy import select

from .classify import POLICY, classify
from .db import Capability, Command, Job, Run

EXTERNAL = {"CONTACT", "RESUME_SEND"}
ACTIVE = {"RUNNING", "PAUSED_USER", "WAITING_HUMAN"}
SITE_CONTACT_INTERVAL_SECONDS = 5
CLICK_SOURCES = {"boss", "liepin"}


def contact_interval(run):
    return run.settings.get("contact_interval_seconds", SITE_CONTACT_INTERVAL_SECONDS)


def site_click_profile(snap):
    expected = "liepin-click-v2" if snap["source"] == "liepin" else "boss-click-v1"
    return f":{expected}:" in snap["profile"]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def scope(snap):
    return f"{snap['source']}:{snap['account']}"


def binding(snap):
    return {
        k: snap[k]
        for k in [
            "source",
            "account",
            "session",
            "tab",
            "document",
            "profile",
            "phase",
            "selection_epoch",
            "selected_key",
            "detail",
            "chat",
            "blocked",
            "list_signature",
            "send_ready",
            "contact_click_ready",
            "search_limited",
        ]
    }


def job_for(db, run, key):
    return db.scalar(select(Job).where(Job.scope == run.scope, Job.key == key))


def site_contact_history(db, account_scope):
    """Recover prior contact attempts by platform account and stable job ID."""
    rows = db.execute(
        select(Command.job_key, Command.status, Command.result)
        .join(Run, Run.id == Command.run_id)
        .where(Run.scope == account_scope, Command.action == "CONTACT")
    )
    prior = {}
    for key, status, result in rows:
        if not key:
            continue
        if status in {"UNKNOWN", "CLAIMED"}:
            prior[key] = "UNKNOWN"
        elif status == "SUCCEEDED" and prior.get(key) != "UNKNOWN":
            prior[key] = "CLICKED"
        elif (status == "MANUALLY_RESOLVED" and (result or {}).get("outcome") != "NO_EFFECT"
              and key not in prior):
            prior[key] = "ALREADY_CONTACTED"
    return prior


def site_contact_cooldown_until(db, account_scope, interval_seconds=SITE_CONTACT_INTERVAL_SECONDS):
    """Use server-side receipts; uncertain clicks wait past their full command window."""
    until = 0.0
    rows = db.scalars(
        select(Command)
        .join(Run, Run.id == Command.run_id)
        .where(Run.scope == account_scope, Command.action == "CONTACT")
    )
    for cmd in rows:
        result = cmd.result or {}
        if result.get("click_dispatched"):
            recorded_at = result.get("click_recorded_at")
            # Older receipts have no server-side click timestamp. The command
            # could have clicked until its expiry, so use that as a safe bound.
            anchor = recorded_at if isinstance(recorded_at, (int, float)) else cmd.expires
            until = max(until, anchor + interval_seconds)
        elif cmd.status in {"CLAIMED", "UNKNOWN"}:
            until = max(until, cmd.expires + interval_seconds)
    return until


def emit(db, run, snap, action, key=""):
    cmd = Command(
        run_id=run.id,
        job_key=key,
        action=action,
        epoch=run.epoch,
        binding=binding(snap),
        expires=time.time() + 15,
    )
    db.add(cmd)
    db.flush()
    return {
        "id": cmd.id,
        "action": action,
        "job_key": key,
        "epoch": run.epoch,
        "binding": cmd.binding,
        "expires": cmd.expires,
        "resume_name": run.settings.get("resume_name", ""),
    }


def pause(db, run, reason):
    run.status, run.reason, run.epoch = "WAITING_HUMAN", reason, run.epoch + 1
    for cmd in db.scalars(
        select(Command).where(Command.run_id == run.id, Command.status.in_(["ISSUED", "CLAIMED"]))
    ):
        if cmd.status == "CLAIMED" and cmd.action in EXTERNAL:
            cmd.status = "UNKNOWN"
            job = job_for(db, run, cmd.job_key)
            if job:
                setattr(job, "contact" if cmd.action == "CONTACT" else "resume", "UNKNOWN")
        else:
            cmd.status = "CANCELLED"


def cap(db, run, action):
    return db.scalar(
        select(Capability).where(
            Capability.scope == run.scope,
            Capability.profile == run.profile,
            Capability.action == action,
            Capability.status == "VERIFIED",
        )
    )


def resume_in_conversation(db, run, conversation):
    # A recruiter may reuse the same conversation for several job cards.
    history = db.scalars(
        select(Command)
        .join(Run, Run.id == Command.run_id)
        .where(
            Run.scope == run.scope,
            Command.action == "RESUME_SEND",
            Command.status.in_(["SUCCEEDED", "MANUALLY_RESOLVED"]),
        )
    )
    for previous in history:
        chat = previous.result.get("snapshot", {}).get("chat") or {}
        bound_chat = previous.binding.get("chat") or {}
        if (chat or bound_chat).get("conversation") == conversation and (
            previous.status == "SUCCEEDED" or previous.result.get("outcome") == "SENT"
        ):
            return True
    return False


def complete(run, reason):
    run.status, run.reason, run.epoch = "COMPLETED", reason, run.epoch + 1
    run.lease_until = 0


def plan(db, connection, snap):
    run = db.scalar(
        select(Run).where(Run.connection_id == connection.id, Run.status.in_(ACTIVE)).with_for_update()
    )
    if not run or run.status != "RUNNING":
        return {"command": None, "status": run.status if run else "IDLE"}
    if scope(snap) != run.scope or snap["profile"] != run.profile:
        pause(db, run, "账号或页面适配配置变化，请重新核对")
        return {"command": None, "status": run.status}
    if snap["blocked"] or snap["phase"] == "BLOCKED":
        pause(db, run, snap["blocked"] or "页面无法识别")
        return {"command": None, "status": run.status}
    pending = db.scalar(
        select(Command).where(Command.run_id == run.id, Command.status.in_(["ISSUED", "CLAIMED"]))
    )
    if pending:
        if pending.expires < time.time():
            pause(db, run, "执行回执超时；先核验结果，禁止重复发送")
        return {"command": None, "status": run.status}
    if run.deadline <= time.time():
        complete(run, "BUDGET_REACHED")
        return {"command": None, "status": run.status}
    if snap["source"] in CLICK_SOURCES and run.mode != "scan" and (
        site_contact_cooldown_until(db, run.scope, contact_interval(run)) > time.time()
    ):
        return {"command": None, "status": run.status}
    for card in snap["cards"]:
        job = job_for(db, run, card["key"])
        if not job:
            db.add(Job(scope=run.scope, key=card["key"], data=card))
    db.flush()
    site_auto = snap["source"] in CLICK_SOURCES and run.mode == "auto"
    prior_contacts = site_contact_history(db, run.scope) if snap["source"] in CLICK_SOURCES else {}
    cfg = dict(run.settings)
    active_key = cfg.get("active_key", "")
    if snap["phase"] == "CHAT":
        chat = snap.get("chat")
        if not chat or not active_key or chat["key"] != active_key:
            pause(db, run, "会话岗位与当前任务不一致")
            return {"command": None, "status": run.status}
        job = job_for(db, run, active_key)
        if job.contact not in ["CONTACT_INITIATED", "ALREADY_CONTACTED"]:
            pause(db, run, "聊天已打开但没有开聊成功证据，请核验")
            return {"command": None, "status": run.status}
        if chat["resume"] == "SENT" or resume_in_conversation(db, run, chat["conversation"]):
            if job.resume != "SENT":
                job.resume = "ALREADY_SENT"
        elif chat["resume"] in ["WAITING_PEER", "UNAVAILABLE"]:
            job.resume = chat["resume"]
        elif cfg.get("send_resume") and chat["resume"] == "READY" and job.resume in ["NOT_CHECKED", "READY"]:
            if not cfg.get("resume_name") or chat["resume_name"] != cfg["resume_name"]:
                pause(db, run, "待选择或核对要发送的站内简历")
                return {"command": None, "status": run.status}
            if run.mode != "verify" and not cap(db, run, "RESUME_SEND"):
                job.resume = "NOT_CHECKED"
            else:
                return {"command": emit(db, run, snap, "RESUME_SEND", active_key), "status": run.status}
        return {"command": emit(db, run, snap, "RESTORE", active_key), "status": run.status}
    detail = snap.get("detail")
    if active_key:
        if not detail or detail["key"] != active_key or snap["selected_key"] != active_key:
            pause(db, run, "左右岗位身份未同步，请核对页面")
            return {"command": None, "status": run.status}
        job = job_for(db, run, active_key)
        fingerprint = digest(detail)
        if job.fingerprint != fingerprint or job.policy != POLICY or job.decision == "PENDING":
            result = classify(detail)
            job.data, job.fingerprint, job.policy = detail, fingerprint, POLICY
            job.decision, job.reason, job.evidence = result["decision"], result["reason"], result["evidence"]
        if job.contact == "NOT_STARTED" and active_key in prior_contacts:
            job.contact = prior_contacts[active_key]
        actionable_site = (job.contact == "NOT_STARTED" and active_key not in prior_contacts
                           and detail["contact_button"] == "READY")
        if job.run_id != run.id:
            job.run_id = run.id
            if job.decision == "INCLUDE" and (not site_auto or actionable_site):
                run.visited += 1
        if job.decision == "INCLUDE" and run.mode != "scan" and job.contact == "NOT_STARTED":
            if detail["contact_button"] == "ALREADY_CONTACTED":
                job.contact = "ALREADY_CONTACTED"
            elif detail["contact_button"] == "READY":
                return {"command": emit(db, run, snap, "CONTACT", active_key), "status": run.status}
            elif snap["source"] == "liepin" and detail["contact_button"] in {"MISSING", "DISABLED"}:
                pause(db, run, "猎聘聊一聊按钮未显示或不可用，请核对当前岗位")
                return {"command": None, "status": run.status}
            else:
                job.reason = "沟通按钮不可用，未执行外部操作"
        done = list(cfg.get("done", []))
        if active_key not in done:
            done.append(active_key)
        cfg.update(active_key="", done=done)
        run.settings = cfg
    if run.mode == "verify" and cfg.get("pinned_key") in cfg.get("done", []):
        complete(run, "VERIFICATION_FINISHED")
        return {"command": None, "status": run.status}
    if run.visited >= run.budget:
        complete(run, "BUDGET_REACHED")
        return {"command": None, "status": run.status}
    done = set(cfg.get("done", []))
    skipped = []
    target = None
    for card in snap["cards"]:
        if card["key"] in done:
            continue
        job = job_for(db, run, card["key"])
        if site_auto and (job.contact != "NOT_STARTED" or card["key"] in prior_contacts):
            if job.contact == "NOT_STARTED":
                job.contact = prior_contacts[card["key"]]
            done.add(card["key"])
            skipped.append(card["key"])
            continue
        target = card
        break
    if skipped:
        cfg["done"] = list(dict.fromkeys([*cfg.get("done", []), *skipped]))
        run.settings = cfg
    if target:
        cfg["active_key"] = target["key"]
        run.settings = cfg
        return {"command": emit(db, run, snap, "SELECT", target["key"]), "status": run.status}
    if snap["loading"]:
        return {"command": None, "status": run.status}
    if snap["list_end"]:
        complete(run, "END_OF_VISIBLE_RESULTS")
        return {"command": None, "status": run.status}
    if cfg.get("no_progress", 0) >= 2:
        complete(run, "LIST_NO_PROGRESS")
        return {"command": None, "status": run.status}
    return {"command": emit(db, run, snap, "SCROLL"), "status": run.status}


def claim(db, command_id, connection, snap):
    cmd = db.get(Command, command_id)
    if not cmd:
        raise HTTPException(404, "命令不存在")
    run = db.scalar(select(Run).where(Run.id == cmd.run_id).with_for_update())
    db.refresh(cmd)
    if (
        run.connection_id != connection.id
        or run.status != "RUNNING"
        or cmd.status != "ISSUED"
        or cmd.epoch != run.epoch
        or cmd.expires < time.time()
        or run.deadline <= time.time()
    ):
        raise HTTPException(409, "命令失效或已经执行，禁止重放")
    if binding(snap) != cmd.binding or snap["blocked"]:
        raise HTTPException(409, "页面已变化，需要重新观察")
    if cmd.action in EXTERNAL:
        site_click = snap["source"] in CLICK_SOURCES and cmd.action == "CONTACT"
        if site_click:
            allowed = (snap.get("contact_click_ready", False) and not snap.get("search_limited")
                       and site_click_profile(snap) and run.mode != "scan")
        else:
            allowed = (snap["source"] == "fixture" and snap.get("send_ready", False)
                       and run.mode != "scan" and (run.mode == "verify" or cap(db, run, cmd.action)))
        if not allowed:
            raise HTTPException(409, "该账号和适配版本的发送能力尚未验证")
        job = job_for(db, run, cmd.job_key)
        if not job or job.decision != "INCLUDE":
            raise HTTPException(409, "岗位尚未通过范围核对")
        attr = "contact" if cmd.action == "CONTACT" else "resume"
        if getattr(job, attr) in [
            "UNKNOWN",
            "SENT",
            "ALREADY_SENT",
            "CONTACT_INITIATED",
            "ALREADY_CONTACTED",
            "CLICKED",
        ]:
            raise HTTPException(409, "重复或未决外部动作")
        if site_click and cmd.job_key in site_contact_history(db, run.scope):
            raise HTTPException(409, "该岗位已有历史沟通记录，禁止再次点击")
        if site_click and site_contact_cooldown_until(db, run.scope, contact_interval(run)) > time.time():
            raise HTTPException(409, "距上次沟通点击未达到本轮间隔，请等待")
        setattr(job, attr, "INITIATING" if cmd.action == "CONTACT" else "SENDING")
    cmd.status = "CLAIMED"
    # The BOSS contact click retains a 500 ms local click deadline. Its longer
    # lease is used only to close the observed post-click confirmation dialog.
    # External actions are never retried after uncertainty.
    valid_for = (
        3.5 if cmd.action in {"SELECT", "SCROLL"}
        else 7.0 if cmd.action == "CONTACT" and snap["source"] == "liepin"
        else 2.5 if cmd.action == "CONTACT" and snap["source"] == "boss"
        else 0.75
    )
    run.lease_until = time.time() + valid_for
    return {
        "allowed": True,
        "epoch": run.epoch,
        "valid_for_ms": int(valid_for * 1000),
        "valid_until": min(time.time() + valid_for, cmd.expires, run.deadline),
    }


def finish(db, cmd, connection, result):
    run = db.scalar(select(Run).where(Run.id == cmd.run_id).with_for_update())
    db.refresh(cmd)
    if run.connection_id != connection.id:
        raise HTTPException(403, "命令不属于当前浏览器")
    if cmd.status not in ["CLAIMED", "UNKNOWN"]:
        raise HTTPException(409, "不能覆盖已确认结果")
    snap = result["snapshot"]
    if (
        scope(snap) != run.scope
        or snap["profile"] != run.profile
        or snap["session"] != cmd.binding["session"]
        or snap["tab"] != cmd.binding["tab"]
    ):
        pause(db, run, "操作后账号或浏览器身份改变，结果未知")
        cmd.status = "UNKNOWN"
        return
    receipt = dict(result)
    if cmd.action == "CONTACT" and snap["source"] in CLICK_SOURCES and result.get("click_dispatched"):
        receipt["click_recorded_at"] = time.time()
    cmd.result = receipt
    run.lease_until = 0
    ok = result["outcome"] == "OK"
    job = job_for(db, run, cmd.job_key) if cmd.job_key else None
    if cmd.action in EXTERNAL:
        if cmd.action == "CONTACT" and snap["source"] in CLICK_SOURCES:
            effect_confirmed = (snap["source"] == "boss" or
                                (ok and result.get("effect_observed")))
            if result.get("click_dispatched") and effect_confirmed:
                # The scoped task ends at the DOM click. Message delivery and
                # resume attachment are deliberately left for human review.
                job.contact = "CLICKED"
                cmd.status = "SUCCEEDED"
                cfg = dict(run.settings)
                cfg["done"] = list(dict.fromkeys([*cfg.get("done", []), cmd.job_key]))
                cfg["active_key"] = ""
                cfg["cooldown_until"] = receipt["click_recorded_at"] + contact_interval(run)
                run.settings = cfg
                if not ok:
                    pause(db, run, "已点击但沟通后弹层未能安全关闭，请人工核对")
                elif run.mode == "verify":
                    complete(run, "VERIFICATION_FINISHED")
            elif (
                snap["source"] == "liepin"
                and ok
                and not result.get("click_dispatched")
                and (snap.get("detail") or {}).get("contact_button") == "ALREADY_CONTACTED"
            ):
                job.contact = "ALREADY_CONTACTED"
                cmd.status = "SUCCEEDED"
                cfg = dict(run.settings)
                cfg["done"] = list(dict.fromkeys([*cfg.get("done", []), cmd.job_key]))
                cfg["active_key"] = ""
                run.settings = cfg
            elif snap["source"] == "liepin" and result.get("click_dispatched"):
                job.contact = "UNKNOWN"
                cmd.status = "UNKNOWN"
                pause(db, run, "猎聘真实点击后未观察到会话或已沟通状态；已暂停，禁止自动重试")
            elif snap["source"] == "liepin" and result["outcome"] == "NO_EFFECT":
                job.contact = "NOT_STARTED"
                cmd.status = "FAILED"
                pause(db, run, result.get("note") or "猎聘点击前检查失败，尚未联系该岗位")
            else:
                job.contact = "UNKNOWN"
                cmd.status = "UNKNOWN"
                pause(db, run, "无法确认是否点击；该岗位禁止自动重试，请人工核对")
            return
        chat = snap.get("chat")
        match = bool(chat and chat["key"] == cmd.job_key and chat["conversation"] and chat["evidence"])
        if cmd.action == "CONTACT":
            success = (
                ok
                and match
                and chat["contact"] == "CONTACT_INITIATED"
                and (cmd.issued_at <= chat.get("contact_at", 0) <= time.time() + 2)
            )
            if success:
                job.contact = "CONTACT_INITIATED"
            elif ok and chat and chat["key"] == cmd.job_key and chat["contact"] == "CHAT_OPENED":
                job.contact = "CHAT_OPENED"
            else:
                job.contact = "UNKNOWN"
        else:
            success = (
                ok
                and match
                and chat["resume"] == "SENT"
                and chat["resume_name"] == run.settings.get("resume_name")
                and cmd.issued_at <= chat.get("resume_at", 0) <= time.time() + 2
                and chat["conversation"] == (cmd.binding.get("chat") or {}).get("conversation")
            )
            job.resume = "SENT" if success else "UNKNOWN"
        if success:
            cmd.status = "SUCCEEDED"
            if run.mode == "verify" and not cap(db, run, cmd.action):
                db.add(
                    Capability(
                        scope=run.scope,
                        profile=run.profile,
                        action=cmd.action,
                        status="VERIFIED",
                        proof=cmd.id,
                    )
                )
        else:
            cmd.status = "UNKNOWN"
            pause(db, run, "外部动作缺少成功证据；需只读核验，不能重新发送")
    elif ok:
        cmd.status = "SUCCEEDED"
        if cmd.action == "SELECT" and (
            not snap.get("detail")
            or snap["detail"]["key"] != cmd.job_key
            or snap["selected_key"] != cmd.job_key
        ):
            pause(db, run, "选择后右侧详情未同步")
        if cmd.action == "SCROLL":
            cfg = dict(run.settings)
            cfg["no_progress"] = (
                cfg.get("no_progress", 0) + 1
                if snap["list_signature"] == cmd.binding["list_signature"]
                else 0
            )
            run.settings = cfg
        if cmd.action == "RESTORE":
            cfg = dict(run.settings)
            cfg["done"] = list(dict.fromkeys([*cfg.get("done", []), cmd.job_key]))
            cfg["active_key"] = ""
            run.settings = cfg
    else:
        cmd.status = "FAILED"
        if cmd.action == "SELECT":
            cfg = dict(run.settings)
            if cfg.get("active_key") == cmd.job_key:
                cfg["active_key"] = ""
                run.settings = cfg
        pause(db, run, result.get("note") or "页面操作失败，请检查页面")
