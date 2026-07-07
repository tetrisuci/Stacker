"""Reports + moderation.

Any logged-in user may report a segment or a replay (exactly one target per
report). Admins review the queue at GET /admin/reports and act on segments
via POST /admin/segments/{id}/moderate, which drives `segments.status`:

    hide    -> 'pending'   (off public listings, recoverable)
    remove  -> 'removed'
    restore -> 'published'

Public reads only ever serve `published` segments; the status transitions
here are what take a segment off (or put it back on) every public surface.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .auth import AdminUser, CurrentUser
from .db import get_db
from .models import Replay, Report, Segment
from .schemas import ModerateIn, ReportIn, ReportOut, SegmentOut

router = APIRouter(tags=["reports"])

DbSession = Annotated[Session, Depends(get_db)]

_ACTION_TO_STATUS = {
    "hide": "pending",
    "remove": "removed",
    "restore": "published",
}


@router.post("/reports", status_code=201, response_model=ReportOut)
def create_report(payload: ReportIn, db: DbSession, user: CurrentUser):
    """File a report against one segment or one replay (auth required)."""
    if (payload.segment_id is None) == (payload.replay_id is None):
        raise HTTPException(
            status_code=422,
            detail="report exactly one of segmentId / replayId",
        )
    if payload.segment_id is not None:
        # Hidden/removed segments stay reportable — reports are how bad ones
        # get (and stay) actioned; only existence is checked.
        if db.get(Segment, payload.segment_id) is None:
            raise HTTPException(status_code=404, detail="unknown segment")
    else:
        if db.get(Replay, payload.replay_id) is None:
            raise HTTPException(status_code=404, detail="unknown replay")

    report = Report(
        segment_id=payload.segment_id,
        replay_id=payload.replay_id,
        reporter=user,
        reason=payload.reason.strip(),
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return ReportOut.model_validate(report)


@router.get("/admin/reports", response_model=list[ReportOut])
def list_reports(
    db: DbSession,
    _admin: AdminUser,
    limit: int = Query(default=100, ge=1, le=200),
):
    """The moderation queue, newest first (admin only)."""
    rows = db.scalars(
        select(Report)
        .options(
            selectinload(Report.reporter),
            selectinload(Report.segment).selectinload(Segment.tags),
            selectinload(Report.segment).selectinload(Segment.author),
            selectinload(Report.replay),
        )
        .order_by(Report.created_at.desc(), Report.id.desc())
        .limit(limit)
    ).all()
    return [ReportOut.model_validate(r) for r in rows]


@router.post("/admin/segments/{segment_id}/moderate", response_model=SegmentOut)
def moderate_segment(
    segment_id: str, payload: ModerateIn, db: DbSession, _admin: AdminUser
):
    """Hide, remove, or restore a segment (admin only)."""
    segment = db.get(Segment, segment_id)
    if segment is None:
        raise HTTPException(status_code=404, detail="unknown segment")
    segment.status = _ACTION_TO_STATUS[payload.action]
    db.commit()
    db.refresh(segment)
    return SegmentOut.model_validate(segment)
