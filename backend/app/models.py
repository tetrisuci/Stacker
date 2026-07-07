"""ORM models: replays, tracks, community timeframes (+ normalized tags).

Kept engine-portable (SQLite now, Postgres later): CHAR(36) uuid strings, no
JSON/JSONB columns, tags in a join table so tag filtering is plain SQL on both
engines. The track payload itself is an opaque gzipped JSON blob in the JS
placement-track contract (see reconstruct.FORMAT_VERSION) — the API slices it;
SQL never looks inside.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Replay(Base):
    __tablename__ = "replays"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # Dedupe key: re-uploading the same .ttr returns the existing record.
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    filename: Mapped[str] = mapped_column(String(255))
    gamemode: Mapped[str] = mapped_column(String(32))
    username: Mapped[str] = mapped_column(String(64))
    seed: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    bagtype: Mapped[str | None] = mapped_column(String(32), nullable=True)
    frames: Mapped[int] = mapped_column(Integer)
    duration_sec: Mapped[float] = mapped_column(Float)
    # The original file, kept so tracks can be regenerated on contract bumps.
    raw: Mapped[bytes] = mapped_column(LargeBinary)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    track: Mapped["Track | None"] = relationship(
        back_populates="replay", uselist=False, cascade="all, delete-orphan"
    )
    timeframes: Mapped[list["Timeframe"]] = relationship(
        back_populates="replay", cascade="all, delete-orphan"
    )


class Track(Base):
    """One reconstruction result per replay (JS placement-track contract)."""

    __tablename__ = "tracks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    replay_id: Mapped[str] = mapped_column(
        ForeignKey("replays.id"), unique=True, index=True
    )
    # Version of the placement-track JSON contract this blob was written with.
    format_version: Mapped[int] = mapped_column(Integer)
    piece_count: Mapped[int] = mapped_column(Integer)
    lines: Mapped[int] = mapped_column(Integer)
    # Where a partial (zenith) reconstruction was capped; null = full fidelity.
    drift_cap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # gzip(JSON {"placements": Placement[], "garbage": GarbageEvent[]}).
    data: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    replay: Mapped[Replay] = relationship(back_populates="track")


class Timeframe(Base):
    """A community-curated piece window within a replay's track."""

    __tablename__ = "timeframes"
    __table_args__ = (
        CheckConstraint("start_piece >= 0", name="ck_timeframe_start_nonneg"),
        CheckConstraint("end_piece >= start_piece", name="ck_timeframe_ordered"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    replay_id: Mapped[str] = mapped_column(ForeignKey("replays.id"), index=True)
    start_piece: Mapped[int] = mapped_column(Integer)
    end_piece: Mapped[int] = mapped_column(Integer)
    author: Mapped[str] = mapped_column(String(64))
    notes: Mapped[str] = mapped_column(Text, default="")
    upvotes: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    replay: Mapped[Replay] = relationship(back_populates="timeframes")
    tags: Mapped[list["TimeframeTag"]] = relationship(
        back_populates="timeframe", cascade="all, delete-orphan"
    )


class TimeframeTag(Base):
    """Normalized tag ("DT-cannon", "clean-4wide", …) for portable filtering."""

    __tablename__ = "timeframe_tags"

    timeframe_id: Mapped[str] = mapped_column(
        ForeignKey("timeframes.id"), primary_key=True
    )
    tag: Mapped[str] = mapped_column(String(48), primary_key=True, index=True)

    timeframe: Mapped[Timeframe] = relationship(back_populates="tags")
