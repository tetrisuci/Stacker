"""Replays: multipart ingest + catalog reads + raw-file streaming.

Upload rejection order is cheapest-first: .ttrm extension (before touching the
body), size cap, hash dedup (existing files return 200 without re-parsing or
re-uploading), then JSON parse — which itself rejects multiplayer *shapes*
(replay.rounds / replay.leaderboard) before any metadata extraction.
"""

import hashlib
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Response,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session, selectinload

from .auth import CurrentUser
from .db import get_db
from .models import Replay
from .pagination import decode_cursor, encode_cursor
from .schemas import ReplayDetail, ReplayOut, ReplayPage, SegmentOut
from .storage import Storage, get_storage
from .ttr import (
    MAX_REPLAY_BYTES,
    MULTIPLAYER_MESSAGE,
    MultiplayerReplayError,
    TtrError,
    is_ttrm_filename,
    parse_ttr,
)

router = APIRouter(prefix="/replays", tags=["replays"])

DbSession = Annotated[Session, Depends(get_db)]
StorageDep = Annotated[Storage, Depends(get_storage)]


@router.post("", status_code=201, response_model=ReplayOut)
async def upload_replay(
    file: UploadFile,
    response: Response,
    db: DbSession,
    storage: StorageDep,
    user: CurrentUser,
):
    """Ingest a solo .ttr (auth required; the session user is the uploader).
    Returns 201 for a new replay, 200 (same body) when the identical file was
    already ingested. Multiplayer .ttrm → 415."""
    filename = file.filename or "replay.ttr"
    if is_ttrm_filename(filename):
        raise HTTPException(status_code=415, detail=MULTIPLAYER_MESSAGE)

    # Read one byte past the cap so oversized files are detected without
    # buffering arbitrarily large uploads.
    raw = await file.read(MAX_REPLAY_BYTES + 1)
    if len(raw) > MAX_REPLAY_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"replay file exceeds {MAX_REPLAY_BYTES // (1024 * 1024)} MB",
        )

    file_hash = hashlib.sha256(raw).hexdigest()
    existing = db.scalar(select(Replay).where(Replay.file_hash == file_hash))
    if existing is not None:
        response.status_code = 200
        return ReplayOut.model_validate(existing)

    try:
        parsed = parse_ttr(raw)
    except MultiplayerReplayError as e:
        raise HTTPException(status_code=415, detail=MULTIPLAYER_MESSAGE) from e
    except TtrError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    storage_key = storage.put_replay(file_hash, raw)
    replay = Replay(
        file_hash=file_hash,
        storage_key=storage_key,
        size_bytes=len(raw),
        filename=filename,
        player_username=parsed.username,
        player_userid=parsed.player_userid,
        uploader=user,
        gamemode=parsed.gamemode,
        seed=parsed.seed,
        bagtype=parsed.bagtype,
        frames=parsed.frames,
        pps=parsed.pps,
        apm=parsed.apm,
        vsscore=parsed.vsscore,
        piece_count=parsed.piece_count,
        reconstructable=parsed.reconstructable,
        reconstructable_reason=parsed.reconstructable_reason,
    )
    db.add(replay)
    db.commit()
    db.refresh(replay)
    return ReplayOut.model_validate(replay)


@router.get("", response_model=ReplayPage)
def list_replays(
    db: DbSession,
    player: str | None = None,
    mode: str | None = None,
    style: str | None = None,
    pps_min: float | None = Query(default=None, ge=0),
    pps_max: float | None = Query(default=None, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = None,
):
    """Browse replays, newest first. Keyset pagination: pass back `nextCursor`
    as `cursor` for the next page (stable under concurrent inserts)."""
    query = select(Replay)
    if player is not None:
        query = query.where(
            func.lower(Replay.player_username) == player.lower()
        )
    if mode is not None:
        query = query.where(Replay.gamemode == mode)
    if style is not None:
        query = query.where(Replay.style == style)
    if pps_min is not None:
        query = query.where(Replay.pps >= pps_min)
    if pps_max is not None:
        query = query.where(Replay.pps <= pps_max)
    if cursor is not None:
        try:
            ts, row_id = decode_cursor(cursor)
        except ValueError as e:
            raise HTTPException(status_code=422, detail="malformed cursor") from e
        query = query.where(tuple_(Replay.uploaded_at, Replay.id) < (ts, row_id))

    rows = db.scalars(
        query.order_by(Replay.uploaded_at.desc(), Replay.id.desc()).limit(limit + 1)
    ).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = (
        encode_cursor(rows[-1].uploaded_at, rows[-1].id)
        if has_more and rows
        else None
    )
    return ReplayPage(
        items=[ReplayOut.model_validate(r) for r in rows], next_cursor=next_cursor
    )


@router.get("/{replay_id}", response_model=ReplayDetail)
def get_replay(replay_id: str, db: DbSession):
    replay = db.scalar(
        select(Replay)
        .where(Replay.id == replay_id)
        .options(selectinload(Replay.segments))
    )
    if replay is None:
        raise HTTPException(status_code=404, detail="unknown replay")
    out = ReplayDetail.model_validate(replay)
    # Hidden/removed segments are off every public surface, including here.
    out.segments = [
        SegmentOut.model_validate(s)
        for s in replay.segments
        if s.status == "published"
    ]
    return out


@router.get("/{replay_id}/file")
def get_replay_file(replay_id: str, db: DbSession, storage: StorageDep):
    """Stream the raw .ttr bytes (streamed through the API — see storage.py
    for why we don't hand out presigned URLs in dev)."""
    replay = db.get(Replay, replay_id)
    if replay is None:
        raise HTTPException(status_code=404, detail="unknown replay")
    try:
        chunks = storage.get_replay(replay.storage_key)
    except Exception as e:  # noqa: BLE001 — storage errors all mean "not there"
        raise HTTPException(
            status_code=404, detail="replay file missing from storage"
        ) from e
    return StreamingResponse(
        chunks,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{replay.filename}"'
        },
    )
