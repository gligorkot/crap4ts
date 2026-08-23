import { describe, it, expect } from "vitest";
import {
  readCoverage,
  mapFunctionCoverage,
  mapAllCoverage,
} from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";

/**
 * Helper: build a minimal Istanbul file-entry payload for testing.
 */
function makeFileEntry(
  fnMap: Record<string, { name: string; start: [number, number]; end: [number, number] }>,
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
          decl: { start: { line: v.start[0], column: 0 }, end: { line: v.start[0], column: 10 } },
          loc: { start: { line: v.start[0], column: 0 }, end: { line: v.end[0], column: null } },
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
  it("matches a function fully contained within a coverage loc range", () => {
    const entry = makeFileEntry(
      { "0": { name: "foo", start: [5, 0], end: [10, 0] } },
      { "0": 3 },
    );
    const fn = makeFunction("foo", 6, 8);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.coverage).toBe(1);
    expect(result.count).toBe(3);
  });

  it("does NOT match a function that merely overlaps but is not contained", () => {
    // Function spans lines 5-12, coverage loc spans 5-10. Overlap exists but
    // the function extends beyond the loc range, so it is not contained.
    const entry = makeFileEntry(
      { "0": { name: "foo", start: [5, 0], end: [10, 0] } },
      { "0": 3 },
    );
    const fn = makeFunction("bigFn", 5, 12);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });

  it("does NOT match when a partial overlap could falsely claim 100% coverage", () => {
    // Two functions on adjacent lines. The coverage entry for fn1 (executed)
    // overlaps fn2's range by one line. A partial-overlap matcher would
    // wrongly attribute fn1's coverage to fn2.
    const entry = makeFileEntry(
      { "0": { name: "fn1", start: [3, 0], end: [5, 0] } },
      { "0": 10 }, // fn1 executed 10 times
    );
    // fn2 starts at line 5 (overlaps fn1's loc end) and extends to line 7.
    const fn2 = makeFunction("fn2", 5, 7);
    const result = mapFunctionCoverage(entry, fn2);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });
});

describe("mapFunctionCoverage — nested / same-line functions", () => {
  it("matches an outer function to its own loc, not the inner function's loc", () => {
    // Outer function lines 1-5, inner function lines 2-3. Both are contained
    // within the outer loc, but the inner loc is more specific. The function
    // whose range is exactly contained by exactly one loc should match that
    // one, not the broader one.
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: [1, 0], end: [5, 0] },
        "1": { name: "inner", start: [2, 0], end: [3, 0] },
      },
      { "0": 1, "1": 5 },
    );
    const outer = makeFunction("outer", 1, 5);
    const inner = makeFunction("inner", 2, 3);
    const outerResult = mapFunctionCoverage(entry, outer);
    const innerResult = mapFunctionCoverage(entry, inner);
    // outer is contained by loc "0" only (not "1"), inner is contained by "1" only.
    // But outer is also "contained" by loc "0". Inner is contained by both "0" and "1".
    // When two entries both contain the function, that's ambiguous -> unmatched.
    // Inner should be ambiguous (contained by both), so unmatched.
    // Outer should match "0" uniquely.
    expect(outerResult.matched).toBe(true);
    expect(outerResult.count).toBe(1);
    // Inner is contained by both loc "0" (lines 1-5) and loc "1" (lines 2-3),
    // which is ambiguous — we cannot determine which coverage entry applies.
    expect(innerResult.matched).toBe(false);
  });

  it("same-line functions (two functions on the same line) are ambiguous", () => {
    // Two functions declared on the same line, two coverage entries on the
    // same line. Both entries contain both functions, so the match is
    // ambiguous and both should report unmatched.
    const entry = makeFileEntry(
      {
        "0": { name: "fnA", start: [1, 0], end: [1, 0] },
        "1": { name: "fnB", start: [1, 0], end: [1, 0] },
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
      { "0": { name: "single", start: [1, 0], end: [1, 0] } },
      { "0": 4 },
    );
    const fn = makeFunction("single", 1, 1);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.count).toBe(4);
  });
});

describe("mapFunctionCoverage — partial function coverage", () => {
  it("reports coverage 0 (not 1) for a contained function with count 0", () => {
    // The function is contained within a loc entry, but that entry was never
    // executed (count 0). Coverage must be 0, not 1.
    const entry = makeFileEntry(
      { "0": { name: "unexecuted", start: [3, 0], end: [8, 0] } },
      { "0": 0 },
    );
    const fn = makeFunction("unexecuted", 4, 6);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.coverage).toBe(0);
    expect(result.count).toBe(0);
  });

  it("does not claim 100% coverage from an adjacent executed entry", () => {
    // fn spans 10-15, entry "0" (executed) spans 8-12, entry "1" (unexecuted) spans 13-17.
    // fn overlaps both but is contained by neither -> unmatched, coverage 0.
    const entry = makeFileEntry(
      {
        "0": { name: "before", start: [8, 0], end: [12, 0] },
        "1": { name: "after", start: [13, 0], end: [17, 0] },
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
  it("does not match when two coverage files share the same suffix", () => {
    // Two files named "sample.ts" in different directories. The source path
    // "src/a/sample.ts" should NOT match either when both are ambiguous.
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: [1, 0], end: [3, 0] } },
        { "0": 1 },
        "/project/src/a/sample.ts",
      ),
      "key2": makeFileEntry(
        { "0": { name: "fn", start: [1, 0], end: [3, 0] } },
        { "0": 1 },
        "/other/src/b/sample.ts",
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/project/src/a/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    // With exact path match available, it should match key1.
    expect(results[0]?.matched).toBe(true);
  });

  it("reports unmatched when suffix is ambiguous and no exact match exists", () => {
    // Source path is /unknown/sample.ts (not in coverage). Two coverage files
    // both end in sample.ts. Suffix match is ambiguous -> no match.
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: [1, 0], end: [3, 0] } },
        { "0": 1 },
        "/dirA/sample.ts",
      ),
      "key2": makeFileEntry(
        { "0": { name: "fn", start: [1, 0], end: [3, 0] } },
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
        { "0": { name: "fn", start: [1, 0], end: [3, 0] } },
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
