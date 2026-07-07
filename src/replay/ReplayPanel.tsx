import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  parseReplay,
  checkReconstructionSupport,
  type ParsedReplay,
} from "./parse";
import {
  parseMatch,
  buildGameReplay,
  isMatchReplay,
  type ParsedMatch,
} from "./ttrm";
import { reconstructReplay, type ReconstructionResult } from "./reconstruct";
import { capReconstruction, detectDriftCap } from "./zenith";
import type { EngineSnapshot } from "../engine/adapter";
import type { ComparisonStore } from "../session/comparisonStore";

interface LoadedState {
  /**
   * Monotonic per-load id, used as a React key so the stepper and session
   * controls remount with fresh state on every load. Without it their slider
   * state (start/end/index) survives a file switch, and a stale index into a
   * *shorter* new track crashes the render and unmounts the whole panel.
   */
  id: number;
  replay: ParsedReplay;
  supported: boolean;
  supportReason?: string;
  result?: ReconstructionResult;
  error?: string;
  /** Set for approximate reconstructions (Zenith): caption + drift cap info. */
  partial?: { note: string; cappedAt: number | null; total: number };
  /** Set when the load came from a deep link (/train?segment=…): the window
   * to preselect and whether to start the session immediately. */
  auto?: AutoSession;
}

interface AutoSession {
  window?: { start: number; end: number };
  autoStart?: boolean;
}

/** A programmatic load (e.g. "Practice" on a browsed segment): the replay
 * text plus the session window to preselect/start. `key` dedupes — the same
 * segment isn't re-loaded on unrelated re-renders. */
export interface AutoLoad {
  key: string;
  text: string;
  filename: string;
  window?: { start: number; end: number };
  autoStart?: boolean;
}

/**
 * Turn a parsed `.ttr` replay into a LoadedState: run the support check and
 * (if supported) the reconstruction, capping approximate Zenith runs where the
 * queue drifts.
 */
function reconstructToState(
  replay: ParsedReplay,
  id: number,
  auto?: AutoSession,
): LoadedState {
  const support = checkReconstructionSupport(replay);
  const state: LoadedState = {
    id,
    replay,
    supported: support.supported,
    supportReason: support.reason,
    auto,
  };
  if (support.supported) {
    try {
      state.result = reconstructReplay(replay);
      if (support.partial) {
        const total = state.result.track.length;
        const cap = detectDriftCap(state.result.track);
        if (cap !== null) {
          state.result = capReconstruction(state.result, cap);
        }
        state.partial = { note: support.partial, cappedAt: cap, total };
      }
    } catch (e) {
      state.error = `Reconstruction failed: ${(e as Error).message}`;
    }
  }
  return state;
}

/** A successfully loaded + reconstructed replay, as surfaced to the view. */
export interface LoadedReplay {
  replay: ParsedReplay;
  result: ReconstructionResult;
  /** The raw .ttr text and filename (for uploading alongside a segment). */
  rawText: string;
  filename: string;
}

export interface ReplayPanelProps {
  /**
   * Render a placement snapshot to the shared board, or null to leave review
   * mode and resume live play.
   */
  onReviewSnapshot?: (snapshot: EngineSnapshot | null) => void;
  /** Fired when a replay finishes (re)loading — null when load failed. */
  onLoadedChange?: (loaded: LoadedReplay | null) => void;
  /** Fired whenever the training-window sliders move (and on load). */
  onWindowChange?: (window: { start: number; end: number }) => void;
  /** Start a dual-board training session over the chosen window. */
  onStartSession?: (
    replay: ParsedReplay,
    result: ReconstructionResult,
    window: { start: number; end: number },
  ) => void;
  /** End the active training session, returning to free play. */
  onEndSession?: () => void;
  /**
   * Comparison display state; when provided, the session settings include a
   * control for how many pieces ahead to ghost on the learner board.
   */
  comparison?: ComparisonStore;
  /** Programmatic load: feed this replay text through the normal load path
   * (parse → reconstruct), preselect its window, optionally auto-start. */
  autoLoad?: AutoLoad | null;
}

export function ReplayPanel({
  onReviewSnapshot,
  onLoadedChange,
  onWindowChange,
  onStartSession,
  onEndSession,
  comparison,
  autoLoad,
}: ReplayPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [match, setMatch] = useState<ParsedMatch | null>(null);
  const [selected, setSelected] = useState<{ round: number; player: number }>({
    round: 0,
    player: 0,
  });
  const [dragOver, setDragOver] = useState(false);
  const loadSeq = useRef(0);
  // Raw text + filename of the currently loaded file, so the match selector can
  // rebuild a different game (they aren't re-supplied on a dropdown change).
  const source = useRef<{ text: string; filename: string }>({
    text: "",
    filename: "replay.ttr",
  });

  // A drop that misses the dropzone would otherwise make the browser navigate
  // to the file, replacing the whole app. Swallow stray drags page-wide.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Reconstruct a ParsedReplay and publish it as the loaded state. Shared by the
  // solo `.ttr` path and the `.ttrm` game selector (which re-invokes it on every
  // round/player change). `rawText` is retained for segment publishing.
  //
  // Ending the prior session happens HERE, on a successful (re)load, rather than
  // up-front in handleText — so a failed parse of a dropped file leaves the
  // running session intact instead of tearing it down for nothing.
  const publishReplay = useCallback(
    (
      replay: ParsedReplay,
      rawText: string,
      filename: string,
      auto?: AutoSession,
    ) => {
      onEndSession?.();
      const state = reconstructToState(replay, ++loadSeq.current, auto);
      setLoaded(state);
      onLoadedChange?.(
        state.result
          ? { replay, result: state.result, rawText, filename }
          : null,
      );
    },
    [onEndSession, onLoadedChange],
  );

  const handleText = useCallback(
    (text: string, filename = "replay.ttr", auto?: AutoSession) => {
      setError(null);
      onReviewSnapshot?.(null); // leave any prior review
      // Note: any running session is ended in publishReplay, on a *successful*
      // load — so a failed parse below leaves the current session intact.
      setMatch(null);
      setSelected({ round: 0, player: 0 });
      source.current = { text, filename };

      let root: unknown = null;
      try {
        root = JSON.parse(text);
      } catch {
        // Let parseReplay produce the precise JSON error message below.
      }

      // A multiplayer `.ttrm` is a match of many round×player games; parse it and
      // load the first game, exposing a selector for the rest.
      if (isMatchReplay(root)) {
        const parsed = parseMatch(text);
        if (!parsed.ok) {
          setError(parsed.error);
          setLoaded(null);
          onLoadedChange?.(null);
          return;
        }
        setMatch(parsed.match);
        const first = buildGameReplay(parsed.match, 0, 0);
        if (!first.ok) {
          setError(first.error);
          setLoaded(null);
          onLoadedChange?.(null);
          return;
        }
        publishReplay(first.replay, text, filename, auto);
        return;
      }

      const result = parseReplay(text);
      if (result.ok) {
        publishReplay(result.replay, text, filename, auto);
        return;
      }

      setError(result.error);
      setLoaded(null);
      onLoadedChange?.(null);
    },
    [onReviewSnapshot, onLoadedChange, publishReplay],
  );

  // Switch to a different game (round × player) within a loaded match.
  const selectGame = useCallback(
    (round: number, player: number) => {
      if (!match) return;
      setError(null);
      onReviewSnapshot?.(null);
      setSelected({ round, player });
      const g = buildGameReplay(match, round, player);
      if (!g.ok) {
        setError(g.error);
        return;
      }
      // publishReplay ends any running session (only on this successful switch).
      publishReplay(g.replay, source.current.text, source.current.filename);
    },
    [match, onReviewSnapshot, publishReplay],
  );

  // Programmatic loads (Practice deep links) run through the exact same
  // handleText → parse → reconstruct path as a dropped file; `key` makes the
  // load idempotent across re-renders.
  const autoKey = useRef<string | null>(null);
  useEffect(() => {
    if (!autoLoad || autoLoad.key === autoKey.current) return;
    autoKey.current = autoLoad.key;
    handleText(autoLoad.text, autoLoad.filename, {
      window: autoLoad.window,
      autoStart: autoLoad.autoStart,
    });
  }, [autoLoad, handleText]);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => handleText(String(reader.result ?? ""), file.name);
      reader.onerror = () => setError("Could not read file.");
      reader.readAsText(file);
    },
    [handleText],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <section className="replay">
      <h3>Replay</h3>
      <div
        className={`dropzone${dragOver ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <p>Drop a .ttr or .ttrm file here</p>
        <label className="file-label">
          or choose a file
          <input
            type="file"
            accept=".ttr,.ttrm,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              // Allow re-selecting the same file to reload it.
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {error && <p className="replay-error">{error}</p>}

      {match && (
        <MatchSelector
          match={match}
          selected={selected}
          onSelect={selectGame}
        />
      )}

      {loaded && (
        <ReplayMetaView
          key={loaded.id}
          state={loaded}
          onReviewSnapshot={onReviewSnapshot}
          onWindowChange={onWindowChange}
          onStartSession={onStartSession}
          onEndSession={onEndSession}
          comparison={comparison}
        />
      )}
    </section>
  );
}

/**
 * Round + player pickers for a loaded multiplayer `.ttrm` match. A match holds
 * many round×player games; picking one rebuilds the loaded replay (and its
 * garbage-accurate reconstruction) via `onSelect`.
 */
function MatchSelector({
  match,
  selected,
  onSelect,
}: {
  match: ParsedMatch;
  selected: { round: number; player: number };
  onSelect: (round: number, player: number) => void;
}) {
  // Players available in the currently selected round (usually two).
  const playersInRound = match.games.filter((g) => g.round === selected.round);

  return (
    <div className="match-selector">
      <p className="match-selector-title">
        Tetra League match — {match.rounds} rounds. Pick a game to train against:
      </p>
      <div className="match-selector-controls">
        <label>
          Round
          <select
            value={selected.round}
            onChange={(e) => {
              const round = Number(e.target.value);
              // Keep the same player slot if it exists in the new round, else 0.
              const hasSlot = match.games.some(
                (g) => g.round === round && g.player === selected.player,
              );
              onSelect(round, hasSlot ? selected.player : 0);
            }}
          >
            {Array.from({ length: match.rounds }, (_, r) => (
              <option key={r} value={r}>
                Round {r + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          Player
          <select
            value={selected.player}
            onChange={(e) => onSelect(selected.round, Number(e.target.value))}
          >
            {playersInRound.map((g) => (
              <option key={g.player} value={g.player}>
                {g.username}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits).replace(/\.00$/, "");
}

function ReplayMetaView({
  state,
  onReviewSnapshot,
  onWindowChange,
  onStartSession,
  onEndSession,
  comparison,
}: {
  state: LoadedState;
  onReviewSnapshot?: (snapshot: EngineSnapshot | null) => void;
  onWindowChange?: ReplayPanelProps["onWindowChange"];
  onStartSession?: ReplayPanelProps["onStartSession"];
  onEndSession?: ReplayPanelProps["onEndSession"];
  comparison?: ComparisonStore;
}) {
  const { replay } = state;
  const m = replay.metadata;
  const rows: Array<[string, string]> = [
    ["Player", m.username],
    ["Mode", m.gamemode],
    ["Duration", `${m.durationSec.toFixed(1)}s (${m.frames} frames)`],
    ["Seed", m.seed === null ? "—" : String(m.seed)],
    ["Bag type", m.bagtype ?? "—"],
    ["Has garbage", m.hasgarbage === null ? "—" : m.hasgarbage ? "yes" : "no"],
    ["PPS", fmt(m.stats.pps)],
    ["APM", fmt(m.stats.apm)],
    ["Lines", fmt(m.stats.lines, 0)],
    ["Pieces", fmt(m.stats.pieces, 0)],
  ];

  return (
    <div className="replay-meta">
      <dl>
        {rows.map(([k, v]) => (
          <div className="meta-row" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      {replay.warnings.length > 0 && (
        <ul className="replay-warnings">
          {replay.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {state.partial && (
        <p className="replay-partial">
          ⚠ {state.partial.note}
          {state.partial.cappedAt !== null &&
            ` Capped at piece ${state.partial.cappedAt} of ${state.partial.total}, where the reconstruction drifts.`}
        </p>
      )}

      {!state.supported ? (
        <p className="replay-unsupported">{state.supportReason}</p>
      ) : state.error ? (
        <p className="replay-error">{state.error}</p>
      ) : state.result ? (
        state.result.track.length === 0 ? (
          <p className="replay-unsupported">
            No usable placements could be reconstructed from this replay.
          </p>
        ) : (
          <>
            <ReplayStepper
              result={state.result}
              onReviewSnapshot={onReviewSnapshot}
            />
            <SessionControls
              replay={replay}
              result={state.result}
              auto={state.auto}
              onReviewSnapshot={onReviewSnapshot}
              onWindowChange={onWindowChange}
              onStartSession={onStartSession}
              onEndSession={onEndSession}
              comparison={comparison}
            />
          </>
        )
      ) : null}
    </div>
  );
}

function SessionControls({
  replay,
  result,
  auto,
  onReviewSnapshot,
  onWindowChange,
  onStartSession,
  onEndSession,
  comparison,
}: {
  replay: ParsedReplay;
  result: ReconstructionResult;
  auto?: AutoSession;
  onReviewSnapshot?: ReplayPanelProps["onReviewSnapshot"];
  onWindowChange?: ReplayPanelProps["onWindowChange"];
  onStartSession?: ReplayPanelProps["onStartSession"];
  onEndSession?: ReplayPanelProps["onEndSession"];
  comparison?: ComparisonStore;
}) {
  const last = result.track.length - 1;
  // Deep-linked loads preselect their segment's window (clamped: a partial
  // Zenith reconstruction may be shorter than the published window).
  const [start, setStart] = useState(() =>
    Math.max(0, Math.min(auto?.window?.start ?? 0, last)),
  );
  const [end, setEnd] = useState(() =>
    Math.max(0, Math.min(auto?.window?.end ?? last, last)),
  );
  const [active, setActive] = useState(false);

  // Auto-start once per load — this component remounts per load (keyed by
  // the panel's load id), so a mount-time effect is exactly once.
  useEffect(() => {
    if (!auto?.autoStart) return;
    onStartSession?.(replay, result, { start, end });
    setActive(true);
    // mount-only by design; the deps are stable for a given load
    // (auto/replay/result all change only via a remount).
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface the selection to the view (initial value + every slider move) so
  // the publish panel can bind to the same WindowSelection.
  useEffect(() => {
    onWindowChange?.({ start, end });
  }, [start, end, onWindowChange]);

  // Dragging a window slider previews the board at that piece on the main
  // board — the same review mechanism as the playback stepper (and the same
  // indexing: the snapshot after the piece whose frame the label shows).
  // Suppressed while a session runs so it can't override live play.
  const preview = (i: number) => {
    if (active) return;
    const at = result.track[i];
    if (at) onReviewSnapshot?.(at.snapshot);
  };

  // Keep start <= end.
  const setStartClamped = (v: number) => {
    const s = Math.max(0, Math.min(v, last));
    setStart(s);
    if (s > end) setEnd(s);
    preview(s);
  };
  const setEndClamped = (v: number) => {
    const e = Math.max(0, Math.min(v, last));
    setEnd(e);
    if (e < start) setStart(e);
    preview(e);
  };

  const startAt = result.track[start];
  const endAt = result.track[end];

  return (
    <div className="session">
      <h4 className="session-title">Training window</h4>
      <p className="section-help">
        Pick a start/end piece; the learner starts from{" "}
        {`${replay.metadata.username}'s`} board there and plays the same pieces.
      </p>

      <div className="session-field">
        <label>
          Start piece <b>{start}</b>
          <span className="session-frame">frame {startAt.frame}</span>
        </label>
        <input
          type="range"
          min={0}
          max={last}
          value={start}
          onChange={(e) => setStartClamped(Number(e.target.value))}
        />
      </div>

      <div className="session-field">
        <label>
          End piece <b>{end}</b>
          <span className="session-frame">frame {endAt.frame}</span>
        </label>
        <input
          type="range"
          min={0}
          max={last}
          value={end}
          onChange={(e) => setEndClamped(Number(e.target.value))}
        />
      </div>

      <p className="session-window">
        Window: {end - start + 1} pieces ({start}–{end})
      </p>

      {comparison && <LookaheadField store={comparison} />}
      {comparison && <KeyHintsField store={comparison} />}

      {!active ? (
        <button
          type="button"
          className="session-start"
          onClick={() => {
            onStartSession?.(replay, result, { start, end });
            setActive(true);
          }}
        >
          ▶ Start session
        </button>
      ) : (
        <button
          type="button"
          className="session-end"
          onClick={() => {
            onEndSession?.();
            setActive(false);
          }}
        >
          ■ End session
        </button>
      )}
    </div>
  );
}

/**
 * "Show ghost pieces" slider: how many pro placements to ghost on the learner
 * board, starting with the current target (0 = no ghosts, 1 = the current
 * target only). Lives with the session settings and applies live.
 */
function LookaheadField({ store }: { store: ComparisonStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const n = state.lookahead;
  return (
    <div className="session-field">
      <label>
        Show ghost pieces <b>{n}</b>
        <span className="session-frame">
          {n === 0
            ? "off"
            : n === 1
              ? "current target"
              : `target + ${n - 1} ahead`}
        </span>
      </label>
      <input
        type="range"
        min={0}
        max={5}
        value={n}
        onChange={(e) => store.set({ lookahead: Number(e.target.value) })}
      />
    </div>
  );
}

/**
 * "Show key hints" toggle: display the pro's actual key finesse for the current
 * piece (from the replay) as a keycap strip below the board.
 */
function KeyHintsField({ store }: { store: ComparisonStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <label className="session-check">
      <input
        type="checkbox"
        checked={state.keyHints}
        onChange={(e) => store.set({ keyHints: e.target.checked })}
      />
      <span>Show key hints</span>
      <span className="session-frame">the pro's finesse</span>
    </label>
  );
}

function ReplayStepper({
  result,
  onReviewSnapshot,
}: {
  result: ReconstructionResult;
  onReviewSnapshot?: (snapshot: EngineSnapshot | null) => void;
}) {
  const total = result.track.length;
  // index in [-1, total-1]; -1 means "before the first placement" (empty board
  // via the initial live board is not tracked, so we clamp the stepper to 0..).
  const [index, setIndex] = useState(0);

  const show = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(total - 1, i));
      setIndex(clamped);
      onReviewSnapshot?.(result.track[clamped]?.snapshot ?? null);
    },
    [total, result.track, onReviewSnapshot],
  );

  const current = result.track[index];

  return (
    <div className="stepper">
      <p className="replay-ok">
        ✓ Reconstructed {total} placements ({result.lines} lines). Step through
        to compare with the original playback.
      </p>

      <div className="stepper-controls">
        <button type="button" onClick={() => show(0)} disabled={index <= 0}>
          ⏮
        </button>
        <button
          type="button"
          onClick={() => show(index - 1)}
          disabled={index <= 0}
        >
          ◀ Prev
        </button>
        <span className="stepper-pos">
          {index + 1} / {total}
        </span>
        <button
          type="button"
          onClick={() => show(index + 1)}
          disabled={index >= total - 1}
        >
          Next ▶
        </button>
        <button
          type="button"
          onClick={() => show(total - 1)}
          disabled={index >= total - 1}
        >
          ⏭
        </button>
      </div>

      <input
        type="range"
        className="stepper-slider"
        min={0}
        max={Math.max(0, total - 1)}
        value={index}
        onChange={(e) => show(Number(e.target.value))}
      />

      {current && (
        <div className="stepper-info">
          <span>
            #{current.pieceIndex} {current.piece.toUpperCase()}
            {current.wasHold ? " (hold)" : ""}
          </span>
          <span>frame {current.frame}</span>
          <span>
            {current.spin !== "none" ? `${current.spin}-spin ` : ""}
            {current.clears > 0 ? `${current.clears} cleared` : ""}
          </span>
        </div>
      )}

      <button
        type="button"
        className="stepper-exit"
        onClick={() => onReviewSnapshot?.(null)}
      >
        Exit review (resume live play)
      </button>
    </div>
  );
}
