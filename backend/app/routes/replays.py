"""Replay ingest + track slices."""

import hashlib

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Replay, Track
from ..reconstruct import (
    FORMAT_VERSION,
    ReconstructionUnavailable,
    ReplayParseError,
    pack_track,
    parse_ttr_metadata,
    run_reconstruction,
    unpack_track,
)
from ..schemas import ReplayIngestOut, ReplaySummary, TrackSlice, TrackSummary

router = APIRouter(prefix="/replays", tags=["replays"])


def _summary(replay: Replay) -> ReplaySummary:
    return ReplaySummary.model_validate(replay, from_attributes=True)


@router.post("", status_code=201, response_model=ReplayIngestOut)
async def ingest_replay(file: UploadFile, db: Session = Depends(get_db)):
    """Ingest a .ttr: parse metadata, reconstruct via the Node sidecar, store
    the replay + its placement track. Idempotent by file hash."""
    raw = await file.read()
    sha256 = hashlib.sha256(raw).hexdigest()

    existing = db.scalar(select(Replay).where(Replay.sha256 == sha256))
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail={"message": "replay already ingested", "replayId": existing.id},
        )

    try:
        meta = parse_ttr_metadata(raw)
        result = run_reconstruction(raw)
    except ReplayParseError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except ReconstructionUnavailable as e:
        raise HTTPException(status_code=501, detail=str(e)) from e

    replay = Replay(
        sha256=sha256,
        filename=file.filename or "replay.ttr",
        gamemode=meta.gamemode,
        username=meta.username,
        seed=meta.seed,
        bagtype=meta.bagtype,
        frames=meta.frames,
        duration_sec=meta.duration_sec,
        raw=raw,
    )
    track = Track(
        replay=replay,
        format_version=FORMAT_VERSION,
        piece_count=len(result["placements"]),
        lines=int(result.get("lines", 0)),
        drift_cap=result.get("driftCap"),
        data=pack_track(result),
    )
    db.add(replay)
    db.add(track)
    db.commit()

    return ReplayIngestOut(
        replay=_summary(replay),
        track=TrackSummary.model_validate(track, from_attributes=True),
    )


@router.get("/{replay_id}", response_model=ReplaySummary)
def get_replay(replay_id: str, db: Session = Depends(get_db)):
    replay = db.get(Replay, replay_id)
    if replay is None:
        raise HTTPException(status_code=404, detail="unknown replay")
    return _summary(replay)


@router.get("/{replay_id}/track", response_model=TrackSlice)
def get_track_slice(
    replay_id: str,
    start: int = 0,
    end: int | None = None,
    db: Session = Depends(get_db),
):
    """The placements/garbage/seed snapshot for window [start, end] — exactly
    what the frontend's TrainingSession consumes."""
    track = db.scalar(select(Track).where(Track.replay_id == replay_id))
    if track is None:
        raise HTTPException(status_code=404, detail="unknown replay")

    last = track.piece_count - 1
    if end is None:
        end = last
    if not (0 <= start <= end <= last):
        raise HTTPException(
            status_code=422,
            detail=f"window [{start}, {end}] outside track bounds [0, {last}]",
        )

    payload = unpack_track(track.data)
    placements = payload["placements"]
    return TrackSlice(
        format_version=track.format_version,
        start_piece=start,
        end_piece=end,
        # Session seed: the board *before* the window's first piece.
        seed_snapshot=placements[start - 1]["snapshot"] if start > 0 else None,
        placements=placements[start : end + 1],
        garbage=[
            g for g in payload["garbage"] if start < g["beforePiece"] <= end
        ],
    )
