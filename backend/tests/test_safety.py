import copy
import time

from auto_jb.db import Command, Run
from conftest import snapshot, start_verify
from sqlalchemy import select


def elapsed_boss_cooldown(app, command_id):
    with app.state.factory.begin() as db:
        command = db.get(Command, command_id)
        command.result = {**command.result, "click_recorded_at": time.time() - 6}


def test_auth_and_cross_origin(system):
    c, a, b, _ = system
    assert c.get("/api/state").status_code == 401
    assert c.get("/api/state", headers=b).status_code == 401
    assert c.get("/api/state", headers={**a, "Origin": "https://attacker.example"}).status_code == 403


def test_pair_code_one_use_and_five_attempts(system):
    c, a, _, _ = system
    code = c.post("/api/pair-code", headers=a).json()["code"]
    for _ in range(5):
        assert c.post("/api/pair", json={"code": "invalid00"}).status_code == 403
    assert c.post("/api/pair", json={"code": code}).status_code == 403
    code = c.post("/api/pair-code", headers=a).json()["code"]
    assert c.post("/api/pair", json={"code": code}).status_code == 200
    assert c.post("/api/pair", json={"code": code}).status_code == 403


def test_single_account_lock(system):
    c, a, b, _ = system
    _, _, snap, connection = start_verify(system)
    assert c.post("/api/runs", headers=a, json={"connection_id": connection}).status_code == 409
    another = {**snap, "tab": 2}
    connection2 = c.post("/api/bridge/tick", headers=b, json=another).json()["connection_id"]
    assert c.post("/api/runs", headers=a, json={"connection_id": connection2}).status_code == 409


def test_claim_once_and_stale_detail(system):
    c, _, b, _ = system
    _, cmd, snap, _ = start_verify(system)
    stale = copy.deepcopy(snap)
    stale["detail"]["key"] = "someone-else"
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=stale).status_code == 409
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap).status_code == 200
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap).status_code == 409


def test_pause_revokes_issued_action(system):
    c, a, b, _ = system
    run, cmd, snap, _ = start_verify(system)
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "pause"}).status_code == 200
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap).status_code == 409


def test_claimed_pause_remains_unknown_until_reconciled(system):
    c, a, b, _ = system
    run, cmd, snap, _ = start_verify(system)
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    c.post(f"/api/runs/{run}/control", headers=a, json={"action": "pause"})
    state = c.get("/api/state", headers=a).json()
    assert state["jobs"][0]["contact"] == "UNKNOWN"
    assert state["jobs"][0]["sample"] is True
    assert state["commands"][0]["sample"] is True
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "resume"}).status_code == 409
    assert (
        c.post(
            f"/api/device/commands/{cmd['id']}/resolve",
            headers=b,
            json={"outcome": "NO_EFFECT", "note": "已在正确会话核对，没有发送记录"},
        ).status_code
        == 200
    )
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "resume"}).status_code == 200
    assert c.get("/api/state", headers=a).json()["jobs"][0]["contact"] == "FAILED"


def test_device_cannot_resolve_another_extensions_command(system):
    c, a, b, _ = system
    _, cmd, snap, _ = start_verify(system)
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    code = c.post("/api/pair-code", headers=a).json()["code"]
    other = c.post("/api/pair", json={"code": code}).json()["token"]
    response = c.post(
        f"/api/device/commands/{cmd['id']}/resolve",
        headers={"Authorization": f"Bearer {other}"},
        json={"outcome": "NO_EFFECT", "note": "不能处理另一扩展的岗位记录"},
    )
    assert response.status_code == 403


def test_unknown_action_remains_visible_after_recent_history_limit(system):
    c, a, b, app = system
    run, cmd, snap, connection = start_verify(system)
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    c.post(f"/api/runs/{run}/control", headers=a, json={"action": "pause"})
    now = time.time()
    with app.state.factory.begin() as db:
        for index in range(101):
            newer = Run(
                scope=f"fixture:history-{index}", connection_id=connection,
                profile="fixture-v1", mode="scan", status="COMPLETED",
                deadline=now, created_at=now + index + 1,
            )
            db.add(newer)
            db.flush()
            db.add(Command(
                run_id=newer.id, action="SELECT", status="SUCCEEDED", epoch=1,
                binding={}, expires=now, issued_at=now + index + 1,
            ))
    state = c.get("/api/device/state", headers=b).json()
    assert any(item["id"] == run for item in state["runs"])
    assert any(item["id"] == cmd["id"] and item["status"] == "UNKNOWN" for item in state["commands"])


def finish_contact(system, state="CONTACT_INITIATED", key="director"):
    c, a, b, _ = system
    run, cmd, snap, connection = start_verify(system)
    assert cmd["action"] == "CONTACT"
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    after = {
        **snap,
        "phase": "CHAT",
        "chat": {
            "key": key,
            "conversation": "chat-1",
            "contact_at": time.time(),
            "contact": state,
            "resume": "UNAVAILABLE",
            "evidence": "已发送默认招呼" if state == "CONTACT_INITIATED" else "",
        },
    }
    response = c.post(
        f"/api/bridge/commands/{cmd['id']}/result", headers=b, json={"outcome": "OK", "snapshot": after}
    )
    assert response.status_code == 200, response.text
    return c.get("/api/state", headers=a).json(), run, cmd, snap, connection


def test_open_chat_is_not_sent(system):
    state, *_ = finish_contact(system, "CHAT_OPENED")
    assert state["jobs"][0]["contact"] == "CHAT_OPENED"
    assert state["jobs"][0]["resume"] == "NOT_CHECKED"
    assert state["runs"][0]["status"] == "WAITING_HUMAN"
    assert not state["capabilities"]


def test_wrong_recipient_is_unknown(system):
    state, *_ = finish_contact(system, key="wrong-recipient")
    assert state["jobs"][0]["contact"] == "UNKNOWN"
    assert not state["capabilities"]


def test_contact_proof_does_not_prove_resume(system):
    state, *_ = finish_contact(system)
    assert state["runs"][0]["lease_until"] == 0
    assert state["jobs"][0]["contact"] == "CONTACT_INITIATED"
    assert state["jobs"][0]["resume"] == "NOT_CHECKED"
    assert [x["action"] for x in state["capabilities"]] == ["CONTACT"]
    assert state["capabilities"][0]["scope"].startswith("fixture:")


def test_fixture_capability_cannot_unlock_boss(system):
    c, a, b, _ = system
    state, run, _, snap, _ = finish_contact(system)
    c.post(f"/api/runs/{run}/control", headers=a, json={"action": "stop"})
    real = {**snap, "source": "boss", "url": "https://www.zhipin.com/web/geek/job", "tab": 2}
    connection = c.post("/api/bridge/tick", headers=b, json=real).json()["connection_id"]
    assert (
        c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "auto"}).status_code == 409
    )


def test_real_boss_read_only_scan_cannot_start_verification_or_send(system):
    c, a, b, _ = system
    snap = {**snapshot(), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
            "send_ready": False, "profile": "boss-read-v2"}
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    assert c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"}).status_code == 409
    assert c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "auto"}).status_code == 409
    forged = {**snap, "send_ready": True}
    c.post("/api/bridge/tick", headers=b, json=forged)
    assert c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"}).status_code == 409
    assert c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "scan"}).status_code == 200


def test_boss_click_task_completes_without_claiming_message_delivery(system):
    c, a, b, _ = system
    snap = {
        **snapshot(), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    }
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    rejected = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify", "send_resume": True,
    })
    assert rejected.status_code == 409
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify",
    }).json()["id"]
    cmd = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    assert cmd["action"] == "CONTACT"
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap).status_code == 200
    result = c.post(f"/api/bridge/commands/{cmd['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": snap, "click_dispatched": True,
    })
    assert result.json()["status"] == "SUCCEEDED"
    state = c.get("/api/state", headers=a).json()
    job = next(j for j in state["jobs"] if j["scope"] == "boss:test-account")
    assert job["contact"] == "CLICKED"
    assert job["resume"] == "NOT_CHECKED"
    assert next(r for r in state["runs"] if r["id"] == run)["status"] == "COMPLETED"
    assert c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify",
    }).status_code == 409


def test_boss_clicked_job_is_preserved_when_post_click_dialog_cannot_close(system):
    c, a, b, _ = system
    snap = {
        **snapshot(), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    }
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify",
    }).json()["id"]
    cmd = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap).status_code == 200
    result = c.post(f"/api/bridge/commands/{cmd['id']}/result", headers=b, json={
        "outcome": "UNKNOWN", "snapshot": snap,
        "note": "沟通后弹层状态未知，需要人工核对", "click_dispatched": True,
    })
    assert result.json()["status"] == "SUCCEEDED"
    state = c.get("/api/state", headers=a).json()
    job = next(j for j in state["jobs"] if j["scope"] == "boss:test-account")
    assert job["contact"] == "CLICKED"
    assert next(r for r in state["runs"] if r["id"] == run)["status"] == "WAITING_HUMAN"


def test_boss_unknown_click_is_quarantined_without_blocking_other_jobs(system):
    c, a, b, app = system
    snap = {
        **snapshot(), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    }
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"}).json()["id"]
    cmd = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    c.post(f"/api/bridge/commands/{cmd['id']}/result", headers=b, json={
        "outcome": "UNKNOWN", "snapshot": snap, "click_dispatched": False,
    })
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "stop"}).status_code == 200
    other = snapshot("new-job")
    other.update({key: snap[key] for key in ["source", "url", "send_ready", "contact_click_ready", "profile"]})
    c.post("/api/bridge/tick", headers=b, json=other)
    next_run = c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"})
    assert next_run.status_code == 200, next_run.text
    assert c.post("/api/bridge/tick", headers=b, json=other).json()["command"] is None
    with app.state.factory.begin() as db:
        db.get(Command, cmd["id"]).expires = time.time() - 6
    next_cmd = c.post("/api/bridge/tick", headers=b, json=other).json()["command"]
    assert next_cmd["job_key"] == "new-job"


def test_failed_boss_selection_preserves_reason_and_can_reselect_on_resume(system):
    c, a, b, app = system
    first = snapshot("first")
    second = {"key": "second", "title": "AI产品经理", "company": "测试企业", "city": "北京"}
    first["cards"].append(second)
    first.update({
        "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    })
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "auto"}).json()["id"]
    selected = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert selected["action"] == "SELECT"
    selection_claim = c.post(f"/api/bridge/commands/{selected['id']}/claim", headers=b, json=first)
    assert selection_claim.json()["valid_for_ms"] == 3500
    c.post(f"/api/bridge/commands/{selected['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": first,
    })
    contact = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert contact["action"] == "CONTACT"
    contact_claim = c.post(f"/api/bridge/commands/{contact['id']}/claim", headers=b, json=first)
    assert contact_claim.json()["valid_for_ms"] == 2500
    c.post(f"/api/bridge/commands/{contact['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": first, "click_dispatched": True,
    })
    assert c.post("/api/bridge/tick", headers=b, json=first).json()["command"] is None
    elapsed_boss_cooldown(app, contact["id"])
    blocked_select = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert blocked_select["action"] == "SELECT" and blocked_select["job_key"] == "second"
    c.post(f"/api/bridge/commands/{blocked_select['id']}/claim", headers=b, json=first)
    c.post(f"/api/bridge/commands/{blocked_select['id']}/result", headers=b, json={
        "outcome": "NO_EFFECT", "snapshot": first, "note": "目标被遮挡",
    })
    with app.state.factory.begin() as db:
        task = db.get(Run, run)
        assert task.reason == "目标被遮挡"
        assert task.settings["active_key"] == ""
        # Prior releases left the failed selection as the active target.
        task.settings = {**task.settings, "active_key": "second"}
    c.post("/api/bridge/halt", headers=b, json=first)
    assert next(r for r in c.get("/api/state", headers=a).json()["runs"] if r["id"] == run)["reason"] == "目标被遮挡"
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "resume"}).status_code == 200
    retried = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert retried["action"] == "SELECT" and retried["job_key"] == "second"
    job = next(j for j in c.get("/api/state", headers=a).json()["jobs"] if j["key"] == "first")
    assert job["contact"] == "CLICKED"
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "stop"}).status_code == 200
    continued = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "previous_run": run,
    })
    assert continued.status_code == 200, continued.text
    next_command = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert next_command["action"] == "SELECT" and next_command["job_key"] == "second"


def test_cancelled_boss_selection_reselects_after_resume_instead_of_pausing(system):
    c, a, b, app = system
    first = snapshot("first")
    second = snapshot("second")
    first.update({
        "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    })
    first["cards"].append(second["cards"][0])
    first["list_signature"] = "first|second"
    second.update({key: first[key] for key in [
        "source", "url", "send_ready", "contact_click_ready", "profile", "cards", "list_signature",
    ]})
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 2,
    }).json()["id"]
    select_first = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert select_first["action"] == "SELECT" and select_first["job_key"] == "first"
    c.post("/api/bridge/halt", headers=b, json=second)
    with app.state.factory.begin() as db:
        assert db.get(Command, select_first["id"]).status == "CANCELLED"
        assert db.get(Run, run).settings["active_key"] == "first"
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "resume"}).status_code == 200
    reselect = c.post("/api/bridge/tick", headers=b, json=second).json()["command"]
    assert reselect["action"] == "SELECT" and reselect["job_key"] == "first"
    with app.state.factory.begin() as db:
        assert db.get(Run, run).status == "RUNNING"
    assert not [x for x in c.get("/api/state", headers=a).json()["commands"]
                if x["run_id"] == run and x["action"] == "CONTACT"]


def test_liepin_auto_click_is_scoped_once_and_keeps_five_second_gap(system):
    c, a, b, app = system
    first = snapshot("a:123")
    first.update({
        "source": "liepin", "url": "https://www.liepin.com/zhaopin/",
        "profile": "liepin:liepin-click-v2:v1", "send_ready": False,
        "contact_click_ready": True, "detail": None, "selected_key": "",
    })
    second = copy.deepcopy(first)
    second["selected_key"] = "a:123"
    second["detail"] = {
        **first["cards"][0], "description": "", "contact_button": "READY",
    }
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 1,
    }).json()["id"]
    selection = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert selection["action"] == "SELECT" and selection["job_key"] == "a:123"
    assert c.post(f"/api/bridge/commands/{selection['id']}/claim", headers=b, json=first).status_code == 200
    c.post(f"/api/bridge/commands/{selection['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": second,
    })
    contact = c.post("/api/bridge/tick", headers=b, json=second).json()["command"]
    assert contact["action"] == "CONTACT" and contact["job_key"] == "a:123"
    assert c.post(f"/api/bridge/commands/{contact['id']}/claim", headers=b, json=second).status_code == 200
    c.post(f"/api/bridge/commands/{contact['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": second, "click_dispatched": True,
        "effect_observed": True,
    })
    assert c.post("/api/bridge/tick", headers=b, json=second).json()["command"] is None
    with app.state.factory.begin() as db:
        assert db.get(Run, run).status == "RUNNING"
    elapsed_boss_cooldown(app, contact["id"])
    assert c.post("/api/bridge/tick", headers=b, json=second).json()["command"] is None
    assert next(r for r in c.get("/api/state", headers=a).json()["runs"] if r["id"] == run)["status"] == "COMPLETED"
    new_run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 1,
    }).json()["id"]
    assert c.post("/api/bridge/tick", headers=b, json=second).json()["command"] is None
    state = c.get("/api/state", headers=a).json()
    assert len([item for item in state["commands"] if item["action"] == "CONTACT" and item["job_key"] == "a:123"]) == 1
    assert next(r for r in state["runs"] if r["id"] == new_run)["visited"] == 0
    assert next(r for r in state["runs"] if r["id"] == run)["source"] == "liepin"
    assert next(j for j in state["jobs"] if j["key"] == "a:123")["source"] == "liepin"
    assert next(cmd for cmd in state["commands"] if cmd["id"] == contact["id"])["scope"] == "liepin:" + first["account"]


def test_liepin_nationwide_search_cannot_start_auto(system):
    c, a, b, _ = system
    snap = snapshot("a:123")
    snap.update({
        "source": "liepin", "url": "https://www.liepin.com/zhaopin/",
        "profile": "liepin:liepin-click-v2:v1", "send_ready": False,
        "contact_click_ready": False, "search_limited": True,
    })
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    response = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto",
    })
    assert response.status_code == 409
    assert "扩展配置的北京搜索入口" in response.json()["detail"]


def test_liepin_covered_button_is_recorded_as_no_effect_before_click(system):
    c, a, b, app = system
    first = snapshot("a:covered")
    first.update({
        "source": "liepin", "url": "https://www.liepin.com/zhaopin/",
        "profile": "liepin:liepin-click-v2:v1", "send_ready": False,
        "contact_click_ready": True,
    })
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify", "max_jobs": 1,
    }).json()["id"]
    command = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert command["action"] == "CONTACT"
    assert c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=first).status_code == 200
    response = c.post(f"/api/bridge/commands/{command['id']}/result", headers=b, json={
        "outcome": "NO_EFFECT", "snapshot": first, "click_dispatched": False,
        "note": "目标被遮挡",
    })
    assert response.status_code == 200
    with app.state.factory.begin() as db:
        assert db.get(Command, command["id"]).status == "FAILED"
        assert db.get(Run, run).status == "WAITING_HUMAN"
    state = c.get("/api/state", headers=a).json()
    assert next(job for job in state["jobs"] if job["key"] == "a:covered")["contact"] == "NOT_STARTED"


def test_liepin_click_without_visible_response_stops_before_next_job(system):
    c, a, b, app = system
    snap = snapshot("a:no-response")
    snap.update({
        "source": "liepin", "url": "https://www.liepin.com/zhaopin/",
        "profile": "liepin:liepin-click-v2:v1", "send_ready": False,
        "contact_click_ready": True,
    })
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify", "max_jobs": 1,
    }).json()["id"]
    command = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    assert command["action"] == "CONTACT"
    assert c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=snap).status_code == 200
    response = c.post(f"/api/bridge/commands/{command['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": snap, "click_dispatched": True,
        "effect_observed": False,
    })
    assert response.status_code == 200
    with app.state.factory.begin() as db:
        assert db.get(Command, command["id"]).status == "UNKNOWN"
        assert db.get(Run, run).status == "WAITING_HUMAN"
    assert c.post("/api/bridge/tick", headers=b, json=snap).json()["command"] is None
    state = c.get("/api/state", headers=a).json()
    assert next(job for job in state["jobs"] if job["key"] == "a:no-response")["contact"] == "UNKNOWN"


def test_liepin_already_contacted_detail_skips_and_continues(system):
    c, a, b, app = system
    first = snapshot("a:done")
    second_card = {"key": "a:next", "title": "AI产品经理", "company": "另一企业", "city": "北京"}
    first.update({
        "source": "liepin", "url": "https://www.liepin.com/zhaopin/",
        "profile": "liepin:liepin-click-v2:v1", "send_ready": False,
        "contact_click_ready": True, "list_end": False,
        "cards": [first["cards"][0], second_card],
        "list_signature": "a:done|a:next",
    })
    selected = copy.deepcopy(first)
    selected["selected_key"] = "a:done"
    selected["detail"] = {**first["cards"][0], "description": "", "contact_button": "READY"}
    already = copy.deepcopy(selected)
    already["detail"]["contact_button"] = "ALREADY_CONTACTED"
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 2,
    }).json()["id"]
    selection = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    c.post(f"/api/bridge/commands/{selection['id']}/claim", headers=b, json=first)
    c.post(f"/api/bridge/commands/{selection['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": selected,
    })
    contact = c.post("/api/bridge/tick", headers=b, json=selected).json()["command"]
    assert contact["action"] == "CONTACT" and contact["job_key"] == "a:done"
    c.post(f"/api/bridge/commands/{contact['id']}/claim", headers=b, json=selected)
    c.post(f"/api/bridge/commands/{contact['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": already, "click_dispatched": False,
        "effect_observed": False,
    })
    with app.state.factory.begin() as db:
        assert db.get(Command, contact["id"]).status == "SUCCEEDED"
        assert db.get(Run, run).status == "RUNNING"
    state = c.get("/api/state", headers=a).json()
    assert next(job for job in state["jobs"] if job["key"] == "a:done")["contact"] == "ALREADY_CONTACTED"
    nxt = c.post("/api/bridge/tick", headers=b, json=already).json()["command"]
    assert nxt["action"] == "SELECT" and nxt["job_key"] == "a:next"


def test_liepin_unknown_job_is_skipped_when_run_resumes(system):
    c, a, b, app = system
    first = snapshot("a:unknown")
    second_card = {"key": "a:next", "title": "AI产品经理", "company": "另一企业", "city": "北京"}
    first.update({
        "source": "liepin", "url": "https://www.liepin.com/zhaopin/",
        "profile": "liepin:liepin-click-v2:v1", "send_ready": False,
        "contact_click_ready": True, "list_end": False,
        "cards": [first["cards"][0], second_card],
        "list_signature": "a:unknown|a:next",
    })
    selected = copy.deepcopy(first)
    selected["selected_key"] = "a:unknown"
    selected["detail"] = {**first["cards"][0], "description": "", "contact_button": "READY"}
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 2,
    }).json()["id"]
    selection = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert selection["action"] == "SELECT"
    c.post(f"/api/bridge/commands/{selection['id']}/claim", headers=b, json=first)
    c.post(f"/api/bridge/commands/{selection['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": selected,
    })
    command = c.post("/api/bridge/tick", headers=b, json=selected).json()["command"]
    assert command["action"] == "CONTACT" and command["job_key"] == "a:unknown"
    c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=selected)
    c.post(f"/api/bridge/commands/{command['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": selected, "click_dispatched": True,
        "effect_observed": False,
    })
    with app.state.factory.begin() as db:
        assert db.get(Run, run).status == "WAITING_HUMAN"
    assert c.post(f"/api/runs/{run}/control", headers=a, json={"action": "resume"}).status_code == 200
    assert c.post("/api/bridge/tick", headers=b, json=selected).json()["command"] is None
    elapsed_boss_cooldown(app, command["id"])
    nxt = c.post("/api/bridge/tick", headers=b, json=selected).json()["command"]
    assert nxt["action"] == "SELECT" and nxt["job_key"] == "a:next"
    state = c.get("/api/state", headers=a).json()
    assert next(job for job in state["jobs"] if job["key"] == "a:unknown")["contact"] == "UNKNOWN"
    assert len([item for item in state["commands"] if item["job_key"] == "a:unknown" and item["action"] == "CONTACT"]) == 1


def test_boss_auto_moves_through_current_cards_and_clicks_each_once(system):
    c, a, b, app = system
    first = snapshot("first")
    second = snapshot("second")
    first.update({
        "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    })
    first["cards"].append(second["cards"][0])
    first["list_signature"] = "first|second"
    second.update({key: first[key] for key in [
        "source", "url", "send_ready", "contact_click_ready", "profile", "cards", "list_signature",
    ]})
    second["selection_epoch"] = first["selection_epoch"] + 1
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 2,
    }).json()["id"]

    def execute(snap, action, job_key):
        command = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
        assert (command["action"], command["job_key"]) == (action, job_key)
        claim = c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=snap)
        assert claim.status_code == 200
        return command

    select_first = execute(first, "SELECT", "first")
    c.post(f"/api/bridge/commands/{select_first['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": first,
    })
    contact_first = execute(first, "CONTACT", "first")
    c.post(f"/api/bridge/commands/{contact_first['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": first, "click_dispatched": True,
    })
    assert c.post("/api/bridge/tick", headers=b, json=first).json()["command"] is None
    elapsed_boss_cooldown(app, contact_first["id"])
    select_second = execute(first, "SELECT", "second")
    c.post(f"/api/bridge/commands/{select_second['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": second,
    })
    contact_second = execute(second, "CONTACT", "second")
    c.post(f"/api/bridge/commands/{contact_second['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": second, "click_dispatched": True,
    })
    assert c.post("/api/bridge/tick", headers=b, json=second).json()["command"] is None
    assert next(r for r in c.get("/api/state", headers=a).json()["runs"] if r["id"] == run)["status"] == "RUNNING"
    elapsed_boss_cooldown(app, contact_second["id"])
    assert c.post("/api/bridge/tick", headers=b, json=second).json()["command"] is None
    state = c.get("/api/state", headers=a).json()
    assert next(r for r in state["runs"] if r["id"] == run)["status"] == "COMPLETED"
    assert {j["key"] for j in state["jobs"] if j["contact"] == "CLICKED"} == {"first", "second"}
    assert len([x for x in state["commands"] if x["run_id"] == run and x["action"] == "CONTACT"]) == 2


def test_new_boss_batch_skips_prior_click_without_spending_budget(system):
    c, a, b, app = system
    first = snapshot("first")
    second = snapshot("second")
    first.update({
        "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    })
    first["cards"].append(second["cards"][0])
    first["list_signature"] = "first|second"
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"})
    contact = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert contact["action"] == "CONTACT" and contact["job_key"] == "first"
    c.post(f"/api/bridge/commands/{contact['id']}/claim", headers=b, json=first)
    c.post(f"/api/bridge/commands/{contact['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": first, "click_dispatched": True,
    })

    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 1,
    }).json()["id"]
    state = c.get("/api/state", headers=a).json()
    assert next(r for r in state["runs"] if r["id"] == run)["cooldown_until"] > time.time()
    assert c.post("/api/bridge/tick", headers=b, json=first).json()["command"] is None
    elapsed_boss_cooldown(app, contact["id"])
    next_cmd = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert next_cmd["action"] == "SELECT" and next_cmd["job_key"] == "second"
    state = c.get("/api/state", headers=a).json()
    assert next(r for r in state["runs"] if r["id"] == run)["visited"] == 0
    assert len([x for x in state["commands"] if x["job_key"] == "first" and x["action"] == "CONTACT"]) == 1


def test_boss_page_already_contacted_skips_without_contact_command(system):
    c, a, b, _ = system
    first = snapshot("first")
    second = snapshot("second")
    first.update({
        "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    })
    first["detail"]["contact_button"] = "ALREADY_CONTACTED"
    first["cards"].append(second["cards"][0])
    first["list_signature"] = "first|second"
    connection = c.post("/api/bridge/tick", headers=b, json=first).json()["connection_id"]
    run = c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "auto", "max_jobs": 1,
    }).json()["id"]
    select_first = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert select_first["action"] == "SELECT" and select_first["job_key"] == "first"
    c.post(f"/api/bridge/commands/{select_first['id']}/claim", headers=b, json=first)
    c.post(f"/api/bridge/commands/{select_first['id']}/result", headers=b, json={
        "outcome": "OK", "snapshot": first,
    })
    next_cmd = c.post("/api/bridge/tick", headers=b, json=first).json()["command"]
    assert next_cmd["action"] == "SELECT" and next_cmd["job_key"] == "second"
    state = c.get("/api/state", headers=a).json()
    assert next(j for j in state["jobs"] if j["key"] == "first")["contact"] == "ALREADY_CONTACTED"
    assert next(r for r in state["runs"] if r["id"] == run)["visited"] == 0
    assert not [x for x in state["commands"] if x["job_key"] == "first" and x["action"] == "CONTACT"]


def test_boss_claim_rechecks_prior_contact_command(system):
    c, a, b, app = system
    snap = {
        **snapshot("first"), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    }
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"})
    command = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    assert command["action"] == "CONTACT"
    with app.state.factory.begin() as db:
        past = Run(
            scope="boss:test-account", connection_id=connection,
            profile=snap["profile"], status="COMPLETED", mode="verify",
            deadline=time.time() - 1, settings={},
        )
        db.add(past)
        db.flush()
        db.add(Command(
            run_id=past.id, job_key="first", action="CONTACT", status="SUCCEEDED",
            epoch=1, binding={}, expires=time.time() - 1,
            result={"outcome": "OK", "click_dispatched": True},
        ))
    claim = c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=snap)
    assert claim.status_code == 409
    assert "历史沟通" in claim.json()["detail"]


def test_boss_claim_enforces_configured_account_cooldown(system):
    c, a, b, app = system
    snap = {
        **snapshot("second"), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
        "send_ready": False, "contact_click_ready": True,
        "profile": "test:boss-click-v1:abcdef123456",
    }
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    assert c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify", "contact_interval_seconds": 4,
    }).status_code == 422
    assert c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify", "contact_interval_seconds": 121,
    }).status_code == 422
    c.post("/api/runs", headers=a, json={
        "connection_id": connection, "mode": "verify", "contact_interval_seconds": 12,
    })
    command = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    with app.state.factory.begin() as db:
        past = Run(
            scope="boss:test-account", connection_id=connection,
            profile=snap["profile"], status="COMPLETED", mode="verify",
            deadline=time.time() - 1, settings={},
        )
        db.add(past)
        db.flush()
        db.add(Command(
            run_id=past.id, job_key="first", action="CONTACT", status="SUCCEEDED",
            epoch=1, binding={}, expires=time.time() - 1,
            result={"outcome": "OK", "click_dispatched": True, "click_recorded_at": time.time() - 6},
        ))
    claim = c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=snap)
    assert claim.status_code == 409
    assert "本轮间隔" in claim.json()["detail"]
    with app.state.factory.begin() as db:
        past = db.scalar(select(Run).where(Run.status == "COMPLETED", Run.scope == "boss:test-account"))
        previous = db.scalar(select(Command).where(Command.run_id == past.id))
        previous.result = {**previous.result, "click_recorded_at": time.time() - 13}
    assert c.post(f"/api/bridge/commands/{command['id']}/claim", headers=b, json=snap).status_code == 200


def test_other_search_cannot_start_even_read_only_scan(system):
    c, a, b, _ = system
    snap = {**snapshot(), "source": "boss", "url": "https://www.zhipin.com/web/geek/jobs",
            "send_ready": False, "search_limited": True, "profile": "boss-read-v2"}
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    response = c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "scan"})
    assert response.status_code == 409
    assert "扩展配置的北京搜索入口" in response.json()["detail"]


def test_expired_claim_and_account_change(system):
    c, a, b, app = system
    _, cmd, snap, _ = start_verify(system)
    with app.state.factory() as db:
        db.get(Command, cmd["id"]).expires = time.time() - 1
        db.commit()
    assert c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap).status_code == 409
    changed = {**snap, "account": "other-account"}
    c.post("/api/bridge/tick", headers=b, json=changed)
    assert c.get("/api/state", headers=a).json()["runs"][0]["status"] == "WAITING_HUMAN"


def test_scan_never_issues_contact(system):
    c, a, b, _ = system
    snap = snapshot()
    connection = c.post("/api/bridge/tick", headers=b, json=snap).json()["connection_id"]
    c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "scan"})
    select_cmd = c.post("/api/bridge/tick", headers=b, json=snap).json()["command"]
    assert select_cmd["action"] == "SELECT"
    c.post(f"/api/bridge/commands/{select_cmd['id']}/claim", headers=b, json=snap)
    c.post(
        f"/api/bridge/commands/{select_cmd['id']}/result", headers=b, json={"outcome": "OK", "snapshot": snap}
    )
    result = c.post("/api/bridge/tick", headers=b, json=snap).json()
    assert result["command"] is None
    assert result["status"] == "COMPLETED"
    assert all(x["action"] != "CONTACT" for x in c.get("/api/state", headers=a).json()["commands"])


def test_verification_does_not_move_to_other_job(system):
    c, a, b, _ = system
    snap = snapshot()
    snap["detail"]["city"] = "上海"
    snap["cards"].append({"key": "other", "title": "AI产品经理", "city": "北京", "company": "乙"})
    run, cmd, _, _ = start_verify(system, snap)
    assert cmd is None
    assert c.get("/api/state", headers=a).json()["runs"][0]["reason"] == "VERIFICATION_FINISHED"


def test_cannot_forge_fixture_origin(system):
    c, _, b, _ = system
    snap = snapshot()
    snap["url"] = "https://www.zhipin.com/fixture"
    assert c.post("/api/bridge/tick", headers=b, json=snap).status_code == 400


def test_resume_wrong_file_rejected(system):
    c, a, b, _ = system
    run, cmd, snap, _ = start_verify(system, send_resume=True, resume_name="指定简历.pdf")
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    after = {
        **snap,
        "phase": "CHAT",
        "chat": {
            "key": "director",
            "conversation": "chat-1",
            "contact_at": time.time(),
            "contact": "CONTACT_INITIATED",
            "resume": "READY",
            "resume_name": "其他简历.pdf",
            "evidence": "已发送招呼",
        },
    }
    c.post(f"/api/bridge/commands/{cmd['id']}/result", headers=b, json={"outcome": "OK", "snapshot": after})
    c.post("/api/bridge/tick", headers=b, json=after)
    assert c.get("/api/state", headers=a).json()["runs"][0]["status"] == "WAITING_HUMAN"
    assert all(x["action"] != "RESUME_SEND" for x in c.get("/api/state", headers=a).json()["commands"])


def test_result_is_immutable(system):
    c, _, b, _ = system
    _, _, cmd, snap, _ = finish_contact(system)
    assert (
        c.post(
            f"/api/bridge/commands/{cmd['id']}/result",
            headers=b,
            json={"outcome": "UNKNOWN", "snapshot": snap},
        ).status_code
        == 409
    )


def test_stopped_run_does_not_bypass_unknown_account_action(system):
    c, a, b, _ = system
    run, cmd, snap, connection = start_verify(system)
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    c.post(f"/api/runs/{run}/control", headers=a, json={"action": "stop"})
    assert c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "verify"}).status_code == 409
    assert c.post("/api/runs", headers=a, json={"connection_id": connection, "mode": "scan"}).status_code == 200


def test_historical_sent_message_is_not_current_success(system):
    c, a, b, _ = system
    _, cmd, snap, _ = start_verify(system)
    c.post(f"/api/bridge/commands/{cmd['id']}/claim", headers=b, json=snap)
    after = {
        **snap,
        "phase": "CHAT",
        "chat": {
            "key": "director",
            "conversation": "chat-1",
            "contact": "CONTACT_INITIATED",
            "contact_at": time.time() - 3600,
            "evidence": "历史已发送招呼",
        },
    }
    c.post(f"/api/bridge/commands/{cmd['id']}/result", headers=b, json={"outcome": "OK", "snapshot": after})
    state = c.get("/api/state", headers=a).json()
    assert state["jobs"][0]["contact"] == "UNKNOWN"
    assert state["capabilities"] == []


def test_shared_conversation_never_resends_resume(system):
    from auto_jb.db import Run
    from auto_jb.engine import resume_in_conversation

    c, a, b, app = system
    run, _, _, _ = start_verify(system)
    with app.state.factory() as db:
        current = db.get(Run, run)
        db.add(
            Command(
                run_id=run,
                job_key="other-job",
                action="RESUME_SEND",
                status="SUCCEEDED",
                epoch=1,
                binding={},
                expires=time.time(),
                result={"snapshot": {"chat": {"conversation": "shared-chat", "resume_name": "旧版本.pdf"}}},
            )
        )
        db.flush()
        assert resume_in_conversation(db, current, "shared-chat")
        assert not resume_in_conversation(db, current, "another-chat")


def test_extension_can_only_control_its_own_connections(system):
    c, a, b, _ = system
    run, _, _, connection = start_verify(system)
    assert c.get("/api/device/state", headers=b).json()["runs"][0]["id"] == run
    code = c.post("/api/pair-code", headers=a).json()["code"]
    token = c.post("/api/pair", json={"code": code}).json()["token"]
    other = {"Authorization": f"Bearer {token}"}
    state = c.get("/api/device/state", headers=other).json()
    assert state["connections"] == state["runs"] == state["commands"] == []
    assert c.post("/api/device/runs", headers=other, json={"connection_id": connection}).status_code == 403
    assert (
        c.post(f"/api/device/runs/{run}/control", headers=other, json={"action": "stop"}).status_code == 403
    )
    assert c.post(f"/api/device/runs/{run}/control", headers=b, json={"action": "stop"}).status_code == 200


def test_start_rejects_changed_account_display(system):
    c, a, b, _ = system
    s = snapshot()
    connection = c.post("/api/bridge/tick", headers=b, json=s).json()["connection_id"]
    assert (
        c.post(
            "/api/device/runs",
            headers=b,
            json={"connection_id": connection, "expected_scope": "fixture:another-account"},
        ).status_code
        == 409
    )
