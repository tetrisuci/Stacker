"""Wire schemas, camelCased for the JS frontend."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, from_attributes=True
    )


class ReplayOut(ApiModel):
    id: str
    file_hash: str
    storage_key: str
    size_bytes: int
    filename: str
    player_username: str
    player_userid: str | None
    uploader_username: str | None
    gamemode: str
    seed: int | None
    bagtype: str | None
    frames: int
    pps: float | None
    apm: float | None
    vsscore: float | None
    piece_count: int | None
    style: str | None
    reconstructable: bool
    reconstructable_reason: str | None
    uploaded_at: datetime


class TagOut(ApiModel):
    slug: str
    label: str
    category: str


class SegmentOut(ApiModel):
    id: str
    replay_id: str
    author_username: str | None
    start_piece: int
    end_piece: int
    title: str
    description: str
    difficulty: int | None
    thumbnail_key: str | None
    # Author-computed practice stats; unverified until `verified` is set.
    hints: dict | None
    tag_slugs: list[str]
    ups: int
    downs: int
    # Wilson score lower bound over (ups, downs); sort=top orders by it.
    score: float
    # The requesting user's vote (-1/0/1); 0 when logged out. Populated by the
    # route (it isn't a Segment attribute).
    my_vote: int = 0
    verified: bool
    status: str
    created_at: datetime


class SegmentWithReplay(SegmentOut):
    """List/detail item: embeds the replay summary so no second fetch."""

    replay: ReplayOut


class ReplayDetail(ReplayOut):
    segments: list[SegmentOut]


class ReplayPage(ApiModel):
    items: list[ReplayOut]
    next_cursor: str | None


class SegmentPage(ApiModel):
    items: list[SegmentWithReplay]
    next_cursor: str | None


class VoteIn(ApiModel):
    """PUT /segments/{id}/vote body: 1 = up, -1 = down, 0 = clear."""

    value: Literal[-1, 0, 1]


class ReportIn(ApiModel):
    """POST /reports body: exactly one of segment_id / replay_id."""

    segment_id: str | None = None
    replay_id: str | None = None
    reason: str = Field(min_length=3, max_length=2000)


class ReportOut(ApiModel):
    """Admin-queue item: the report plus its target (one of the two)."""

    id: str
    reason: str
    reporter_username: str | None
    created_at: datetime
    segment: SegmentOut | None
    replay: ReplayOut | None


class ModerateIn(ApiModel):
    """POST /admin/segments/{id}/moderate body."""

    action: Literal["hide", "remove", "restore"]
