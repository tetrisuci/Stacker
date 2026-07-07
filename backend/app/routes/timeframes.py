"""Community timeframes: browse, submit, upvote."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..models import Replay, Timeframe, TimeframeTag, Track
from ..schemas import (
    ReplaySummary,
    TimeframeIn,
    TimeframeList,
    TimeframeOut,
    UpvoteOut,
)

router = APIRouter(prefix="/timeframes", tags=["timeframes"])


def _out(tf: Timeframe) -> TimeframeOut:
    return TimeframeOut(
        id=tf.id,
        replay=ReplaySummary.model_validate(tf.replay, from_attributes=True),
        start_piece=tf.start_piece,
        end_piece=tf.end_piece,
        author=tf.author,
        notes=tf.notes,
        tags=sorted(t.tag for t in tf.tags),
        upvotes=tf.upvotes,
        created_at=tf.created_at,
    )


@router.get("", response_model=TimeframeList)
def list_timeframes(
    tag: list[str] = Query(default=[]),
    replay_id: str | None = Query(default=None, alias="replayId"),
    sort: Literal["top", "new"] = "top",
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """Browse curated timeframes; `tag` is repeatable and AND-combined."""
    query = select(Timeframe).options(
        selectinload(Timeframe.tags), selectinload(Timeframe.replay)
    )
    if replay_id is not None:
        query = query.where(Timeframe.replay_id == replay_id)
    # AND-combine tags: each requested tag must exist for the timeframe.
    for t in {t.lower() for t in tag}:
        query = query.where(
            Timeframe.id.in_(
                select(TimeframeTag.timeframe_id).where(TimeframeTag.tag == t)
            )
        )

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0

    order = (
        (Timeframe.upvotes.desc(), Timeframe.created_at.desc())
        if sort == "top"
        else (Timeframe.created_at.desc(),)
    )
    rows = db.scalars(query.order_by(*order).limit(limit).offset(offset)).all()
    return TimeframeList(items=[_out(tf) for tf in rows], total=total)


@router.post("", status_code=201, response_model=TimeframeOut)
def submit_timeframe(body: TimeframeIn, db: Session = Depends(get_db)):
    replay = db.get(Replay, body.replay_id)
    if replay is None:
        raise HTTPException(status_code=404, detail="unknown replay")
    track = db.scalar(select(Track).where(Track.replay_id == replay.id))
    if track is None:
        raise HTTPException(status_code=404, detail="replay has no track")

    last = track.piece_count - 1
    if not (0 <= body.start_piece <= body.end_piece <= last):
        raise HTTPException(
            status_code=422,
            detail=(
                f"window [{body.start_piece}, {body.end_piece}] outside the "
                f"track bounds [0, {last}]"
            ),
        )

    tf = Timeframe(
        replay_id=replay.id,
        start_piece=body.start_piece,
        end_piece=body.end_piece,
        author=body.author,
        notes=body.notes,
        tags=[TimeframeTag(tag=t) for t in body.tags],
    )
    db.add(tf)
    db.commit()
    db.refresh(tf)
    return _out(tf)


@router.post("/{timeframe_id}/upvote", response_model=UpvoteOut)
def upvote_timeframe(timeframe_id: str, db: Session = Depends(get_db)):
    """Skeleton: unauthenticated +1. Auth / one-vote-per-user is future work."""
    tf = db.get(Timeframe, timeframe_id)
    if tf is None:
        raise HTTPException(status_code=404, detail="unknown timeframe")
    tf.upvotes += 1
    db.commit()
    return UpvoteOut(id=tf.id, upvotes=tf.upvotes)
