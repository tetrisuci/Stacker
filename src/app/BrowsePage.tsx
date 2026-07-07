// /browse: a responsive grid of segment cards over GET /segments, with a
// facet sidebar (mode, tags, style, difficulty, pps/apm ranges), New/Top
// sort, and keyset-cursor infinite scroll (IntersectionObserver sentinel).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listSegments,
  listTags,
  type SegmentWithReplayDto,
  type TagDto,
} from "../api/client";
import {
  EMPTY_FACETS,
  facetsToParams,
  type BrowseFacets,
} from "./browseFacets";
import { SegmentCard } from "./SegmentCard";

const PAGE_SIZE = 24;
const FILTER_DEBOUNCE_MS = 300;

export function BrowsePage() {
  const [facets, setFacets] = useState<BrowseFacets>(EMPTY_FACETS);
  const [vocabulary, setVocabulary] = useState<TagDto[]>([]);
  const [items, setItems] = useState<SegmentWithReplayDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic fetch id: a facet change mid-flight makes the stale page a no-op.
  const fetchSeq = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listTags().then(setVocabulary, () => setVocabulary([]));
  }, []);

  // (Re)load the first page whenever the facets settle for a moment — the
  // debounce keeps range-input keystrokes from firing a request each.
  useEffect(() => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      listSegments({ ...facetsToParams(facets), limit: PAGE_SIZE }).then(
        (page) => {
          if (seq !== fetchSeq.current) return;
          setItems(page.items);
          setCursor(page.nextCursor);
          setLoading(false);
        },
        () => {
          if (seq !== fetchSeq.current) return;
          setError("Could not load segments — is the server running?");
          setLoading(false);
        },
      );
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [facets]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    const seq = ++fetchSeq.current;
    setLoading(true);
    listSegments({
      ...facetsToParams(facets),
      limit: PAGE_SIZE,
      cursor,
    }).then(
      (page) => {
        if (seq !== fetchSeq.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      () => {
        if (seq !== fetchSeq.current) return;
        setError("Could not load more segments.");
        setLoading(false);
      },
    );
  }, [cursor, loading, facets]);

  // Infinite scroll: when the sentinel below the grid becomes visible and a
  // next page exists, fetch it.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const set = <K extends keyof BrowseFacets>(key: K, value: BrowseFacets[K]) =>
    setFacets((prev) => ({ ...prev, [key]: value }));

  const toggleTag = (slug: string) =>
    setFacets((prev) => ({
      ...prev,
      tags: prev.tags.includes(slug)
        ? prev.tags.filter((t) => t !== slug)
        : [...prev.tags, slug],
    }));

  return (
    <section className="page browse">
      <aside className="browse-facets">
        <h2>Browse</h2>

        <label className="facet-field">
          Sort
          <select
            value={facets.sort}
            onChange={(e) => set("sort", e.target.value as "new" | "top")}
          >
            <option value="new">New</option>
            <option value="top">Top</option>
          </select>
        </label>

        <label className="facet-field">
          Mode
          <select
            value={facets.mode}
            onChange={(e) => set("mode", e.target.value)}
          >
            <option value="">any</option>
            <option value="40l">40 lines</option>
            <option value="blitz">Blitz</option>
            <option value="zenith">Quick Play</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <div className="facet-field">
          Tags
          <div className="facet-tags">
            {vocabulary.map((tag) => (
              <button
                key={tag.slug}
                type="button"
                className={`tag-chip${facets.tags.includes(tag.slug) ? " picked" : ""}`}
                onClick={() => toggleTag(tag.slug)}
              >
                {tag.label}
              </button>
            ))}
          </div>
        </div>

        <label className="facet-field">
          Style
          <input
            type="text"
            value={facets.style}
            placeholder="any"
            onChange={(e) => set("style", e.target.value)}
          />
        </label>

        <label className="facet-field">
          Difficulty
          <select
            value={facets.difficulty}
            onChange={(e) => set("difficulty", Number(e.target.value))}
          >
            <option value={0}>any</option>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <div className="facet-field">
          PPS
          <div className="facet-range">
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder="min"
              value={facets.ppsMin}
              onChange={(e) => set("ppsMin", e.target.value)}
            />
            –
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder="max"
              value={facets.ppsMax}
              onChange={(e) => set("ppsMax", e.target.value)}
            />
          </div>
        </div>

        <div className="facet-field">
          APM
          <div className="facet-range">
            <input
              type="number"
              step="1"
              min="0"
              placeholder="min"
              value={facets.apmMin}
              onChange={(e) => set("apmMin", e.target.value)}
            />
            –
            <input
              type="number"
              step="1"
              min="0"
              placeholder="max"
              value={facets.apmMax}
              onChange={(e) => set("apmMax", e.target.value)}
            />
          </div>
        </div>

        <button
          type="button"
          className="facet-reset"
          onClick={() => setFacets(EMPTY_FACETS)}
        >
          Reset filters
        </button>
      </aside>

      <div className="browse-results">
        {error && <p className="browse-error">{error}</p>}
        {!error && !loading && items.length === 0 && (
          <p className="browse-empty">
            No segments match. Publish one from the trainer: load a replay,
            pick a window, and hit Publish.
          </p>
        )}
        <div className="browse-grid">
          {items.map((s) => (
            <SegmentCard key={s.id} segment={s} replay={s.replay} />
          ))}
        </div>
        {loading && <p className="browse-loading">Loading…</p>}
        <div ref={sentinelRef} className="browse-sentinel" />
      </div>
    </section>
  );
}
