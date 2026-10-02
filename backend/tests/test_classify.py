import pytest
from auto_jb.classify import classify, jev


@pytest.mark.parametrize(
    "title,description,city,expected",
    [
        ("AI产品总监（技术背景）", "负责产品战略", "北京", "INCLUDE"),
        ("AIGC产品负责人", "", "北京·海淀区", "INCLUDE"),
        ("智能体产品运营", "", "北京", "INCLUDE"),
        ("产品经理", "负责大模型应用产品设计与迭代", "北京", "INCLUDE"),
        ("算法工程师", "训练模型，为公司产品提供支持", "北京", "EXCLUDE"),
        ("世界模型-AIGC视频生成大模型算法工程师", "和工程、产品、数据团队协同，完成模型训练、效果调优，支撑大模型底座与 C 端产品的技术落地", "北京", "EXCLUDE"),
        ("AI技术专家", "有参与技术战略、产品规划或技术架构师等研发工作", "北京", "NEEDS_REVIEW"),
        ("行业总监（能源/政企）华南区", "推动AI大模型产品迭代优化", "北京", "NEEDS_REVIEW"),
        ("智能业务负责人", "负责大模型应用产品设计与迭代", "北京", "INCLUDE"),
        ("AI产品专家", "负责智能体产品落地", "北京", "INCLUDE"),
        ("软件产品经理（侧重AIoT）", "", "北京", "INCLUDE"),
        ("AI产品经理", "", "上海", "EXCLUDE"),
        ("AI产品经理", "", "", "NEEDS_REVIEW"),
        ("AI产品经理", "", "北京/上海", "NEEDS_REVIEW"),
        ("产品经理", "公司介绍：AI行业领军企业。负责传统电商业务。", "北京", "NEEDS_REVIEW"),
        ("智能业务负责人", "拓展业务", "北京", "NEEDS_REVIEW"),
        ("AI产品经理", "职责不涉及AI产品，岗位名称仅作引流", "北京", "NEEDS_REVIEW"),
    ],
)
def test_broad_scope_and_actual_workplace(monkeypatch, title, description, city, expected):
    monkeypatch.setenv("AUTOJB_USE_JEV", "false")
    result = classify({"title": title, "description": description, "city": city})
    assert result["decision"] == expected


def test_jev_missing_key_is_not_automatic_approval(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert jev({"0": "智能业务负责人"})["decision"] == "NEEDS_REVIEW"


def test_jev_invalid_evidence_never_fabricates_text(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "answers": {
                    "relevance": {"choice": "INCLUDE", "confidence": 0.99},
                    "evidence": {"choice": "9999", "confidence": 0.99},
                }
            }

    monkeypatch.setattr("auto_jb.classify.httpx.post", lambda *a, **k: Response())
    result = jev({"0": "原始岗位片段"})
    assert result["decision"] == "NEEDS_REVIEW"
    assert result["evidence"] == []
