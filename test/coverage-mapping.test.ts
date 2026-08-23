import { describe, it, expect } from "vitest";
import {
  readCoverage,
  mapFunctionCoverage,
  mapAllCoverage,
} from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";

/**
 * Helper: build a minimal Istanbul file-entry payload for testing.
 *
 * loc ranges use [startLine, endLine]. The loc represents the executable
 * span as reported by Istanbul/V8; the analyzed function range includes the
 * declaration header, so the loc is typically a sub-range of the function.
 */
function makeFileEntry(
  fnMap: Record<string, { name: string; start: number; end: number }>,
  f: Record<string, number>,
  filePath = "/abs/path/sample.ts",
) {
  return {
    path: filePath,
    fnMap: Object.fromEntries(
      Object.entries(fnMap).map(([k, v]) => [
        k,
        {
          name: v.name,
          decl: { start: { line: v.start, column: 0 }, end: { line: v.start, column: 10 } },
          loc: { start: { line: v.start, column: 0 }, end: { line: v.end, column: null } },
        },
      ]),
    ),
    f,
    statementMap: {},
    s: {},
    b: {},
    branchMap: {},
    meta: {},
  };
}

function makeFunction(
  name: string,
  startLine: number,
  endLine: number,
  filePath = "/abs/path/sample.ts",
): FunctionInfo {
  return {
    name,
    displayName: name,
    startLine,
    endLine,
    startOffset: 0,
    endOffset: 100,
    complexity: 1,
    filePath,
  };
}

describe("mapFunctionCoverage — containment-only matching", () => {
  it("matches a function whose range contains a coverage loc", () => {
    // Function at 5-10 (declaration header at line 5), loc at 6-8 (body).
    // The loc is contained within the function's range.
    const entry = makeFileEntry(
      { "0": { name: "foo", start: 6, end: 8 } },
      { "0": 3 },
    );
    const fn = makeFunction("foo", 5, 10);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.coverage).toBe(1);
    expect(result.count).toBe(3);
  });

  it("does NOT match a function whose range does not contain the loc", () => {
    // Function at 5-8, loc at 5-10. The loc extends beyond the function,
    // so it is not contained within the function's range.
    const entry = makeFileEntry(
      { "0": { name: "foo", start: 5, end: 10 } },
      { "0": 3 },
    );
    const fn = makeFunction("bigFn", 5, 8);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });

  it("does NOT match when a partial overlap could falsely claim coverage", () => {
    // Function at 5-7, loc at 3-5. The loc's end (5) overlaps the function's
    // start (5) but the loc is not fully contained in the function.
    // A partial-overlap matcher would wrongly attribute the loc's coverage.
    const entry = makeFileEntry(
      { "0": { name: "fn1", start: 3, end: 5 } },
      { "0": 10 },
    );
    const fn2 = makeFunction("fn2", 5, 7);
    const result = mapFunctionCoverage(entry, fn2);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });
});

describe("mapFunctionCoverage — nested / same-line functions", () => {
  it("matches an outer function to the largest loc contained within it", () => {
    // Outer function at 1-5, inner loc at 2-3, outer loc at 1-5.
    // Both locs are contained within the outer function's range. The largest
    // loc (1-5) is the outer function's own body loc, so it should match.
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 5 },
        "1": { name: "inner", start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
    );
    const outer = makeFunction("outer", 1, 5);
    const result = mapFunctionCoverage(entry, outer);
    expect(result.matched).toBe(true);
    expect(result.count).toBe(1);
  });

  it("matches an inner function to its own loc, not the outer loc", () => {
    // Inner function at 2-3, inner loc at 2-3, outer loc at 1-5.
    // Both locs contain the inner function's range. The largest loc (1-5) is
    // the outer's, not the inner's. The inner should match the loc that is
    // contained within the inner's range: loc "1" (2-3) is contained in the
    // inner (2-3), loc "0" (1-5) is NOT contained in the inner (2-3).
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 5 },
        "1": { name: "inner", start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
    );
    const inner = makeFunction("inner", 2, 3);
    const result = mapFunctionCoverage(entry, inner);
    expect(result.matched).toBe(true);
    expect(result.count).toBe(5);
  });

  it("same-line functions with same-line locs are ambiguous", () => {
    // Two functions on the same line, two locs on the same line. Both locs
    // are contained within both functions, and both locs have the same size.
    // The match is ambiguous.
    const entry = makeFileEntry(
      {
        "0": { name: "fnA", start: 1, end: 1 },
        "1": { name: "fnB", start: 1, end: 1 },
      },
      { "0": 1, "1": 0 },
    );
    const fnA = makeFunction("fnA", 1, 1);
    const fnB = makeFunction("fnB", 1, 1);
    const resultA = mapFunctionCoverage(entry, fnA);
    const resultB = mapFunctionCoverage(entry, fnB);
    expect(resultA.matched).toBe(false);
    expect(resultB.matched).toBe(false);
  });

  it("exact same-line single function matches uniquely", () => {
    const entry = makeFileEntry(
      { "0": { name: "single", start: 1, end: 1 } },
      { "0": 4 },
    );
    const fn = makeFunction("single", 1, 1);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.count).toBe(4);
  });
});

describe("mapFunctionCoverage — partial function coverage", () => {
  it("reports coverage 0 (not 1) for a matched function with count 0", () => {
    // The loc is contained within the function, but the entry was never
    // executed (count 0). Coverage must be 0, not 1.
    const entry = makeFileEntry(
      { "0": { name: "unexecuted", start: 3, end: 8 } },
      { "0": 0 },
    );
    const fn = makeFunction("unexecuted", 2, 9);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.coverage).toBe(0);
    expect(result.count).toBe(0);
  });

  it("does not claim coverage from an adjacent executed loc", () => {
    // fn at 10-15, loc "0" (executed) at 8-12, loc "1" (unexecuted) at 13-17.
    // Neither loc is fully contained in the fn's range (10-15):
    //   loc "0" (8-12): 8 < 10, not contained
    //   loc "1" (13-17): 17 > 15, not contained
    // -> unmatched, coverage 0.
    const entry = makeFileEntry(
      {
        "0": { name: "before", start: 8, end: 12 },
        "1": { name: "after", start: 13, end: 17 },
      },
      { "0": 5, "1": 0 },
    );
    const fn = makeFunction("spanning", 10, 15);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });
});

describe("mapAllCoverage — ambiguous repeated suffix paths", () => {
  it("matches by exact path when available", () => {
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/project/src/a/sample.ts",
      ),
      "key2": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/other/src/b/sample.ts",
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/project/src/a/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(true);
  });

  it("reports unmatched when suffix is ambiguous and no exact match exists", () => {
    // Source path is /unknown/sample.ts (not in coverage). Two coverage files
    // both end in sample.ts. Suffix match is ambiguous -> no match.
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/dirA/sample.ts",
      ),
      "key2": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/dirB/sample.ts",
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/unknown/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
    expect(results[0]?.coverage).toBe(0);
  });

  it("matches when suffix is unambiguous even without exact match", () => {
    // Only one coverage file ends in "unique.ts".
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/some/dir/unique.ts",
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/different/path/unique.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(true);
    expect(results[0]?.coverage).toBe(1);
  });
});
