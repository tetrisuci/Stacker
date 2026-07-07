// Segment card: thumbnail, title, player, tags, difficulty, mode, rating.
// Used by the browse grid, the replay detail page, and (via VoteButtons) the
// segment detail page. "Practice" deep-links into the trainer, which fetches
// the replay file and auto-starts a session over the segment's window.

import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { authStore } from "../api/authStore";
import {
  segmentThumbnailUrl,
  voteSegment,
  type ReplayDto,
  type SegmentDto,
} from "../api/client";
import { ReportButton } from "./ReportButton";
import { applyVote, nextVote, type VoteState } from "./vote";

export function difficultyLabel(d: number | null): string | null {
  if (d == null) return null;
  return `${"◆".repeat(d)}${"◇".repeat(5 - d)}`;
}

/**
 * Up/down voting with optimistic updates: the click applies locally at once,
 * then reconciles with the server's authoritative counts (and reverts on
 * error). Logged-out users get a login prompt instead of a request.
 */
export function VoteButtons({ segment }: { segment: SegmentDto }) {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  const [state, setState] = useState<VoteState>({
    ups: segment.ups,
    downs: segment.downs,
    myVote: segment.myVote,
  });
  const [needLogin, setNeedLogin] = useState(false);

  const cast = (clicked: 1 | -1) => {
    if (!auth.user) {
      setNeedLogin(true);
      return;
    }
    const prev = state;
    const next = nextVote(prev.myVote, clicked);
    setState(applyVote(prev, next)); // optimistic
    voteSegment(segment.id, next).then(
      (updated) =>
        setState({
          ups: updated.ups,
          downs: updated.downs,
          myVote: updated.myVote,
        }),
      () => setState(prev), // revert on failure
    );
  };

  return (
    <span className="votes">
      <button
        type="button"
        className={`vote-btn up${state.myVote === 1 ? " cast" : ""}`}
        aria-label="Upvote"
        onClick={() => cast(1)}
      >
        ▲ {state.ups}
      </button>
      <button
        type="button"
        className={`vote-btn down${state.myVote === -1 ? " cast" : ""}`}
        aria-label="Downvote"
        onClick={() => cast(-1)}
      >
        ▼ {state.downs}
      </button>
      {needLogin && (
        <span className="vote-login">
          <Link to="/login">Log in</Link> to vote
        </span>
      )}
    </span>
  );
}

export function SegmentCard({
  segment,
  replay,
}: {
  segment: SegmentDto;
  replay: ReplayDto;
}) {
  const pieces = segment.endPiece - segment.startPiece + 1;
  return (
    <article className="segment-card">
      <Link to={`/segment/${segment.id}`} className="card-thumb">
        {segment.thumbnailKey ? (
          <img src={segmentThumbnailUrl(segment.id)} alt="" loading="lazy" />
        ) : (
          <span className="card-thumb-empty">no preview</span>
        )}
      </Link>
      <div className="card-body">
        <Link to={`/segment/${segment.id}`} className="card-title">
          {segment.title}
        </Link>
        <p className="card-meta">
          <Link to={`/player/${replay.playerUsername}`} className="card-player">
            {replay.playerUsername}
          </Link>
          <span className="card-mode">{replay.gamemode}</span>
          {segment.difficulty != null && (
            <span
              className="card-difficulty"
              title={`difficulty ${segment.difficulty}/5`}
            >
              {difficultyLabel(segment.difficulty)}
            </span>
          )}
          <span className="card-window">{pieces} pieces</span>
        </p>
        {segment.tagSlugs.length > 0 && (
          <p className="card-tags">
            {segment.tagSlugs.map((slug) => (
              <span key={slug} className="tag-chip static">
                {slug}
              </span>
            ))}
          </p>
        )}
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
    </article>
  );
}
