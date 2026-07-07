"""`.ttr` parsing/validation — a faithful port of the frontend's rules.

Mirrors `src/replay/parse.ts` (defensive extraction, version warning, bagtype
default, board checks) and `src/engine/adapter.ts` (the reconstructable bag
allowlist). One deliberate divergence: the *client* reconstructs Zenith
partially with a 7-bag stand-in (`src/replay/zenith.ts`); the server has no
engine, so Zenith is stored **parse-only** (`reconstructable = False`).

Multiplayer `.ttrm` files are rejected outright — by extension before any
bytes are inspected, and by shape (`replay.rounds` / `replay.leaderboard`)
immediately after JSON parsing.

Stdlib-only on purpose: importable and testable without FastAPI/SQLAlchemy.
"""

import json
from dataclasses import dataclass, field
from typing import Any

MAX_REPLAY_BYTES = 3 * 1024 * 1024  # 3 MB cap

# Mirrors KNOWN_REPLAY_VERSIONS in src/replay/parse.ts.
KNOWN_REPLAY_VERSIONS = (1,)

# Mirrors SUPPORTED_BAG_TYPES in src/engine/adapter.ts.
SUPPORTED_BAG_TYPES = (
    "7-bag",
    "14-bag",
    "classic",
    "pairs",
    "total mayhem",
    "7+1-bag",
    "7+2-bag",
    "7+x-bag",
)

MULTIPLAYER_MESSAGE = "multiplayer replays are not supported"


class TtrError(ValueError):
    """The upload is not a parseable solo .ttr."""


class MultiplayerReplayError(TtrError):
    """The upload is a multiplayer .ttrm (by extension or by shape)."""

    def __init__(self) -> None:
        super().__init__(MULTIPLAYER_MESSAGE)


@dataclass
class ParsedTtr:
    username: str
    player_userid: str | None
    gamemode: str
    seed: int | None
    bagtype: str | None
    pps: float | None
    apm: float | None
    vsscore: float | None
    frames: int
    piece_count: int | None
    version: int | None
    reconstructable: bool
    reconstructable_reason: str | None
    warnings: list[str] = field(default_factory=list)

    @property
    def duration_sec(self) -> float:
        return self.frames / 60


def is_ttrm_filename(filename: str | None) -> bool:
    """Extension check — runs before the body is even read."""
    return bool(filename) and filename.lower().endswith(".ttrm")


def _num(v: Any) -> float | None:
    # Mirrors parse.ts `num`: finite numbers only (bool is not a number here).
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        f = float(v)
        if f == f and f not in (float("inf"), float("-inf")):
            return f
    return None


def _str(v: Any) -> str | None:
    return v if isinstance(v, str) else None


def _find_replay_body(root: Any) -> dict[str, Any] | None:
    """Mirrors parse.ts findReplayBody: the common .ttr nesting shapes."""
    if not isinstance(root, dict):
        return None
    if isinstance(root.get("replay"), dict):
        return root["replay"]
    data = root.get("data")
    if isinstance(data, dict) and isinstance(data.get("replay"), dict):
        return data["replay"]
    if isinstance(root.get("events"), list) or isinstance(root.get("frames"), list):
        return root
    return None


def _is_multiplayer_shape(replay_body: dict[str, Any]) -> bool:
    """.ttrm bodies carry per-round data; solo .ttr never has these keys."""
    return "rounds" in replay_body or "leaderboard" in replay_body or (
        isinstance(replay_body.get("results"), dict)
        and "leaderboard" in replay_body["results"]
    )


def _first_user(root: dict[str, Any]) -> Any:
    users = root.get("users")
    if users is None and isinstance(root.get("data"), dict):
        users = root["data"].get("users")
    if isinstance(users, list) and users:
        return users[0]
    return users


def _extract_username(root: dict[str, Any]) -> str:
    """Mirrors parse.ts extractUsername."""
    u = _first_user(root)
    if isinstance(u, dict):
        return _str(u.get("username")) or _str(u.get("name")) or "unknown"
    if isinstance(u, str):
        return u
    return _str(root.get("username")) or "unknown"


def _extract_player_userid(root: dict[str, Any]) -> str | None:
    """The TETR.IO account id from the replay's users block."""
    u = _first_user(root)
    if isinstance(u, dict):
        return _str(u.get("id")) or _str(u.get("_id"))
    return None


def _extract_stats(replay_body: dict[str, Any]) -> dict[str, float | None]:
    """Mirrors parse.ts extractStats (plus vsscore), first hit wins per field."""
    results = replay_body.get("results")
    results = results if isinstance(results, dict) else {}
    candidates = [
        c
        for c in (
            results,
            results.get("stats"),
            results.get("aggregatestats"),
            replay_body.get("stats"),
        )
        if isinstance(c, dict)
    ]

    def pick(keys: list[str]) -> float | None:
        for c in candidates:
            for k in keys:
                v = _num(c.get(k))
                if v is not None:
                    return v
        return None

    return {
        "pps": pick(["pps"]),
        "apm": pick(["apm"]),
        "vsscore": pick(["vsscore"]),
        "pieces": pick(["piecesplaced", "pieces"]),
    }


def _reconstructable(
    gamemode: str, bagtype: str | None, options: dict[str, Any]
) -> tuple[bool, str | None]:
    """Mirrors parse.ts checkReconstructionSupport, except Zenith: the client
    does a capped 7-bag approximation, but the server stores it parse-only."""
    if gamemode.lower() == "zenith" or bagtype == "zenith":
        return False, (
            "Zenith uses a custom piece bag with no engine implementation; "
            "stored parse-only (the client offers a capped 7-bag approximation)"
        )
    if bagtype is None or bagtype not in SUPPORTED_BAG_TYPES:
        return False, (
            f'bag type "{bagtype or "unknown"}" is not one of the engine\'s '
            f"supported types ({', '.join(SUPPORTED_BAG_TYPES)})"
        )
    w = _num(options.get("boardwidth"))
    if w is not None and w != 10:
        return False, f"non-standard board width {w:g} (expected 10)"
    h = _num(options.get("boardheight"))
    if h is not None and h != 20:
        return False, f"non-standard board height {h:g} (expected 20)"
    return True, None


def parse_ttr(raw: bytes) -> ParsedTtr:
    """Parse a solo .ttr upload. Raises MultiplayerReplayError for .ttrm-shaped
    bodies and TtrError for anything unparseable."""
    try:
        root = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise TtrError(f"not valid JSON: {e}") from e

    replay_body = _find_replay_body(root)
    if replay_body is None:
        raise TtrError(
            "unrecognized .ttr structure: no replay body with events/options found"
        )
    # Reject multiplayer by shape before any further extraction.
    if _is_multiplayer_shape(replay_body):
        raise MultiplayerReplayError()

    options = replay_body.get("options")
    if not isinstance(options, dict):
        options = (
            replay_body["data"].get("options")
            if isinstance(replay_body.get("data"), dict)
            else None
        )
    if not isinstance(options, dict):
        raise TtrError("replay is missing its options block")

    warnings: list[str] = []

    raw_version = _num(root.get("version"))
    if raw_version is None and isinstance(root.get("data"), dict):
        raw_version = _num(root["data"].get("version"))
    version = int(raw_version) if raw_version is not None else None
    if version is None:
        warnings.append("replay has no version field; proceeding with caution")
    elif version not in KNOWN_REPLAY_VERSIONS:
        warnings.append(
            f"unknown replay version {version} "
            f"(known: {', '.join(map(str, KNOWN_REPLAY_VERSIONS))})"
        )

    gamemode = _str(root.get("gamemode"))
    if gamemode is None and isinstance(root.get("data"), dict):
        gamemode = _str(root["data"].get("gamemode"))
    gamemode = gamemode or "unknown"

    events = replay_body.get("events")
    events = events if isinstance(events, list) else []

    frames = _num(replay_body.get("frames"))
    if frames is None and events:
        last = events[-1]
        frames = _num(last.get("frame")) if isinstance(last, dict) else None
        frames = frames if frames is not None else float(len(events))
        warnings.append("no explicit frame count; inferred from last event")
    frames_int = int(frames) if frames is not None else 0

    # Mirrors the frontend's option-defaults merge: an omitted bagtype means
    # the mode preset's default, which is 7-bag for every solo mode we accept.
    bagtype = _str(options.get("bagtype"))
    if bagtype is None:
        bagtype = "7-bag"
        warnings.append('replay options omit bagtype; assuming "7-bag"')

    seed = _num(options.get("seed"))
    stats = _extract_stats(replay_body)
    reconstructable, reason = _reconstructable(gamemode, bagtype, options)

    return ParsedTtr(
        username=_extract_username(root),
        player_userid=_extract_player_userid(root),
        gamemode=gamemode,
        seed=int(seed) if seed is not None else None,
        bagtype=bagtype,
        pps=stats["pps"],
        apm=stats["apm"],
        vsscore=stats["vsscore"],
        frames=frames_int,
        piece_count=int(stats["pieces"]) if stats["pieces"] is not None else None,
        version=version,
        reconstructable=reconstructable,
        reconstructable_reason=reason,
        warnings=warnings,
    )
