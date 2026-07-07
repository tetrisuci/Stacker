import { describe, expect, it } from "vitest";
import { EMPTY_FACETS, facetsToParams } from "./browseFacets";

describe("facetsToParams", () => {
  it("maps empty facets to absent filters (default sort=new)", () => {
    expect(facetsToParams(EMPTY_FACETS)).toEqual({
      mode: undefined,
      tags: undefined,
      style: undefined,
      difficulty: undefined,
      ppsMin: undefined,
      ppsMax: undefined,
      apmMin: undefined,
      apmMax: undefined,
      sort: "new",
    });
  });

  it("passes set facets through", () => {
    expect(
      facetsToParams({
        ...EMPTY_FACETS,
        mode: "40l",
        tags: ["tki", "burst"],
        style: " aggressive ",
        difficulty: 4,
        ppsMin: "1.5",
        apmMax: "120",
        sort: "top",
      }),
    ).toEqual({
      mode: "40l",
      tags: ["tki", "burst"],
      style: "aggressive",
      difficulty: 4,
      ppsMin: 1.5,
      ppsMax: undefined,
      apmMin: undefined,
      apmMax: 120,
      sort: "top",
    });
  });

  it("ignores non-numeric range text and out-of-range difficulty", () => {
    const p = facetsToParams({
      ...EMPTY_FACETS,
      ppsMin: "fast",
      apmMin: " ",
      difficulty: 9,
    });
    expect(p.ppsMin).toBeUndefined();
    expect(p.apmMin).toBeUndefined();
    expect(p.difficulty).toBeUndefined();
  });
});
