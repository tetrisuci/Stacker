import { useSyncExternalStore } from "react";
import type { ComparisonStore } from "./comparisonStore";
import type { MatchResult } from "./compare";

/** Human-readable list of what diverged in a mismatch. */
function mismatchReasons(m: MatchResult): string[] {
  const reasons: string[] = [];
  if (m.pieceMismatch) reasons.push("different piece");
  if (m.columnMismatch) reasons.push("wrong column");
  if (m.rotationMismatch) reasons.push("wrong rotation");
  if (m.cellsMismatch) reasons.push("different cells");
  if (m.spinMismatch) reasons.push("spin differs");
  if (m.clearMismatch) reasons.push("clears differ");
  return reasons;
}

export function ComparisonPanel({
  store,
  onRetry,
}: {
  store: ComparisonStore;
  onRetry: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!state.active) return null;

  const { divergence: d, lastMatch, summary } = state;
  const proName = state.proName ?? "the pro";
  const accuracy =
    d.compared > 0 ? Math.round((d.matched / d.compared) * 100) : 100;
  const mismatch = lastMatch && !lastMatch.match;

  return (
    <section className="compare">
      <h3>Stack like {proName}</h3>

      {summary ? (
        <div className="compare-summary">
          <p className="compare-verdict">Window complete</p>
          <dl>
            <div className="meta-row">
              <dt>Pieces matched</dt>
              <dd>
                {summary.piecesMatched} / {summary.piecesCompared}
              </dd>
            </div>
            <div className="meta-row">
              <dt>First divergence</dt>
              <dd>
                {summary.firstDivergence === null
                  ? "none 🎉"
                  : `piece ${summary.firstDivergence}`}
              </dd>
            </div>
            <div className="meta-row">
              <dt>Holes vs {proName}</dt>
              <dd>{fmtDelta(summary.holesDelta)}</dd>
            </div>
            <div className="meta-row">
              <dt>Bumpiness vs {proName}</dt>
              <dd>{fmtDelta(summary.bumpinessDelta)}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <>
          <div className="compare-stats">
            <span className="compare-accuracy">{accuracy}%</span>
            <span className="compare-count">
              {d.matched}/{d.compared} matched
            </span>
          </div>
          {d.firstDivergence !== null && (
            <p className="compare-diverged">
              First divergence at piece {d.firstDivergence}
            </p>
          )}
          {mismatch && lastMatch && (
            <div className="compare-mismatch">
              <p>Mismatch: {mismatchReasons(lastMatch).join(", ")}</p>
              <button type="button" className="retry-btn" onClick={onRetry}>
                ↺ Retry piece
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function fmtDelta(n: number): string {
  if (n === 0) return "±0";
  return n > 0 ? `+${n}` : String(n);
}
