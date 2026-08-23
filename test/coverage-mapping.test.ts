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
  statementMap?: Record<string, { start: number; end: number }>,
  s?: Record<string, number>,
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
    statementMap: statementMap
      ? Object.fromEntries(
          Object.entries(statementMap).map(([k, v]) => [
            k,
            {
              start: { line: v.start, column: 0 },
              end: { line: v.end, column: null },
            },
          ]),
        )
      : {},
    s: s ?? {},
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
  startColumn = 0,
  endColumn = 100,
): FunctionInfo {
  return {
    name,
    displayName: name,
    startLine,
    endLine,
    startColumn,
    endColumn,
    startOffset: 0,
    endOffset: 100,
    complexity: 1,
    filePath,
  };
}

describe("mapFunctionCoverage — containment-only matching with line+column", () => {
  it("matches a function whose range contains a coverage loc", () => {
    // Function at 5-10 (declaration header at line 5), loc at 6-8 (body).
    // The loc is contained within the function's range.
    const entry = makeFileEntry(
      { "0": { name: "foo", start: 6, end: 8 } },
      { "0": 3 },
      "/abs/path/sample.ts",
      { "0": { start: 6, end: 8 } },
      { "0": 3 },
    );
    const fn = makeFunction("foo", 5, 10);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(1);
    expect(result.coveredStatements).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("does NOT match a function whose range does not contain the loc", () => {
    // Function at 5-8, loc at 5-10. The loc extends beyond the function,
    // so it is not contained within the function's range.
    const entry = makeFileEntry(
      { "0": { name: "foo", start: 5, end: 10 } },
      { "0": 3 },
      "/abs/path/sample.ts",
      { "0": { start: 5, end: 10 } },
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
      "/abs/path/sample.ts",
      { "0": { start: 3, end: 5 } },
      { "0": 10 },
    );
    const fn2 = makeFunction("fn2", 5, 7);
    const result = mapFunctionCoverage(entry, fn2);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });
});

describe("mapFunctionCoverage — nested / same-line functions", () => {
  it("matches an outer function to a containing loc with statements", () => {
    // Outer function at 1-5, inner loc at 2-3, outer loc at 1-5.
    // Both locs are contained within the outer function's range. The
    // smallest containing loc (inner, 2-3) is the most specific match.
    // Statements within the outer's range are counted for coverage fraction.
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 5 },
        "1": { name: "inner", start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 5 },
        "1": { start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
    );
    const outer = makeFunction("outer", 1, 5);
    const result = mapFunctionCoverage(entry, outer);
    expect(result.matched).toBe(true);
    // Both statements are contained in the outer's range.
    expect(result.totalStatements).toBe(2);
  });

  it("matches an inner function to its own loc, not the outer loc", () => {
    // Inner function at 2-3, inner loc at 2-3, outer loc at 1-5.
    // Both locs contain the inner function's range. The smallest containing
    // loc (inner, 2-3) is the most specific match for the inner function.
    // The outer loc (1-5) is NOT contained in the inner (2-3).
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 5 },
        "1": { name: "inner", start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 5 },
        "1": { start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
    );
    const inner = makeFunction("inner", 2, 3);
    const result = mapFunctionCoverage(entry, inner);
    expect(result.matched).toBe(true);
    // Only statement "1" (2-3) is contained in inner's range.
    expect(result.totalStatements).toBe(1);
    expect(result.coveredStatements).toBe(5 > 0 ? 1 : 0);
  });

  it("nested callback location overlaps parent — inner matches its own loc", () => {
    // Parent fn at 1-10. Inside, a callback fn at 5-7 with its own loc 5-7.
    // The callback's loc (5-7) is contained in both the parent (1-10) and
    // itself (5-7). The most specific loc for the callback is its own (5-7).
    // The parent gets its own statements (not the callback's).
    const entry = makeFileEntry(
      {
        "0": { name: "parent", start: 1, end: 10 },
        "1": { name: "callback", start: 5, end: 7 },
      },
      { "0": 3, "1": 2 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 4 },
        "1": { start: 5, end: 7 },
        "2": { start: 8, end: 10 },
      },
      { "0": 3, "1": 2, "2": 3 },
    );
    const parent = makeFunction("parent", 1, 10);
    const callback = makeFunction("callback", 5, 7);
    const parentResult = mapFunctionCoverage(entry, parent);
    const callbackResult = mapFunctionCoverage(entry, callback);
    // Parent contains all 3 statements.
    expect(parentResult.matched).toBe(true);
    expect(parentResult.totalStatements).toBe(3);
    // Callback contains only its own statement.
    expect(callbackResult.matched).toBe(true);
    expect(callbackResult.totalStatements).toBe(1);
  });

  it("same-line functions with same-line locs are ambiguous for identity", () => {
    // Two functions on the same line, two locs on the same line. Both locs
    // are contained within both functions. Both get identity matched but
    // statement coverage depends on statements in range.
    const entry = makeFileEntry(
      {
        "0": { name: "fnA", start: 1, end: 1 },
        "1": { name: "fnB", start: 1, end: 1 },
      },
      { "0": 1, "1": 0 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 1 },
        "1": { start: 1, end: 1 },
      },
      { "0": 1, "1": 0 },
    );
    const fnA = makeFunction("fnA", 1, 1);
    const resultA = mapFunctionCoverage(entry, fnA);
    // Both functions on the same line will get the same statements.
    // Identity matched=true (both locs contained). Statements: both covered
    // since s["0"]=1 and s["1"]=0 — 1 of 2 covered.
    expect(resultA.matched).toBe(true);
    expect(resultA.totalStatements).toBe(2);
    expect(resultA.coveredStatements).toBe(1);
    expect(resultA.coverage).toBeCloseTo(0.5, 10);
  });

  it("exact same-line single function matches uniquely", () => {
    const entry = makeFileEntry(
      { "0": { name: "single", start: 1, end: 1 } },
      { "0": 4 },
      "/abs/path/sample.ts",
      { "0": { start: 1, end: 1 } },
      { "0": 4 },
    );
    const fn = makeFunction("single", 1, 1);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(1);
    expect(result.coveredStatements).toBe(1);
    expect(result.coverage).toBe(1);
  });
});

describe("mapFunctionCoverage — only inner function in coverage", () => {
  it("outer function without its own loc still gets statements in its range", () => {
    // Only an inner fnMap entry exists (the callback). The outer function
    // has no matching fnMap loc. But statements in the outer's range are
    // still counted — matched=true if statements found, false otherwise.
    const entry = makeFileEntry(
      { "0": { name: "callback", start: 3, end: 5 } },
      { "0": 2 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 2 },
        "1": { start: 3, end: 5 },
        "2": { start: 6, end: 7 },
      },
      { "0": 1, "1": 2, "2": 1 },
    );
    const outer = makeFunction("outer", 1, 7);
    const result = mapFunctionCoverage(entry, outer);
    // No fnMap loc is contained in the outer (only callback's 3-5 is, and
    // 3 >= 1 and 5 <= 7, so it IS contained). Identity matched=true.
    // All 3 statements are in the outer's range.
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(3);
    expect(result.coveredStatements).toBe(3);
    expect(result.coverage).toBe(1);
  });
});

describe("mapFunctionCoverage — no statement data available", () => {
  it("reports coverage 0 with matched=true when fnMap identity found but no statements", () => {
    // File entry with fnMap but no statementMap/s data.
    const entry = {
      path: "/abs/path/sample.ts",
      fnMap: {
        "0": {
          name: "fn",
          decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
          loc: { start: { line: 1, column: 10 }, end: { line: 3, column: null } },
        },
      },
      f: { "0": 5 },
      b: {},
      branchMap: {},
      meta: {},
    };
    const fn = makeFunction("fn", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.coverage).toBe(0);
    expect(result.totalStatements).toBe(0);
    expect(result.coveredStatements).toBe(0);
  });
});

describe("mapAllCoverage — path matching regressions", () => {
  it("matches by exact path when available", () => {
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/project/src/a/sample.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
      "key2": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/other/src/b/sample.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
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
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
      "key2": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/dirB/sample.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/unknown/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
    expect(results[0]?.coverage).toBe(0);
  });

  it("rejects basename-only suffix match (requires anchored project-relative)", () => {
    // Source path is /different/path/sample.ts. Coverage has /some/dir/sample.ts.
    // The common suffix is just "sample.ts" (1 segment), which is basename-only.
    // The source has 3 segments; bestScore (1) < targetSegs.length (3).
    // This must NOT match — basename-only matching is rejected.
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/some/dir/sample.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/different/path/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
  });

  it("matches when full relative path suffix is unambiguous", () => {
    // Source path /different/src/foo.ts, coverage /some/src/foo.ts.
    // Common suffix: "src/foo.ts" (2 segments). Source has 3 segments.
    // bestScore (2) < targetSegs.length (3) -> does NOT match.
    // This is correct: "src/foo.ts" is a partial suffix, not anchored.
    // For a true anchored match, the source path must be a suffix of the
    // coverage path (or vice versa). Let's test a real anchored match:
    // Source: /repo/src/foo.ts, coverage path: /home/user/repo/src/foo.ts
    // Common suffix: "repo/src/foo.ts" (3 segments = targetSegs.length). Match!
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/home/user/repo/src/foo.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/repo/src/foo.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(true);
    expect(results[0]?.coverage).toBe(1);
  });

  it("unrelated paths sharing a basename do not match", () => {
    // Two completely different projects both have a file named "config.ts"
    // but in different directory structures. Source: /projA/src/config.ts
    // Coverage: /projB/lib/config.ts. Suffix "config.ts" only — rejected.
    const coverage = {
      "key1": makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/projB/lib/config.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
    };
    const fn = makeFunction("fn", 1, 3, "/projA/src/config.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
  });
});
