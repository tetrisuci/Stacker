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
}

export interface ReplayPanelProps {
  /**
   * Render a placement snapshot to the shared board, or null to leave review
   * mode and resume live play.
   */
  onReviewSnapshot?: (snapshot: EngineSnapshot | null) => void;
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
}

export function ReplayPanel({
  onReviewSnapshot,
  onStartSession,
  onEndSession,
  comparison,
}: ReplayPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const loadSeq = useRef(0);

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

  const handleText = useCallback(
    (text: string) => {
      setError(null);
      onReviewSnapshot?.(null); // leave any prior review
      const result = parseReplay(text);
      if (!result.ok) {
        setError(result.error);
        setLoaded(null);
        return;
      }
      // A newly loaded replay invalidates any session running on the old one.
      onEndSession?.();
      const replay = result.replay;
      const support = checkReconstructionSupport(replay);

      const state: LoadedState = {
        id: ++loadSeq.current,
        replay,
        supported: support.supported,
        supportReason: support.reason,
      };

      if (support.supported) {
        try {
          state.result = reconstructReplay(replay);
          // Approximate (Zenith) reconstructions: cut the track where the
          // 7-bag stand-in drifts from the real queue, so the stepper and the
          // training window only offer trustworthy pieces.
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
      setLoaded(state);
    },
    [onReviewSnapshot, onEndSession],
  );

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => handleText(String(reader.result ?? ""));
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
        <p>Drop a .ttr file here</p>
        <label className="file-label">
          or choose a file
          <input
            type="file"
            accept=".ttr,application/json"
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

      {loaded && (
        <ReplayMetaView
          key={loaded.id}
          state={loaded}
          onReviewSnapshot={onReviewSnapshot}
          onStartSession={onStartSession}
          onEndSession={onEndSession}
          comparison={comparison}
        />
      )}
    </section>
  );
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits).replace(/\.00$/, "");
}

function ReplayMetaView({
  state,
  onReviewSnapshot,
  onStartSession,
  onEndSession,
  comparison,
}: {
  state: LoadedState;
  onReviewSnapshot?: (snapshot: EngineSnapshot | null) => void;
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
  onStartSession,
  onEndSession,
  comparison,
}: {
  replay: ParsedReplay;
  result: ReconstructionResult;
  onStartSession?: ReplayPanelProps["onStartSession"];
  onEndSession?: ReplayPanelProps["onEndSession"];
  comparison?: ComparisonStore;
}) {
  const last = result.track.length - 1;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(last);
  const [active, setActive] = useState(false);

  // Keep start <= end.
  const setStartClamped = (v: number) => {
    const s = Math.max(0, Math.min(v, last));
    setStart(s);
    if (s > end) setEnd(s);
  };
  const setEndClamped = (v: number) => {
    const e = Math.max(0, Math.min(v, last));
    setEnd(e);
    if (e < start) setStart(e);
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
        to compare with TETR.IO's playback.
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
