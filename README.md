# TETR.IO Stacking Trainer

Replay a top player's `.ttr` next to your own live board and practice reproducing
their stacking **exactly** — same piece sequence, same faithful TETR.IO physics on
both sides.

The pro's run is reconstructed from their replay and shown on the left; you play
the identical queue on the right, seeded from the pro's board at any window you
pick. A **target ghost** shows where the pro placed each piece, and after every
lock the trainer tells you whether you matched — with a running accuracy score, a
first-divergence marker, retry-on-mismatch, and an end-of-window summary.

Both boards run the **same** engine ([`@haelp/teto`](https://www.npmjs.com/package/@haelp/teto)),
so "stack exactly like the pro" is physically well-defined: identical SRS+ kicks,
handling, gravity, RNG, garbage, and spin rules on each side.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

Then:

1. **Play free** — click the board to focus it and start stacking. Tune handling
   (ARR/DAS/SDF/DCD) and rebind keys in the Settings panel; changes apply live and
   persist to `localStorage`.
2. **Load a replay** — drag a `.ttr` file onto the page (or use the Replay panel).
   You'll see the player, mode, and stats. Sample files live in `test_data/`
   (`promooooooo_40l.ttr` is a 40-line 7-bag run that reconstructs).
3. **Start a session** — pick a start/end window on the timeline and begin. The
   pro board plays back in lockstep with your placements; the target ghost shows
   the pro's next move; the "Stack like the pro" panel scores each piece.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check (`tsc`) + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |

> **Node:** developed on Node 21. Use a recent LTS (18+).

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
| Restart | R or Enter |
| Toggle look-ahead ghost | G |

All bindings (including modifier combos like `Ctrl+Z` and `Shift`) are rebindable
in the Settings panel and persist across reloads.

---

## How it works

The hard game logic — SRS+ kicks, ARR/DAS/SDF/DCD handling, gravity, lock delay,
the 7-bag Lehmer RNG, garbage, spins, b2b — is **all** provided by the engine. This
app is the layer around it:

```
┌─────────────────────────────────────────────────────────────┐
│  UI shell (React): settings, .ttr load, timeline, panels     │
├─────────────────────────────────────────────────────────────┤
│  Renderer (Canvas 2D): pro board │ learner board │ garbage    │
│                        bars │ next/hold │ target ghost        │
├──────────────────────────────┬──────────────────────────────┤
│  Learner engine (teto Engine)│  Pro engine (teto Engine)     │
│   • live keyboard → input    │   • driven by .ttr via tick() │
│   • same seed/queue as pro   │   • placement track +          │
│   • seeded per window        │     per-lock snapshots         │
├──────────────────────────────┴──────────────────────────────┤
│  Orchestration: .ttr parse, window slicing, exact-match       │
│                 comparison, garbage mirroring                 │
└─────────────────────────────────────────────────────────────┘
```

**What a `.ttr` contains:** plain JSON — the game as a stream of **inputs**
(`keydown`/`keyup` with subframes, plus `ige` garbage events) and an
`options` block (`seed`, `bagtype`, `handling`, …). No board images, no landing
positions. Anything visual comes from replaying those inputs through the engine.

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
  replay/       .ttr parser, option defaults, pro reconstruction, Zenith gating
  session/      dual-board orchestration + pure "stack like the pro" comparison
  main.tsx      wires it all together
test_data/      sample .ttr files (40L reconstructs; Zenith is parse-only)
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

2. **7-bag modes only for reconstruction.** The engine supports `7-bag`,
   `14-bag`, `classic`, `pairs`, `total mayhem`, and `7+1/7+2/7+x-bag`. **Zenith is
   not supported** (custom board/garbage config, no matching bag RNG), so target
   **40L, Blitz, Tetra League, and Quick Play**. Zenith replays still parse and
   show metadata, but reconstruction is gated behind a clear "mode not supported"
   message.

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

---

## Tech stack

Vite · TypeScript · React 18 · Vitest · `@haelp/teto` engine · Canvas 2D.

---

## Notes & attribution

- `@haelp/teto` is an unofficial, community-maintained TETR.IO engine. The version
  is pinned; confirm its license terms before redistributing.
- Bring your own replays for now (drag in your own `.ttr`). If you later source
  replays, attribute the pro players and prefer the community Inoue API over
  hitting TETR.IO directly.
