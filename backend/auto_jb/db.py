import os
import time
import uuid

from sqlalchemy import JSON, Float, Index, Integer, String, UniqueConstraint, create_engine, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def uid():
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    token_hash: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String, default="本机 Chrome")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class Pairing(Base):
    __tablename__ = "pairings"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    code_hash: Mapped[str] = mapped_column(String)
    expires: Mapped[float] = mapped_column(Float)
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class Connection(Base):
    __tablename__ = "connections"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    device_id: Mapped[str] = mapped_column(String)
    source: Mapped[str] = mapped_column(String)
    account: Mapped[str] = mapped_column(String)
    profile: Mapped[str] = mapped_column(String)
    snapshot: Mapped[dict] = mapped_column(JSON)
    seen_at: Mapped[float] = mapped_column(Float, default=time.time)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    campaign_id: Mapped[str] = mapped_column(String, default=uid)
    scope: Mapped[str] = mapped_column(String)
    connection_id: Mapped[str] = mapped_column(String)
    profile: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="RUNNING")
    mode: Mapped[str] = mapped_column(String)
    reason: Mapped[str] = mapped_column(String, default="")
    epoch: Mapped[int] = mapped_column(Integer, default=1)
    budget: Mapped[int] = mapped_column(Integer, default=20)
    visited: Mapped[int] = mapped_column(Integer, default=0)
    deadline: Mapped[float] = mapped_column(Float)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    lease_until: Mapped[float] = mapped_column(Float, default=0)
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    __table_args__ = (
        Index(
            "one_active_scope",
            "scope",
            unique=True,
            postgresql_where=text("status IN ('RUNNING','PAUSED_USER','WAITING_HUMAN')"),
            sqlite_where=text("status IN ('RUNNING','PAUSED_USER','WAITING_HUMAN')"),
        ),
    )


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    scope: Mapped[str] = mapped_column(String)
    key: Mapped[str] = mapped_column(String)
    data: Mapped[dict] = mapped_column(JSON)
    decision: Mapped[str] = mapped_column(String, default="PENDING")
    reason: Mapped[str] = mapped_column(String, default="等待详情")
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    policy: Mapped[str] = mapped_column(String, default="ai-product-v2")
    fingerprint: Mapped[str] = mapped_column(String, default="")
    contact: Mapped[str] = mapped_column(String, default="NOT_STARTED")
    resume: Mapped[str] = mapped_column(String, default="NOT_CHECKED")
    run_id: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    __table_args__ = (UniqueConstraint("scope", "key"),)


class Command(Base):
    __tablename__ = "commands"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(String)
    job_key: Mapped[str] = mapped_column(String, default="")
    action: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="ISSUED")
    epoch: Mapped[int] = mapped_column(Integer)
    binding: Mapped[dict] = mapped_column(JSON)
    issued_at: Mapped[float] = mapped_column(Float, default=time.time)
    expires: Mapped[float] = mapped_column(Float)
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class Capability(Base):
    __tablename__ = "capabilities"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    scope: Mapped[str] = mapped_column(String)
    profile: Mapped[str] = mapped_column(String)
    action: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="UNVERIFIED")
    proof: Mapped[str] = mapped_column(String)
    __table_args__ = (UniqueConstraint("scope", "profile", "action"),)


def database(url=None):
    url = url or os.getenv("DATABASE_URL", "sqlite:///./.runtime/dev.sqlite")
    engine = create_engine(
        url,
        pool_pre_ping=True,
        **({"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {}),
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(engine, expire_on_commit=False)
