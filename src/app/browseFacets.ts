// The browse page's facet state and its mapping onto GET /segments filters —
// pure, so the sidebar-to-query translation is unit-testable.

import type { SegmentFilters, SegmentSort } from "../api/client";

export interface BrowseFacets {
  mode: string; // "" = any
  tags: string[]; // AND-combined slugs
  style: string;
  difficulty: number; // 0 = any, else 1-5
  ppsMin: string; // free text from number inputs; "" = unset
  ppsMax: string;
  apmMin: string;
  apmMax: string;
  sort: SegmentSort;
}

export const EMPTY_FACETS: BrowseFacets = {
  mode: "",
  tags: [],
  style: "",
  difficulty: 0,
  ppsMin: "",
  ppsMax: "",
  apmMin: "",
  apmMax: "",
  sort: "new",
};

function num(raw: string): number | undefined {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/** Facet state → listSegments params; empty facets become absent filters. */
export function facetsToParams(
  f: BrowseFacets,
): SegmentFilters & { sort: SegmentSort } {
  return {
    mode: f.mode || undefined,
    tags: f.tags.length ? f.tags : undefined,
    style: f.style.trim() || undefined,
    difficulty: f.difficulty >= 1 && f.difficulty <= 5 ? f.difficulty : undefined,
    ppsMin: num(f.ppsMin),
    ppsMax: num(f.ppsMax),
    apmMin: num(f.apmMin),
    apmMax: num(f.apmMax),
    sort: f.sort,
  };
}
