import pytest
from auto_jb.main import create_app
from fastapi.testclient import TestClient

ADMIN = "test-only-admin-token-not-for-deployment"


@pytest.fixture
def system(tmp_path):
    app = create_app(f"sqlite:///{tmp_path}/test.db", ADMIN, True)
    with TestClient(app) as client:
        admin = {"Authorization": f"Bearer {ADMIN}"}
        code = client.post("/api/pair-code", headers=admin).json()["code"]
        pair = client.post("/api/pair", json={"code": code}).json()
        bridge = {"Authorization": f"Bearer {pair['token']}"}
        yield client, admin, bridge, app


def snapshot(key="director"):
    card = {"key": key, "title": "AI产品总监（技术背景）", "company": "测试企业", "city": "北京"}
    return {
        "source": "fixture",
        "account": "test-account",
        "session": "browser-1",
        "tab": 1,
        "document": "doc-1",
        "profile": "fixture-v1",
        "url": "http://127.0.0.1:17830/fixture",
        "selection_epoch": 1,
        "phase": "LIST",
        "cards": [card],
        "selected_key": key,
        "detail": {**card, "description": "负责AI产品规划和产品迭代", "contact_button": "READY"},
        "chat": None,
        "blocked": "",
        "list_end": True,
        "loading": False,
        "list_signature": key,
        "send_ready": True,
        "search_limited": False,
    }


def start_verify(system, snap=None, **kwargs):
    client, admin, bridge, _ = system
    snap = snap or snapshot()
    connection = client.post("/api/bridge/tick", headers=bridge, json=snap).json()["connection_id"]
    response = client.post(
        "/api/runs", headers=admin, json={"connection_id": connection, "mode": "verify", **kwargs}
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["id"]
    command = client.post("/api/bridge/tick", headers=bridge, json=snap).json()["command"]
    return run_id, command, snap, connection
