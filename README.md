# TETR.IO Stacking Trainer

Replay a top player's `.ttr` (solo) or `.ttrm` (Tetra League) next to your own
live board and practice reproducing their stacking **exactly** — same piece
sequence, same incoming garbage, same faithful TETR.IO physics on both sides.

The pro's run is reconstructed from their replay; you play the identical queue on
a single board seeded from the pro's stack at any window you pick. A **target
ghost** overlays your board showing where the pro placed each piece (with the
pro's incoming garbage reproduced on your board too), and after every lock the
trainer tells you whether you matched — with a running accuracy score, a
first-divergence marker, retry-on-mismatch, and an end-of-window summary.

Your live board and the pro's reconstruction both run the **same** engine
([`@haelp/teto`](https://www.npmjs.com/package/@haelp/teto)), so "stack exactly
like the pro" is physically well-defined: identical SRS+ kicks, handling, gravity,
RNG, garbage, and spin rules on each side.

---

## Running in development

The repo holds three pieces. **Only the game is required** — the two services
are optional and nothing in the game depends on them yet.

| Piece | What it is | Needs |
| --- | --- | --- |
| `src/` (repo root) | The trainer itself — a static Vite + React app | Node 18+ |
| `server/` | Python API scaffold (FastAPI + Postgres + MinIO) | Docker |
| `backend/` | Design skeleton for curated timeframes (predates `server/`) | — |

### The game (this is all you need)

```bash
npm install
npm run dev      # → http://localhost:5173
```

Then:

1. **Play free** — click the board to focus it and start stacking. Tune handling
   (ARR/DAS/SDF/DCD) and rebind keys in the Settings panel; changes apply live and
   persist to `localStorage`.
2. **Load a replay** — drag a `.ttr` (solo) or `.ttrm` (Tetra League / multiplayer)
   file onto the page (or use the Replay panel). You'll see the player, mode, and
   stats. A `.ttrm` is a whole match, so a **round + player picker** appears —
   choose which game to train against; incoming garbage is reconstructed
   frame-perfectly on that player's board. Sample files live in `test_data/`
   (`promooooooo_40l.ttr` is a 40-line 7-bag run; `promooooooo_tr.ttrm` is an
   8-round league match).
3. **Start a session** — pick a start/end window on the timeline and begin. Your
   board is seeded from the pro's stack at the window start; the target ghost shows
   the pro's next move (and any garbage they received lands on your board at the
   same point); the "Stack like the pro" panel scores each piece.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check (`tsc`) + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |

> **Node:** developed on Node 21. Use a recent LTS (18+). No env vars, no
> database — the game runs entirely in the browser.

### The API service (optional, Docker)

`server/` is a FastAPI + Postgres + MinIO stack managed by the root
`docker-compose.yml` and `Makefile`:

```bash
make up                        # build + start everything (creates .env from .env.example)
curl localhost:8000/health     # → {"status":"ok","database":"ok"}
make test                      # pytest against the throwaway db-test container
make migrate                   # alembic upgrade head on dev Postgres
make revision m="add replays"  # autogenerate a migration
make logs / make down
```

Ports: API `:8000`, Postgres `:5432`, test Postgres `:5433` (tmpfs, throwaway),
MinIO `:9000` (console `:9001`). Source is bind-mounted with `uvicorn --reload`,
so edits under `server/` hot-reload. Details and design notes:
[server/README.md](server/README.md).

`backend/` is an earlier, framework-level design skeleton for the curated
timeframes feature (schema + API contract); see
[backend/README.md](backend/README.md). It is not part of the compose stack.

### Deploying

The game builds to static files; [DEPLOY.md](DEPLOY.md) covers hosting it on a
VPS behind Nginx.

---

## Controls (defaults)

| Action | Key(s) |
| --- | --- |
| Move left / right | ← / → |
| Soft drop | ↓ |
| Hard drop | Space |
| Rotate CW | ↑ or X |
| Rotate CCW | Z or Ctrl |
| Rotate 180 | A |
| Hold | Shift or C |
| Undo / Redo piece | Ctrl+Z / Ctrl+Y |
| Restart (re-enters the session window during a session) | R or Enter |
| Toggle ghost pieces on/off | G |

How many ghost pieces show (current target only, or up to 4 look-aheads) is set
with the "Show ghost pieces" slider in the Replay panel's session settings.

The **"Show key hints"** toggle (same session settings) adds a keycap strip below
the board showing the **pro's actual key finesse** for the current piece — the
exact keydown sequence they used in the replay (rotations, moves, holds, and the
hard drop, in order), so you drill their real inputs rather than any shortest
path that merely reaches the same square. Moves that the pro **DAS-slid** (more
than one cell in one motion) are shown as an amber "HOLD … DAS" cap, distinct
from a single tap — so you learn when to hold the key vs. tap it. Tap-vs-slide is
judged from the piece's *actual column displacement* per piece, not how long the
key was down: a one-cell nudge (or a long press blocked by a wall) is a tap, and
two quick nudges read as two taps rather than one hold. And when the pro
**kept a direction held across a hard drop** so the *next* piece is already
charged and needs no fresh press, the pieces that must sustain the hold are
marked: the piece where the hold starts shows a "» DON'T RELEASE" cue (keep the
key down through the drop), and a middle piece shows a dashed "« KEEP HOLDING"
cap. The cue only appears while the hold actually continues; the last piece of
the run — where the already-charged DAS finally slides you into place — shows a
filled "⚡ DAS READY" cap instead (the meter's already full, so just let it slide
and drop), never a "hold to charge" cue for a key you're already holding. A hold
spanning three-plus pieces chains through each one. The sequence, each move's
tap-vs-slide (judged from the piece's real displacement), and any cross-piece
carried hold are captured per piece during reconstruction by bucketing the
replay's key transitions between locks; the caps show your own current bindings.

All bindings (including modifier combos like `Ctrl+Z` and `Shift`) are rebindable
in the Settings panel and persist across reloads.

---

## How it works

The hard game logic — SRS+ kicks, ARR/DAS/SDF/DCD handling, gravity, lock delay,
the 7-bag Lehmer RNG, garbage, spins, b2b — is **all** provided by the engine. This
app is the layer around it:

```
┌─────────────────────────────────────────────────────────────┐
│  UI shell (React): settings, .ttr/.ttrm load, round×player   │
│                    picker, timeline, panels                  │
├─────────────────────────────────────────────────────────────┤
│  Renderer (Canvas 2D): learner board │ garbage rows │         │
│                        next/hold │ target ghost               │
├──────────────────────────────┬──────────────────────────────┤
│  Learner engine (teto Engine)│  Pro engine (teto Engine)     │
│   • live keyboard → input    │   • driven by replay via tick()│
│   • same seed/queue as pro   │   • placement track +          │
│   • seeded per window         │     per-lock snapshots         │
│   • pro's garbage injected    │   • ige garbage → right cols   │
├──────────────────────────────┴──────────────────────────────┤
│  Orchestration: .ttr/.ttrm parse, window slicing, garbage    │
│                 delivery, exact-match comparison             │
└─────────────────────────────────────────────────────────────┘
```

**What a `.ttr` contains:** plain JSON — the game as a stream of **inputs**
(`keydown`/`keyup` with subframes) and an `options` block (`seed`, `bagtype`,
`handling`, …). No board images, no landing positions. Anything visual comes
from replaying those inputs through the engine.

**What a `.ttrm` adds:** a multiplayer match is `replay.rounds` — an array of
rounds, each an array of players. Each player carries its own input stream
**plus `ige` garbage-interaction events**, and a fully-resolved `options` block
inside its `end` event (with the multiplayer `passthrough` mode and garbage
config). Reconstructing one player is the same problem as a solo `.ttr` — the
engine's `tick()` consumes the `ige` events natively and routes garbage into the
correct columns (hole size, messiness, and all), so the target board matches the
real match exactly. `src/replay/ttrm.ts` enumerates the round×player games and
builds a chosen one into the same `ParsedReplay` the rest of the pipeline uses;
validation reproduces the match's recorded garbage-sent/received totals exactly.

**Garbage on the learner board:** the learner plays live-forward from a single
seeded snapshot and never replays the pro's incoming `ige` events, so the pro's
mid-window garbage must be reproduced deterministically. During reconstruction
each placement records the garbage that *tanked* (materialized) while that piece
was active — the real `garbage.tank` events (`{column, amount, size}`). The
session then re-inserts those exact rows into the learner's board via
`board.insertGarbage`, and getting this right took care on four fronts:

- **Ghost y is garbage-shifted.** When garbage tanks during a piece, the engine
  shifts the whole board (and the just-locked piece) up, but leaves
  `falling.location[1]` untouched — so the raw recorded `y` is that many rows too
  low. Reconstruction adds the tanked-row count back, so the target ghost lands
  *on* the piece, not buried in the stack.
- **Delivery happens after the compare.** Garbage for piece *i+1* is delivered
  only after piece *i* has been compared to the pro (`deliverIncomingGarbage`,
  called from the lock handler *after* `recordLearnerPlacement`). Injecting on the
  same lock, before the compare, would put the next piece's garbage on a
  garbage-free piece's board and fail the cell-for-cell match spuriously.
- **The inherited garbage queue is cleared.** The pro's seed snapshot carries a
  pending garbage queue; left in place the engine would tank it natively as frames
  advance *and* our injection would fire — doubling the rows. The session empties
  that queue at seed so our per-piece injection is the single source of truth.
- **Undo/redo re-arms delivery.** An `injectedThrough` watermark (not a
  once-per-piece flag) tracks the highest piece delivered on the current forward
  path; undo rolls it back so re-advancing — by redo *or* a fresh re-placement —
  re-lays the rows, and the injected garbage is folded into the engine's undo
  baseline so a redo restores it rather than losing it.

Verified end-to-end: for every arrival, seeding from `track[i-1]` and injecting
`track[i]`'s garbage reproduces `track[i]`'s garbage rows *and* hole columns
exactly; every non-clearing placement's ghost lands on its own piece; and placing
a piece like the pro across a garbage boundary scores an exact match.

**Reconstruction:** the pro engine is driven with `Engine.tick()`, events grouped
by integer frame and applied in subframe order. After each piece locks we record a
`{ pieceIndex, piece, x, y, rot, spin, clears, snapshot }` placement. The full
serializable `snapshot()` at each lock makes scrubbing and window-seeding instant —
a session seeds the learner via `fromSnapshot()` from the board state *just before*
the window's first piece, so you place that piece yourself.

**Exact-match comparison:** the resulting board cells are the ground truth. A
placement matches when your post-lock occupancy equals the pro's — column and
rotation are only *reported* to explain a genuine mismatch, since the same physical
placement can be reached via different anchor coordinates (e.g. a flat I-piece at
rotation 0 vs 2). The running score is **derived** from the per-piece results of
the pieces currently on your board, so undo, redo, and retry are all reflected
correctly.

---

## Project layout

```
src/
  engine/       adapter.ts — the ONLY module that touches @haelp/teto
  render/       Canvas 2D renderer, RAF/fixed-timestep loops, garbage indicator
  input/        keyboard → engine-action bridge, rebindable keymap
  game/         game loop, live PPS/APM stats
  settings/     handling + keybinding store, persistence, React panel
  replay/       .ttr + .ttrm parsers, option defaults, pro reconstruction, Zenith cap
  session/      session orchestration, garbage delivery, "stack like the pro" comparison
  main.tsx      wires it all together
test_data/      sample replays: .ttr (40L, Zenith) + .ttrm (8-round league match)
server/         FastAPI + Postgres + MinIO service (Docker; see server/README.md)
backend/        curated-timeframes design skeleton (see backend/README.md)
instructions.md the original build plan & prompt series
```

---

## Design constraints

Two hard rules from the build plan, honored throughout:

1. **Engine-only imports.** App code imports **only** from `@haelp/teto/engine`
   (and type-only from `@haelp/teto/types`) via the single adapter in
   `src/engine/adapter.ts`. The library's `Client`/bot API — which talks to
   TETR.IO's servers and carries account-ban risk — is **never** imported or
   instantiated. This also keeps a future engine swap localized to one file.

2. **Engine-supported bags only for reconstruction.** The engine supports
   `7-bag`, `14-bag`, `classic`, `pairs`, `total mayhem`, and `7+1/7+2/7+x-bag` —
   so **40L and Blitz** reconstruct fully. **Zenith is partially
   supported**: its custom bag RNG is unimplemented anywhere outside TETR.IO's
   client, but it matches plain 7-bag for the early game, so Zenith replays are
   reconstructed with a 7-bag stand-in and **capped where the queue drifts**
   (detected as a physically impossible clearless run — see
   `src/replay/zenith.ts`). A caption in the Replay panel explains the cap.

---

## Testing

The Vitest suite (`npm test`) covers the pure and load-bearing logic:

- **Golden reconstruction** — a bundled 40L `.ttr` must reproduce its known piece
  and line counts.
- **Adapter isolation** — app code never imports the library directly.
- **Determinism** — same `seed` + `bagtype` yields an identical queue on both
  engines.
- **Comparison logic** — kept pure: match, wrong-column, wrong-rotation,
  spin/clear-mismatch, retry (no double-count), and post-window guarding.
- **`.ttrm` parsing & garbage fidelity** — a bundled Tetra League match
  enumerates its round×player games and reconstructs a chosen one, reproducing its
  recorded garbage-sent/received totals exactly (the engine routes the `ige`
  events into the right columns). Each incoming attack is captured as a
  `garbage.tank` and the placement `y` is recorded in the garbage-shifted frame so
  the ghost lands on the piece.
- **Learner garbage delivery** — mid-window garbage is injected onto the learner
  board only *after* the current piece is compared, exactly once per arrival, with
  the inherited queue cleared so nothing double-tanks; and it survives undo/redo
  and fresh re-placements across a garbage boundary.

---

## Tech stack

Vite · TypeScript · React 18 · Vitest · `@haelp/teto` engine · Canvas 2D.

---

## Notes & attribution

- `@haelp/teto` is an unofficial, community-maintained TETR.IO engine. The version
  is pinned; confirm its license terms before redistributing.
- Bring your own replays for now (drag in your own `.ttr` or `.ttrm`). If you
  later source replays, attribute the pro players and prefer the community Inoue
  API over hitting TETR.IO directly.
