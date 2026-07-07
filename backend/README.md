# Stacker backend — curated timeframes (skeleton)

A FastAPI service that ingests TETR.IO `.ttr` replays, runs reconstruction, and
stores community-curated **timeframes** (interesting piece windows like a
DT cannon or a clean 4-wide) that the trainer frontend can browse and load.

## Architecture

```
            POST /replays (.ttr)
  client ──────────────────────────► FastAPI ──► node tools/reconstruct-cli.mjs
                                        │            (the engine is JS-only)
                                        ▼
                                   SQLite / Postgres
                                        ▲
  client ◄──────────────────────────────┘
    GET /timeframes            (browse curated windows)
    GET /replays/{id}/track    (fetch a track slice to start a session)
    POST /timeframes           (submit a window)
```

**Reconstruction stays in JavaScript.** The engine (`@haelp/teto`) has no
Python port, so the service shells out to a small Node CLI (`RECONSTRUCT_CLI`
env var, default `tools/reconstruct-cli.mjs`) that wraps
`src/replay/reconstruct.ts` and prints the result as JSON. The JSON shapes of
`Placement` / `GarbageEvent` from `src/replay/reconstruct.ts` **are the
contract** (`formatVersion: 1`); Python stores and serves them verbatim and
never interprets snapshot internals.

## Database schema

SQLite for development, Postgres-ready: UUID keys as `CHAR(36)`, portable
column types only, tags normalized into a join table (no `JSONB` dependence),
`DATABASE_URL` selects the engine. Add Alembic before the first migration.

```
replays                            tracks (1:1 with replays)
  id            char(36) PK          id              char(36) PK
  sha256        unique, indexed      replay_id       FK → replays, unique
  filename      text                 format_version  int   -- placement-track contract
  gamemode      text                 piece_count     int
  username      text                 lines           int
  seed          bigint?              drift_cap       int?  -- zenith partial support
  bagtype       text?                data            blob  -- gzipped JSON {placements, garbage}
  frames        int                  created_at      datetime
  duration_sec  float
  raw           blob  -- original .ttr (re-reconstruct on contract bumps)
  uploaded_at   datetime

timeframes                         timeframe_tags
  id            char(36) PK          timeframe_id  FK → timeframes, PK
  replay_id     FK → replays, idx    tag           varchar(48), PK, indexed
  start_piece   int  (>= 0)
  end_piece     int  (>= start_piece, < track.piece_count)
  author        varchar(64)
  notes         text
  upvotes       int default 0
  created_at    datetime
```

Design notes:

- The full track (per-placement engine snapshots included) is large, so it
  lives gzipped in `tracks.data`, one blob per replay; slices are cut in the
  API layer. Snapshots are required — the trainer seeds sessions from
  `track[start-1].snapshot` and compares board occupancy per placement.
- `sha256` dedupes uploads: re-ingesting an existing replay returns the
  existing record (409 with the id) instead of a duplicate.
- `drift_cap` records where a zenith reconstruction stops being trustworthy;
  timeframes are validated against `piece_count`, which is already capped.

## API contract

All bodies are JSON in the JS contract's camelCase.

### `POST /replays` — ingest
Multipart upload, field `file` = the `.ttr`.

- `201` → `{ "replay": ReplaySummary, "track": TrackSummary }`
- `409` → replay already ingested; `detail.replayId` has the existing id
- `422` → not a parseable `.ttr`
- `501` → reconstruction CLI not available on this deployment

### `GET /replays/{id}` — replay summary
`200` → `ReplaySummary`.

### `GET /replays/{id}/track?start=0&end=` — track slice
Everything a training session needs for the window `[start, end]` (inclusive,
absolute piece indexes):

```json
{
  "formatVersion": 1,
  "startPiece": 60,
  "endPiece": 120,
  "seedSnapshot": { "...": "engine snapshot after piece 59, null when start=0" },
  "placements": [ { "pieceIndex": 60, "piece": "t", "frame": 866, "x": 4, "y": 1,
                    "rot": 2, "wasHold": false, "spin": "none", "clears": 1,
                    "snapshot": { "...": "opaque engine snapshot" } } ],
  "garbage":    [ { "beforePiece": 71, "amount": 2,
                    "rows": [ { "column": 4, "amount": 2, "size": 1, "id": 8 } ] } ]
}
```

### `GET /timeframes` — browse
Query params: `tag` (repeatable, AND-combined), `replayId`, `sort` = `top`
(upvotes) | `new` (default `top`), `limit` (≤ 100), `offset`.

`200` → `{ "items": [TimeframeOut], "total": n }` where each item embeds a
`ReplaySummary` so the list renders without extra requests.

### `POST /timeframes` — submit
```json
{ "replayId": "…", "startPiece": 60, "endPiece": 120,
  "author": "zhiyuan", "notes": "textbook DT cannon into PC",
  "tags": ["DT-cannon", "clean-4wide"] }
```
`201` → `TimeframeOut`. `404` unknown replay; `422` window out of the track's
bounds or bad tags (lowercase slugs, ≤ 10 per timeframe).

### `POST /timeframes/{id}/upvote`
`200` → `{ "id": "…", "upvotes": n }`. (Skeleton: unauthenticated, one call =
one vote; rate limiting / auth is future work.)

## Running

```
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload         # DATABASE_URL=sqlite:///./stacker.db by default
```

## Deferred (deliberately out of skeleton scope)

Auth/identity for authors and votes, Alembic migrations, the Node CLI itself
(`tools/reconstruct-cli.mjs` wrapping `reconstructReplay`), pagination cursors,
tag moderation, and a "lite" track slice (placements without snapshots) for
list previews.
