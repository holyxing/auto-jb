from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Card(Strict):
    key: str = Field(min_length=1, max_length=200)
    title: str = Field(max_length=300)
    company: str = Field(default="", max_length=200)
    city: str = Field(default="", max_length=200)


class Detail(Card):
    description: str = Field(default="", max_length=16000)
    recruiter: str = Field(default="", max_length=200)
    contact_button: Literal["READY", "ALREADY_CONTACTED", "MISSING", "DISABLED"] = "MISSING"


class Chat(Strict):
    key: str = Field(max_length=200)
    conversation: str = Field(default="", max_length=200)
    contact: Literal["CHAT_OPENED", "CONTACT_INITIATED", "ALREADY_CONTACTED", "UNKNOWN"] = "CHAT_OPENED"
    resume: Literal["NOT_CHECKED", "READY", "WAITING_PEER", "UNAVAILABLE", "SENT", "UNKNOWN"] = "NOT_CHECKED"
    resume_name: str = Field(default="", max_length=200)
    evidence: str = Field(default="", max_length=800)
    contact_at: float = Field(default=0, ge=0, allow_inf_nan=False)
    resume_at: float = Field(default=0, ge=0, allow_inf_nan=False)


class Snapshot(Strict):
    source: Literal["fixture", "boss", "liepin"]
    account: str = Field(min_length=1, max_length=200)
    session: str = Field(min_length=1, max_length=100)
    tab: int
    document: str = Field(min_length=1, max_length=100)
    profile: str = Field(min_length=1, max_length=120)
    url: str = Field(max_length=1000)
    selection_epoch: int = Field(ge=0)
    phase: Literal["LIST", "CHAT", "BLOCKED"]
    cards: list[Card] = Field(default_factory=list, max_length=100)
    detail: Detail | None = None
    chat: Chat | None = None
    blocked: str = Field(default="", max_length=300)
    list_end: bool = False
    loading: bool = False
    list_signature: str = Field(default="", max_length=500)
    selected_key: str = Field(default="", max_length=200)
    send_ready: bool = False
    contact_click_ready: bool = False
    search_limited: bool = False


class Start(Strict):
    connection_id: str
    expected_scope: str | None = None
    expected_profile: str | None = None
    mode: Literal["scan", "verify", "auto"] = "scan"
    max_jobs: int = Field(default=20, ge=1, le=200)
    minutes: int = Field(default=30, ge=1, le=120)
    contact_interval_seconds: int = Field(default=5, ge=5, le=120)
    send_resume: bool = False
    resume_name: str = Field(default="", max_length=200)
    previous_run: str | None = None


class Result(Strict):
    outcome: Literal["OK", "NO_EFFECT", "UNKNOWN", "BLOCKED"]
    snapshot: Snapshot
    note: str = Field(default="", max_length=500)
    click_dispatched: bool = False
    effect_observed: bool = False


class Control(Strict):
    action: Literal["pause", "resume", "stop"]


class Pair(Strict):
    code: str = Field(min_length=8, max_length=100)
    name: str = Field(default="本机 Chrome", max_length=100)


class Resolve(Strict):
    outcome: Literal["CONTACT_INITIATED", "SENT", "NO_EFFECT"]
    note: str = Field(min_length=5, max_length=500)
