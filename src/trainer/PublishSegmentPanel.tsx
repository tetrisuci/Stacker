// "Publish segment" panel: turn the currently-selected training window into a
// community segment. Bound to the ReplayPanel's WindowSelection {start,end};
// on publish it renders the window's final board snapshot to an offscreen
// canvas (via the existing renderer — called, never modified), computes hint
// stats over the window with the pure compare helpers, makes sure the replay
// itself is uploaded (idempotent by hash), and POSTs the segment.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { authStore } from "../api/authStore";
import {
  ApiError,
  createSegment,
  listTags,
  uploadReplay,
  type TagDto,
} from "../api/client";
import {
  canvasSize,
  DEFAULT_LAYOUT,
  render,
} from "../render/render";
import { boardMetrics, toOccupancy } from "../session/compare";
import type { LoadedReplay } from "../replay/ReplayPanel";

/** Render `snapshot` with the standard board renderer and PNG-encode it. */
async function renderThumbnail(
  snapshot: Parameters<typeof render>[1],
): Promise<Blob | null> {
  const { width, height } = canvasSize(DEFAULT_LAYOUT);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  render(ctx, snapshot, DEFAULT_LAYOUT);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** Hint stats over the window [start, end], from the pure compare helpers. */
function computeHints(
  loaded: LoadedReplay,
  window: { start: number; end: number },
): Record<string, unknown> {
  const slice = loaded.result.track.slice(window.start, window.end + 1);
  const finalBoard = toOccupancy(
    loaded.result.track[window.end].snapshot.board,
  );
  const pieceCounts: Record<string, number> = {};
  let clears = 0;
  let spins = 0;
  let holds = 0;
  for (const p of slice) {
    pieceCounts[p.piece] = (pieceCounts[p.piece] ?? 0) + 1;
    clears += p.clears;
    if (p.spin !== "none") spins += 1;
    if (p.wasHold) holds += 1;
  }
  return {
    boardMetrics: boardMetrics(finalBoard),
    pieces: slice.length,
    clears,
    spins,
    holds,
    pieceCounts,
  };
}

export function PublishSegmentPanel({
  loaded,
  window,
}: {
  loaded: LoadedReplay;
  window: { start: number; end: number };
}) {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  const [vocabulary, setVocabulary] = useState<TagDto[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState(3);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [freeTags, setFreeTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);

  useEffect(() => {
    listTags().then(setVocabulary, () => setVocabulary([]));
  }, []);

  const windowLabel = useMemo(
    () => `pieces ${window.start}–${window.end}`,
    [window.start, window.end],
  );

  const togglePick = (slug: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // The segment references a *stored* replay: upload is idempotent by
      // content hash (200 with the existing row when already ingested).
      const replay = await uploadReplay(
        new File([loaded.rawText], loaded.filename, {
          type: "application/json",
        }),
      );
      const thumbnail = await renderThumbnail(
        loaded.result.track[window.end].snapshot,
      );
      const tags = [
        ...picked,
        ...freeTags.split(",").map((t) => t.trim()).filter(Boolean),
      ];
      const segment = await createSegment({
        replayId: replay.id,
        startPiece: window.start,
        endPiece: window.end,
        title,
        description,
        difficulty,
        tags,
        hints: computeHints(loaded, window),
        thumbnail,
      });
      setPublishedId(segment.id);
      setMessage(`Published "${segment.title}" (${windowLabel}).`);
    } catch (e) {
      setPublishedId(null);
      setMessage(
        e instanceof ApiError ? `Publish failed: ${e.message}` : "Publish failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="publish">
      <h3>Publish segment</h3>
      <p className="section-help">
        Share the selected window ({windowLabel} of{" "}
        {loaded.replay.metadata.username}
        {"'s"} run) as a community training segment.
      </p>

      {!auth.user ? (
        <p className="publish-login">Log in with Discord to publish.</p>
      ) : (
        <>
          <label className="publish-field">
            Title
            <input
              type="text"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Clean DT cannon into PC"
            />
          </label>
          <label className="publish-field">
            Description
            <textarea
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="publish-field publish-difficulty">
            Difficulty
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>
                  {d} — {["easy", "casual", "solid", "hard", "brutal"][d - 1]}
                </option>
              ))}
            </select>
          </label>

          <div className="publish-tags">
            {vocabulary.map((tag) => (
              <button
                key={tag.slug}
                type="button"
                className={`tag-chip${picked.has(tag.slug) ? " picked" : ""}`}
                onClick={() => togglePick(tag.slug)}
              >
                {tag.label}
              </button>
            ))}
          </div>
          <label className="publish-field">
            More tags (comma-separated)
            <input
              type="text"
              value={freeTags}
              onChange={(e) => setFreeTags(e.target.value)}
              placeholder="e.g. left-well"
            />
          </label>

          <button
            type="button"
            className="publish-submit"
            disabled={busy || title.trim().length === 0}
            onClick={() => void publish()}
          >
            {busy ? "Publishing…" : "▲ Publish"}
          </button>
        </>
      )}

      {message && (
        <p className={publishedId ? "publish-ok" : "publish-error"}>{message}</p>
      )}
    </section>
  );
}
