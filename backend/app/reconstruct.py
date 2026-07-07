"""Reconstruction bridge + minimal .ttr metadata parsing.

The stacker engine (`@haelp/teto`) is JavaScript-only, so reconstruction is
delegated to a Node CLI that wraps the frontend's `reconstructReplay` and
prints JSON to stdout:

    node tools/reconstruct-cli.mjs < replay.ttr

Expected stdout (the placement-track contract, FORMAT_VERSION below):

    {
      "formatVersion": 1,
      "placements": Placement[],   // src/replay/reconstruct.ts shapes
      "garbage": GarbageEvent[],
      "pieces": int, "lines": int,
      "driftCap": int | null       // zenith partial support, else null
    }

Python treats placements/garbage as opaque JSON; only the counts and indexes
are read here.
"""

import gzip
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Version of the placement-track JSON contract this service understands.
# Bump in lockstep with src/replay/reconstruct.ts shape changes; stored per
# track so old blobs can be regenerated from replays.raw.
FORMAT_VERSION = 1

RECONSTRUCT_CLI = os.environ.get("RECONSTRUCT_CLI", "tools/reconstruct-cli.mjs")
RECONSTRUCT_TIMEOUT_SEC = 120


class ReplayParseError(ValueError):
    """The upload is not a parseable .ttr."""


class ReconstructionUnavailable(RuntimeError):
    """The Node reconstruction CLI is not present on this deployment."""


@dataclass
class ReplayMeta:
    gamemode: str
    username: str
    seed: int | None
    bagtype: str | None
    frames: int

    @property
    def duration_sec(self) -> float:
        return self.frames / 60


def parse_ttr_metadata(raw: bytes) -> ReplayMeta:
    """Defensive-lite mirror of the frontend's parse.ts: enough metadata to
    catalog the replay; full validation happens in the JS reconstruction."""
    try:
        root = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ReplayParseError(f"not valid JSON: {e}") from e

    replay = root.get("replay") or (root.get("data") or {}).get("replay")
    if not isinstance(replay, dict):
        raise ReplayParseError("no replay body found")
    options = replay.get("options")
    if not isinstance(options, dict):
        raise ReplayParseError("replay is missing its options block")

    users = root.get("users") or []
    username = "unknown"
    if isinstance(users, list) and users and isinstance(users[0], dict):
        username = str(users[0].get("username") or "unknown")

    seed = options.get("seed")
    frames = replay.get("frames")
    return ReplayMeta(
        gamemode=str(root.get("gamemode") or "unknown"),
        username=username,
        seed=int(seed) if isinstance(seed, (int, float)) else None,
        bagtype=str(options["bagtype"]) if "bagtype" in options else None,
        frames=int(frames) if isinstance(frames, (int, float)) else 0,
    )


def run_reconstruction(raw: bytes) -> dict[str, Any]:
    """Run the Node reconstruction CLI over a raw .ttr; returns the contract
    dict (see module docstring). Raises ReconstructionUnavailable when the CLI
    is missing and ReplayParseError when it rejects the file."""
    if not Path(RECONSTRUCT_CLI).exists():
        raise ReconstructionUnavailable(
            f"reconstruction CLI not found at {RECONSTRUCT_CLI!r} "
            "(set RECONSTRUCT_CLI or deploy the Node sidecar)"
        )
    proc = subprocess.run(
        ["node", RECONSTRUCT_CLI],
        input=raw,
        capture_output=True,
        timeout=RECONSTRUCT_TIMEOUT_SEC,
    )
    if proc.returncode != 0:
        raise ReplayParseError(
            f"reconstruction failed: {proc.stderr.decode(errors='replace')[:500]}"
        )
    result = json.loads(proc.stdout)
    if result.get("formatVersion") != FORMAT_VERSION:
        raise ReplayParseError(
            f"CLI emitted contract v{result.get('formatVersion')}, "
            f"expected v{FORMAT_VERSION}"
        )
    return result


# ---- track blob helpers ----


def pack_track(result: dict[str, Any]) -> bytes:
    """Gzip the slice-relevant portion of a reconstruction for tracks.data."""
    payload = {"placements": result["placements"], "garbage": result["garbage"]}
    return gzip.compress(json.dumps(payload, separators=(",", ":")).encode())


def unpack_track(data: bytes) -> dict[str, Any]:
    return json.loads(gzip.decompress(data))
