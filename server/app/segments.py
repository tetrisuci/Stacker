"""Segments + tags: catalog reads and authored writes.

A segment references exactly one replay and a piece-index window; list items
embed the replay summary so browse pages render in one request. Only
`published` segments are listed.

POST /segments is multipart (the thumbnail rides along) and auth-gated. The
author's hint stats are stored as submitted — unverified — until something
server-side (or a moderator) flips `verified`.
"""

import json
import math
import re
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session, selectinload

from .auth import CurrentUser, OptionalUser
from .db import get_db
from .models import Replay, Segment, SegmentTag, Tag, User, Vote
from .pagination import (
    decode_cursor,
    decode_top_cursor,
    encode_cursor,
    encode_top_cursor,
)
from .schemas import SegmentOut, SegmentPage, SegmentWithReplay, TagOut, VoteIn
from .storage import Storage, get_storage

router = APIRouter(tags=["segments"])

DbSession = Annotated[Session, Depends(get_db)]
StorageDep = Annotated[Storage, Depends(get_storage)]

MAX_HINTS_BYTES = 16 * 1024
MAX_THUMBNAIL_BYTES = 512 * 1024
MAX_TAGS = 10
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


def _slugify(tag: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", tag.strip().lower()).strip("-")[:48]
    return slug


def wilson_lower_bound(ups: int, downs: int, z: float = 1.96) -> float:
    """Lower bound of the 95% Wilson score interval on the up-vote fraction.

    Ranks by how confident we are the segment is good, not by raw ratio or
    count: 1 up / 0 down (ratio 1.0) scores ~0.21, while 20 up / 2 down
    (ratio 0.91) scores ~0.72 — the well-attested segment wins sort=top.
    """
    n = ups + downs
    if n == 0:
        return 0.0
    p = ups / n
    denom = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return (center - margin) / denom


def _my_votes(db: Session, user: User | None, segment_ids: list[str]) -> dict[str, int]:
    """The requesting user's votes over `segment_ids` (empty when logged out)."""
    if user is None or not segment_ids:
        return {}
    rows = db.execute(
        select(Vote.segment_id, Vote.value).where(
            Vote.user_id == user.id, Vote.segment_id.in_(segment_ids)
        )
    ).all()
    return dict(rows)


def _resolve_tags(db: Session, raw: str) -> list[Tag]:
    """Comma-separated tag names → Tag rows; unknown names become free tags
    (category 'custom'); vocabulary tags are matched by slug."""
    names = [t for t in (part.strip() for part in raw.split(",")) if t]
    if len(names) > MAX_TAGS:
        raise HTTPException(status_code=422, detail=f"at most {MAX_TAGS} tags")
    tags: dict[str, Tag] = {}
    for name in names:
        slug = _slugify(name)
        if not slug or not TAG_RE.match(slug):
            raise HTTPException(status_code=422, detail=f"invalid tag {name!r}")
        if slug in tags:
            continue
        tag = db.get(Tag, slug)
        if tag is None:
            tag = Tag(slug=slug, label=name.strip(), category="custom")
            db.add(tag)
            db.flush()
        tags[slug] = tag
    return list(tags.values())


@router.post("/segments", status_code=201, response_model=SegmentOut)
async def create_segment(
    db: DbSession,
    storage: StorageDep,
    user: CurrentUser,
    replay_id: Annotated[str, Form()],
    start_piece: Annotated[int, Form(ge=0)],
    end_piece: Annotated[int, Form(ge=0)],
    title: Annotated[str, Form(min_length=1, max_length=120)],
    description: Annotated[str, Form(max_length=2000)] = "",
    difficulty: Annotated[int | None, Form(ge=1, le=5)] = None,
    tags: Annotated[str, Form()] = "",
    hints: Annotated[str, Form()] = "",
    thumbnail: UploadFile | None = None,
):
    """Publish a training segment over a stored replay's piece window."""
    replay = db.get(Replay, replay_id)
    if replay is None:
        raise HTTPException(status_code=404, detail="unknown replay")
    last = (replay.piece_count or 0) - 1
    if end_piece < start_piece or (replay.piece_count and end_piece > last):
        raise HTTPException(
            status_code=422,
            detail=(
                f"window [{start_piece}, {end_piece}] outside the replay's "
                f"pieces [0, {last}]"
            ),
        )

    hints_obj: dict | None = None
    if hints:
        if len(hints) > MAX_HINTS_BYTES:
            raise HTTPException(status_code=422, detail="hints too large")
        try:
            hints_obj = json.loads(hints)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=422, detail="hints is not JSON") from e
        if not isinstance(hints_obj, dict):
            raise HTTPException(status_code=422, detail="hints must be an object")

    segment = Segment(
        replay_id=replay.id,
        author=user,
        start_piece=start_piece,
        end_piece=end_piece,
        title=title,
        description=description,
        difficulty=difficulty,
        hints=hints_obj,
        verified=False,
        status="published",
        tags=_resolve_tags(db, tags),
    )
    db.add(segment)
    db.flush()

    if thumbnail is not None:
        raw = await thumbnail.read(MAX_THUMBNAIL_BYTES + 1)
        if len(raw) > MAX_THUMBNAIL_BYTES:
            raise HTTPException(status_code=413, detail="thumbnail exceeds 512 KB")
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            raise HTTPException(status_code=422, detail="thumbnail must be a PNG")
        segment.thumbnail_key = storage.put_thumbnail(segment.id, raw)

    db.commit()
    db.refresh(segment)
    return SegmentOut.model_validate(segment)


@router.get("/segments", response_model=SegmentPage)
def list_segments(
    db: DbSession,
    user: OptionalUser,
    tag: Annotated[list[str], Query()] = [],  # noqa: B006 — FastAPI query default
    mode: str | None = None,
    difficulty: int | None = Query(default=None, ge=1, le=5),
    player: str | None = None,
    style: str | None = None,
    pps_min: float | None = None,
    pps_max: float | None = None,
    apm_min: float | None = None,
    apm_max: float | None = None,
    sort: str = Query(default="new", pattern="^(new|top)$"),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = None,
):
    """Browse published segments — `sort=new` (default) or `sort=top` (Wilson
    score). `tag` repeats and AND-combines; `mode`/`player`/`style` and the
    pps/apm ranges filter on the referenced replay."""
    query = (
        select(Segment)
        .where(Segment.status == "published")
        .options(
            selectinload(Segment.tags),
            selectinload(Segment.author),
            selectinload(Segment.replay).selectinload(Replay.uploader),
        )
    )
    replay_filtered = any(
        v is not None for v in (mode, player, style, pps_min, pps_max, apm_min, apm_max)
    )
    if replay_filtered:
        query = query.join(Replay, Segment.replay_id == Replay.id)
        if mode is not None:
            query = query.where(Replay.gamemode == mode)
        if player is not None:
            query = query.where(
                func.lower(Replay.player_username) == player.lower()
            )
        if style is not None:
            query = query.where(Replay.style == style)
        if pps_min is not None:
            query = query.where(Replay.pps >= pps_min)
        if pps_max is not None:
            query = query.where(Replay.pps <= pps_max)
        if apm_min is not None:
            query = query.where(Replay.apm >= apm_min)
        if apm_max is not None:
            query = query.where(Replay.apm <= apm_max)
    if difficulty is not None:
        query = query.where(Segment.difficulty == difficulty)
    # AND-combine tags: every requested tag must be attached.
    for slug in {t.lower() for t in tag}:
        query = query.where(
            Segment.id.in_(
                select(SegmentTag.segment_id).where(SegmentTag.tag_slug == slug)
            )
        )
    try:
        if cursor is not None and sort == "top":
            score, ts, row_id = decode_top_cursor(cursor)
            query = query.where(
                tuple_(Segment.score, Segment.created_at, Segment.id)
                < (score, ts, row_id)
            )
        elif cursor is not None:
            ts, row_id = decode_cursor(cursor)
            query = query.where(
                tuple_(Segment.created_at, Segment.id) < (ts, row_id)
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail="malformed cursor") from e

    order = (
        (Segment.score.desc(), Segment.created_at.desc(), Segment.id.desc())
        if sort == "top"
        else (Segment.created_at.desc(), Segment.id.desc())
    )
    rows = db.scalars(query.order_by(*order).limit(limit + 1)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = (
            encode_top_cursor(last.score, last.created_at, last.id)
            if sort == "top"
            else encode_cursor(last.created_at, last.id)
        )
    votes = _my_votes(db, user, [s.id for s in rows])
    items = []
    for s in rows:
        out = SegmentWithReplay.model_validate(s)
        out.my_vote = votes.get(s.id, 0)
        items.append(out)
    return SegmentPage(items=items, next_cursor=next_cursor)


@router.get("/segments/{segment_id}", response_model=SegmentWithReplay)
def get_segment(segment_id: str, db: DbSession, user: OptionalUser):
    """One published segment; hidden/removed ones 404 like they never were."""
    segment = db.scalar(
        select(Segment)
        .where(Segment.id == segment_id, Segment.status == "published")
        .options(
            selectinload(Segment.tags),
            selectinload(Segment.author),
            selectinload(Segment.replay),
        )
    )
    if segment is None:
        raise HTTPException(status_code=404, detail="unknown segment")
    out = SegmentWithReplay.model_validate(segment)
    out.my_vote = _my_votes(db, user, [segment.id]).get(segment.id, 0)
    return out


@router.put("/segments/{segment_id}/vote", response_model=SegmentOut)
def vote_segment(
    segment_id: str, payload: VoteIn, db: DbSession, user: CurrentUser
):
    """Cast, change, or clear (value 0) this user's vote — one row per
    (user, segment). Recomputes ups/downs and the Wilson score."""
    segment = db.get(Segment, segment_id)
    if segment is None or segment.status != "published":
        raise HTTPException(status_code=404, detail="unknown segment")

    vote = db.get(Vote, (segment_id, user.id))
    if payload.value == 0:
        if vote is not None:
            db.delete(vote)
    elif vote is None:
        db.add(Vote(segment_id=segment_id, user_id=user.id, value=payload.value))
    else:
        vote.value = payload.value
    db.flush()

    def _count(value: int) -> int:
        return db.scalar(
            select(func.count())
            .select_from(Vote)
            .where(Vote.segment_id == segment_id, Vote.value == value)
        )

    segment.ups = _count(1)
    segment.downs = _count(-1)
    segment.score = wilson_lower_bound(segment.ups, segment.downs)
    db.commit()
    db.refresh(segment)
    out = SegmentOut.model_validate(segment)
    out.my_vote = payload.value
    return out


@router.get("/segments/{segment_id}/thumbnail")
def get_segment_thumbnail(segment_id: str, db: DbSession, storage: StorageDep):
    """The segment's stored PNG thumbnail, streamed from object storage
    (same rationale as the replay-file route: no presigned MinIO URLs)."""
    segment = db.get(Segment, segment_id)
    if (
        segment is None
        or segment.thumbnail_key is None
        or segment.status != "published"
    ):
        raise HTTPException(status_code=404, detail="no thumbnail")
    return StreamingResponse(
        storage.get_thumbnail(segment.thumbnail_key),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@router.get("/tags", response_model=list[TagOut])
def list_tags(db: DbSession):
    """The controlled tag vocabulary (seeded by migration)."""
    rows = db.scalars(select(Tag).order_by(Tag.category, Tag.slug)).all()
    return [TagOut.model_validate(t) for t in rows]
