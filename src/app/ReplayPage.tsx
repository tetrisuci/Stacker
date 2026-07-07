// /replay/:id — a stored replay's metadata plus every segment curated from
// it, and /segment/:id — one segment in full (thumbnail, hints, votes).

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getReplay,
  getSegment,
  segmentThumbnailUrl,
  type ReplayDto,
  type SegmentDto,
  type SegmentWithReplayDto,
} from "../api/client";
import { ReportButton } from "./ReportButton";
import { difficultyLabel, SegmentCard, VoteButtons } from "./SegmentCard";

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits).replace(/\.00$/, "");
}

export function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  const [replay, setReplay] = useState<
    (ReplayDto & { segments: SegmentDto[] }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setReplay(null);
    setError(null);
    getReplay(id).then(setReplay, () => setError("Replay not found."));
  }, [id]);

  if (error) {
    return (
      <section className="page">
        <h2>Replay</h2>
        <p className="browse-error">{error}</p>
      </section>
    );
  }
  if (!replay) {
    return (
      <section className="page">
        <p className="browse-loading">Loading…</p>
      </section>
    );
  }

  return (
    <section className="page replay-page">
      <h2>
        <Link to={`/player/${replay.playerUsername}`}>
          {replay.playerUsername}
        </Link>
        {" — "}
        {replay.gamemode}
      </h2>
      <p className="replay-page-meta">
        <span>{fmt(replay.pps)} pps</span>
        <span>{fmt(replay.apm)} apm</span>
        <span>{replay.pieceCount ?? "—"} pieces</span>
        <span>{replay.filename}</span>
        <span>
          uploaded {new Date(replay.uploadedAt).toLocaleDateString()}
          {replay.uploaderUsername ? ` by ${replay.uploaderUsername}` : ""}
        </span>
        {!replay.reconstructable && (
          <span className="replay-page-warn">
            ⚠ not reconstructable{" "}
            {replay.reconstructableReason
              ? `(${replay.reconstructableReason})`
              : ""}
          </span>
        )}
      </p>

      <h3>Segments ({replay.segments.length})</h3>
      {replay.segments.length === 0 ? (
        <p className="browse-empty">
          Nothing curated from this replay yet. Load it in the trainer, pick a
          window, and publish the first segment.
        </p>
      ) : (
        <div className="browse-grid">
          {replay.segments.map((s) => (
            <SegmentCard key={s.id} segment={s} replay={replay} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Hint stats are author-computed and stored unverified; render the known
 * shape defensively (any of the fields may be missing). */
function HintStats({ hints }: { hints: Record<string, unknown> }) {
  const metrics = (hints.boardMetrics ?? {}) as Record<string, unknown>;
  const rows: Array<[string, unknown]> = [
    ["Pieces", hints.pieces],
    ["Clears", hints.clears],
    ["Spins", hints.spins],
    ["Holds", hints.holds],
    ["Holes", metrics.holes],
    ["Bumpiness", metrics.bumpiness],
    ["Height", metrics.aggregateHeight],
  ];
  const shown = rows.filter(([, v]) => typeof v === "number");
  if (shown.length === 0) return null;
  return (
    <dl className="segment-hints">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SegmentPage() {
  const { id } = useParams<{ id: string }>();
  const [segment, setSegment] = useState<SegmentWithReplayDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setSegment(null);
    setError(null);
    getSegment(id).then(setSegment, () => setError("Segment not found."));
  }, [id]);

  if (error) {
    return (
      <section className="page">
        <h2>Segment</h2>
        <p className="browse-error">{error}</p>
      </section>
    );
  }
  if (!segment) {
    return (
      <section className="page">
        <p className="browse-loading">Loading…</p>
      </section>
    );
  }

  const replay = segment.replay;
  return (
    <section className="page segment-page">
      <div className="segment-detail">
        <div className="segment-detail-thumb">
          {segment.thumbnailKey ? (
            <img src={segmentThumbnailUrl(segment.id)} alt="" />
          ) : (
            <span className="card-thumb-empty">no preview</span>
          )}
        </div>
        <div className="segment-detail-body">
          <h2>{segment.title}</h2>
          <p className="card-meta">
            <Link to={`/player/${replay.playerUsername}`}>
              {replay.playerUsername}
            </Link>
            <span className="card-mode">{replay.gamemode}</span>
            {segment.difficulty != null && (
              <span className="card-difficulty">
                {difficultyLabel(segment.difficulty)}
              </span>
            )}
            <span className="card-window">
              pieces {segment.startPiece}–{segment.endPiece}
            </span>
          </p>
          {segment.description && (
            <p className="segment-description">{segment.description}</p>
          )}
          {segment.tagSlugs.length > 0 && (
            <p className="card-tags">
              {segment.tagSlugs.map((slug) => (
                <span key={slug} className="tag-chip static">
                  {slug}
                </span>
              ))}
            </p>
          )}
          {segment.hints && <HintStats hints={segment.hints} />}
          <p className="segment-byline">
            curated by {segment.authorUsername ?? "anonymous"} ·{" "}
            {new Date(segment.createdAt).toLocaleDateString()} ·{" "}
            {segment.verified ? "verified" : "unverified"} · from{" "}
            <Link to={`/replay/${replay.id}`}>this replay</Link>
          </p>
          <div className="card-actions">
            <VoteButtons segment={segment} />
            <ReportButton segmentId={segment.id} />
            <Link
              to={`/train?segment=${segment.id}`}
              className="practice-button"
            >
              ▶ Practice
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
