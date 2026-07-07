"""Pydantic schemas — the wire contract, camelCased to match the JS shapes.

`Placement`, `GarbageEvent`, and engine snapshots come from the frontend's
`src/replay/reconstruct.ts` and are treated as opaque-but-versioned JSON: the
backend validates only the fields it needs (indexes, counts) and passes the
rest through untouched.
"""

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ---- replays / tracks ----


class ReplaySummary(ApiModel):
    id: str
    filename: str
    gamemode: str
    username: str
    seed: int | None
    bagtype: str | None
    frames: int
    duration_sec: float
    uploaded_at: datetime


class TrackSummary(ApiModel):
    format_version: int
    piece_count: int
    lines: int
    drift_cap: int | None


class ReplayIngestOut(ApiModel):
    replay: ReplaySummary
    track: TrackSummary


class TrackSlice(ApiModel):
    """Everything a training session needs for the window [start, end]."""

    format_version: int
    start_piece: int
    end_piece: int
    # Engine snapshot after piece `start - 1` (session seed); null when
    # start == 0 (the client seeds from its own pristine empty board).
    seed_snapshot: dict[str, Any] | None
    # JS `Placement[]` for the window, snapshots included (opaque).
    placements: list[dict[str, Any]]
    # JS `GarbageEvent[]` with `start < beforePiece <= end`.
    garbage: list[dict[str, Any]]


# ---- timeframes ----

TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


class TimeframeIn(ApiModel):
    replay_id: str
    start_piece: int = Field(ge=0)
    end_piece: int = Field(ge=0)
    author: str = Field(min_length=1, max_length=64)
    notes: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("tags")
    @classmethod
    def tags_are_slugs(cls, tags: list[str]) -> list[str]:
        deduped = sorted({t.lower() for t in tags})
        for t in deduped:
            if not TAG_RE.match(t):
                raise ValueError(
                    f"tag {t!r} must be a lowercase slug (letters/digits/hyphens)"
                )
        return deduped


class TimeframeOut(ApiModel):
    id: str
    replay: ReplaySummary
    start_piece: int
    end_piece: int
    author: str
    notes: str
    tags: list[str]
    upvotes: int
    created_at: datetime


class TimeframeList(ApiModel):
    items: list[TimeframeOut]
    total: int


class UpvoteOut(ApiModel):
    id: str
    upvotes: int
