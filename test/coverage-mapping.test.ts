import { describe, it, expect } from "vitest";
import {
  mapFunctionCoverage,
  mapFileCoverage,
  mapAllCoverage,
} from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";

/**
 * Helper: build a minimal Istanbul file-entry payload for testing.
 *
 * `fnMap` entries are specified by `{ name, start, end, startCol?, endCol? }`
 * where start/end are line numbers and startCol/endCol default to 0/null.
 * The loc is built from those values; decl mirrors the loc start.
 */
function makeFileEntry(
  fnMap: Record<
    string,
    {
      name: string;
      start: number;
      end: number;
      startCol?: number;
      endCol?: number;
    }
  >,
  f: Record<string, number>,
  filePath = "/abs/path/sample.ts",
  statementMap?: Record<
    string,
    { start: number; end: number; startCol?: number; endCol?: number }
  >,
  s?: Record<string, number>,
) {
  return {
    path: filePath,
    fnMap: Object.fromEntries(
      Object.entries(fnMap).map(([k, v]) => [
        k,
        {
          name: v.name,
          decl: {
            start: { line: v.start, column: v.startCol ?? 0 },
            end: { line: v.start, column: (v.startCol ?? 0) + 10 },
          },
          loc: {
            start: { line: v.start, column: v.startCol ?? 0 },
            end: { line: v.end, column: v.endCol ?? null },
          },
        },
      ]),
    ),
    f,
    statementMap: statementMap
      ? Object.fromEntries(
          Object.entries(statementMap).map(([k, v]) => [
            k,
            {
              start: { line: v.start, column: v.startCol ?? 0 },
              end: { line: v.end, column: v.endCol ?? null },
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

// ---------------------------------------------------------------------------
// Containment-only matching with line+column
// ---------------------------------------------------------------------------

describe("mapFunctionCoverage — containment-only matching with line+column", () => {
  it("matches a function whose range contains a coverage loc", () => {
    // Function at 5-10, loc at 6-8 (body). The loc is contained.
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
    // Function at 5-8, loc at 5-10. The loc extends beyond the function.
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
    expect(result.totalStatements).toBe(0);
  });

  it("does NOT match when a partial overlap could falsely claim coverage", () => {
    // Function at 5-7, loc at 3-5. The loc's end (5) overlaps the function's
    // start (5) but the loc is not fully contained in the function.
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
    expect(result.totalStatements).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Nested / same-line functions — safe ownership (no double attribution)
// ---------------------------------------------------------------------------

describe("mapFunctionCoverage — nested / same-line functions", () => {
  it("outer matches its own loc; inner statement NOT attributed to outer", () => {
    // Outer function at 1-5, inner callback at 2-3. Two fnMap entries.
    // Statements: "0" (1-2) in outer-only region, "1" (2-3) inside inner.
    // Outer's own fnMap entry (1-5) is assigned to outer (most specific
    // container of the 1-5 loc is outer, since inner 2-3 does not contain 1-5).
    // Inner's fnMap entry (2-3) is assigned to inner.
    // Statement "0" (1-2): most-specific matched container is outer (inner
    // 2-3 does not contain 1-2). Statement "1" (2-3): most-specific matched
    // container is inner (inner 2-3 contains 2-3, outer 1-5 also contains it
    // but inner is more specific).
    // Result: outer owns 1 statement, inner owns 1 statement. No double count.
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 5 },
        "1": { name: "inner", start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 2 },
        "1": { start: 2, end: 3 },
      },
      { "0": 1, "1": 5 },
    );
    const outer = makeFunction("outer", 1, 5);
    const inner = makeFunction("inner", 2, 3);
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    expect(outerResult.matched).toBe(true);
    expect(outerResult.totalStatements).toBe(1);
    expect(outerResult.coveredStatements).toBe(1);
    expect(outerResult.coverage).toBe(1);

    expect(innerResult.matched).toBe(true);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coveredStatements).toBe(1);
    expect(innerResult.coverage).toBe(1);
  });

  it("nested callback statements belong to inner, not outer (no double attribution)", () => {
    // Parent fn at 1-10. Callback fn at 5-7. Statements:
    //   "0" (1-4): outer-only region
    //   "1" (5-7): inside callback
    //   "2" (8-10): outer-only region
    // Both fnMap entries present. Outer's loc (1-10) → outer. Callback's
    // loc (5-7) → callback (more specific). Statements "0" and "2" → outer.
    // Statement "1" → callback (most specific matched container).
    // Outer: 2 statements. Callback: 1 statement. No statement double-counted.
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
    const results = mapFileCoverage(entry, [parent, callback]);
    const parentResult = results[0]!;
    const callbackResult = results[1]!;

    expect(parentResult.matched).toBe(true);
    expect(parentResult.totalStatements).toBe(2);
    expect(parentResult.coveredStatements).toBe(2);
    expect(parentResult.coverage).toBe(1);

    expect(callbackResult.matched).toBe(true);
    expect(callbackResult.totalStatements).toBe(1);
    expect(callbackResult.coveredStatements).toBe(1);
    expect(callbackResult.coverage).toBe(1);
  });

  it("same-line functions with same-line locs are ambiguous: tied identity rejected", () => {
    // Two functions on the same line with the same column range, two locs on
    // the same line with the same column range. Both locs are contained in
    // both functions with equal specificity → tie → assigned to none.
    // No function gets a matched identity. Statements cannot be attributed
    // to any matched function → all excluded.
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
    const fnB = makeFunction("fnB", 1, 1);
    const results = mapFileCoverage(entry, [fnA, fnB]);
    const resultA = results[0]!;
    const resultB = results[1]!;

    // Tied identity: both functions unmatched.
    expect(resultA.matched).toBe(false);
    expect(resultA.coverage).toBe(0);
    expect(resultA.totalStatements).toBe(0);
    expect(resultA.coveredStatements).toBe(0);

    expect(resultB.matched).toBe(false);
    expect(resultB.coverage).toBe(0);
    expect(resultB.totalStatements).toBe(0);
    expect(resultB.coveredStatements).toBe(0);
  });

  it("same-line first/second: one surviving fnMap entry maps only its exact column-matching function", () => {
    // Two functions on line 1 at different columns: fnA at col 0-50, fnB at
    // col 20-40. fnB is nested inside fnA (more specific).
    // One fnMap entry at line 1, col 20-40. Its loc is contained in both fnA
    // (0-50) and fnB (20-40). fnB is more specific (smaller range) → assigned
    // to fnB. fnA has no assigned entry → unmatched, coverage 0.
    // Statement at line 1, col 20-40 → owned by fnB (only matched container).
    const entry = makeFileEntry(
      {
        "0": { name: "inner", start: 1, end: 1, startCol: 20, endCol: 40 },
      },
      { "0": 4 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 1, startCol: 20, endCol: 40 },
      },
      { "0": 4 },
    );
    const fnA = makeFunction("outer", 1, 1, "/abs/path/sample.ts", 0, 50);
    const fnB = makeFunction("inner", 1, 1, "/abs/path/sample.ts", 20, 40);
    const results = mapFileCoverage(entry, [fnA, fnB]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    // Outer has no assigned fnMap entry → unmatched, 0 statements.
    expect(outerResult.matched).toBe(false);
    expect(outerResult.coverage).toBe(0);
    expect(outerResult.totalStatements).toBe(0);

    // Inner is matched, owns the statement.
    expect(innerResult.matched).toBe(true);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coveredStatements).toBe(1);
    expect(innerResult.coverage).toBe(1);
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

// ---------------------------------------------------------------------------
// Absent outer fnMap entry — outer unmatched even if inner is present
// ---------------------------------------------------------------------------

describe("mapFunctionCoverage — absent outer entry", () => {
  it("outer without its own fnMap entry is unmatched, coverage 0, zero statements (nested probe)", () => {
    // Only an inner fnMap entry exists (the callback at 3-5). The outer
    // function (1-7) has NO fnMap entry assigned to it: the inner entry's
    // loc (3-5) is contained in the outer (1-7) AND in the inner (3-5);
    // the inner is more specific, so the entry is assigned to the inner only.
    // Outer stays unmatched. A statement alone must NOT mark the outer
    // matched. Statements in the outer's range that belong to the inner
    // callback cannot contribute to the outer's numerator/denominator.
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
    const inner = makeFunction("callback", 3, 5);
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    // Outer: no fnMap entry assigned → matched=false. Its statements (which
    // would include lines 1-2 and 6-7) are NOT counted because the outer has
    // no matched identity. Coverage 0, zero statements.
    expect(outerResult.matched).toBe(false);
    expect(outerResult.coverage).toBe(0);
    expect(outerResult.totalStatements).toBe(0);
    expect(outerResult.coveredStatements).toBe(0);

    // Inner: matched, owns its own statement (3-5).
    expect(innerResult.matched).toBe(true);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coveredStatements).toBe(1);
    expect(innerResult.coverage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No statement data available
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Path matching regressions
// ---------------------------------------------------------------------------

describe("mapAllCoverage — path matching regressions", () => {
  it("matches by exact path when available", () => {
    const coverage = {
      key1: makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/project/src/a/sample.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
      key2: makeFileEntry(
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
    const coverage = {
      key1: makeFileEntry(
        { "0": { name: "fn", start: 1, end: 3 } },
        { "0": 1 },
        "/dirA/sample.ts",
        { "0": { start: 1, end: 3 } },
        { "0": 1 },
      ),
      key2: makeFileEntry(
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
    const coverage = {
      key1: makeFileEntry(
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
    // Source: /repo/src/foo.ts, coverage path: /home/user/repo/src/foo.ts.
    // Common suffix: "repo/src/foo.ts" (3 segments = targetSegs.length). Match.
    const coverage = {
      key1: makeFileEntry(
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
    const coverage = {
      key1: makeFileEntry(
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

// ---------------------------------------------------------------------------
// Tied identity rejection and unrelated-path statement exclusion
// ---------------------------------------------------------------------------

describe("mapFileCoverage — tied identity rejection", () => {
  it("two equally-specific candidate functions for one fnMap entry → assigned to none", () => {
    // fnA at 1-5 (col 0-100), fnB at 1-5 (col 0-100) — identical ranges.
    // One fnMap entry loc at 2-3, contained in both with equal size.
    // Tie → assigned to neither. Both functions unmatched.
    const entry = makeFileEntry(
      { "0": { name: "fn", start: 2, end: 3 } },
      { "0": 1 },
      "/abs/path/sample.ts",
      { "0": { start: 2, end: 3 } },
      { "0": 1 },
    );
    const fnA = makeFunction("fnA", 1, 5);
    const fnB = makeFunction("fnB", 1, 5);
    const results = mapFileCoverage(entry, [fnA, fnB]);
    expect(results[0]!.matched).toBe(false);
    expect(results[0]!.totalStatements).toBe(0);
    expect(results[1]!.matched).toBe(false);
    expect(results[1]!.totalStatements).toBe(0);
  });

  it("statement with two equally-specific matched containers is excluded conservatively", () => {
    // Two matched functions with identical ranges (1-5) — both get their own
    // fnMap entries (each entry's loc is contained only in its exact-sized
    // function... but both functions are the same size, so each entry is
    // contained in both → tie → assigned to none).
    // To test statement tie independently: give each function a distinct
    // fnMap entry that only it contains. Then a statement whose range is
    // contained equally in both (identical size) is excluded.
    const entry = makeFileEntry(
      {
        "0": { name: "fnA", start: 1, end: 3 },
        "1": { name: "fnB", start: 1, end: 3 },
      },
      { "0": 1, "1": 1 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 3 },
      },
      { "0": 1 },
    );
    const fnA = makeFunction("fnA", 1, 5);
    const fnB = makeFunction("fnB", 1, 5);
    const results = mapFileCoverage(entry, [fnA, fnB]);
    // Both fnMap entries (1-3) are contained in both functions (1-5) with
    // equal size → tie → assigned to none → both unmatched.
    expect(results[0]!.matched).toBe(false);
    expect(results[1]!.matched).toBe(false);
    // Statement excluded (no matched owner).
    expect(results[0]!.totalStatements).toBe(0);
    expect(results[1]!.totalStatements).toBe(0);
  });
});

describe("mapFileCoverage — unrelated paths / statement exclusion", () => {
  it("a statement inside unmatched tied inner functions is not attributed to a matched outer", () => {
    // Outer (1-10) has its own fnMap entry → matched. innerA (5-7) and
    // innerB (5-7) each have a fnMap entry, but both entries are contained
    // in both inner functions with equal range → tie → assigned to neither
    // → both inner functions unmatched.
    // Statement at 5-6: most-specific owner across ALL functions is
    // ambiguous (innerA and innerB tied at range 5-7) → excluded. The
    // statement does NOT fall through to the matched outer.
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 10 },
        "1": { name: "innerA", start: 5, end: 7 },
        "2": { name: "innerB", start: 5, end: 7 },
      },
      { "0": 1, "1": 1, "2": 1 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 4 },
        "1": { start: 5, end: 6 },
        "2": { start: 8, end: 10 },
      },
      { "0": 1, "1": 1, "2": 1 },
    );
    const outer = makeFunction("outer", 1, 10);
    const innerA = makeFunction("innerA", 5, 7);
    const innerB = makeFunction("innerB", 5, 7);
    const results = mapFileCoverage(entry, [outer, innerA, innerB]);
    const outerResult = results[0]!;
    const innerAResult = results[1]!;
    const innerBResult = results[2]!;

    // Outer matched, owns only its outer-only statements (1-4, 8-10) = 2.
    // The statement at 5-6 is ambiguous between innerA and innerB (tied
    // ranges 5-7) → excluded entirely. It does not fall through to outer.
    expect(outerResult.matched).toBe(true);
    expect(outerResult.totalStatements).toBe(2);
    expect(outerResult.coveredStatements).toBe(2);
    expect(outerResult.coverage).toBe(1);

    // Inner A and B: their fnMap entries (5-7) are tied (identical ranges)
    // → assigned to neither → unmatched.
    expect(innerAResult.matched).toBe(false);
    expect(innerAResult.totalStatements).toBe(0);
    expect(innerBResult.matched).toBe(false);
    expect(innerBResult.totalStatements).toBe(0);
  });

  it("a statement in an unmatched inner (no sibling) does not fall through to a matched outer", () => {
    // Outer (1-10) has its own fnMap entry → matched. Inner (5-7) has a
    // fnMap entry too, but the inner's entry loc (5-7) is also contained in
    // a sibling innerB (5-7) with the same range → inner entry ties → inner
    // unmatched. A statement at 5-6 is owned most-specifically by the inner
    // pair (range 5-7) — the inner is the uniquely-smallest container.
    // But the inner is unmatched → the statement is excluded, NOT credited
    // to the matched outer. Outer keeps its own outer-only statements only.
    //
    // Variant: here inner has no fnMap entry at all (truly unmatched, no
    // ambiguity). Statement at 5-6 is most-specifically owned by inner
    // (range 5-7), which is unmatched → excluded. Outer gets only 1-4, 8-10.
    const entry = makeFileEntry(
      {
        "0": { name: "outer", start: 1, end: 10 },
      },
      { "0": 1 },
      "/abs/path/sample.ts",
      {
        "0": { start: 1, end: 4 },
        "1": { start: 5, end: 6 },
        "2": { start: 8, end: 10 },
      },
      { "0": 1, "1": 1, "2": 1 },
    );
    const outer = makeFunction("outer", 1, 10);
    const inner = makeFunction("inner", 5, 7);
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    // Outer matched via its fnMap entry. Outer owns statements 1-4 and 8-10
    // (2 statements). Statement 5-6 is owned most-specifically by inner
    // (range 5-7 ⊂ outer range 1-10), but inner is unmatched → excluded.
    expect(outerResult.matched).toBe(true);
    expect(outerResult.totalStatements).toBe(2);
    expect(outerResult.coveredStatements).toBe(2);
    expect(outerResult.coverage).toBe(1);

    // Inner has no fnMap entry → unmatched, zero statements.
    expect(innerResult.matched).toBe(false);
    expect(innerResult.totalStatements).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exact range ordering — columns beyond 100,000 must not invert specificity
// ---------------------------------------------------------------------------

describe("mapFileCoverage — exact range ordering (large columns)", () => {
  it("columns beyond 100,000 preserve correct ownership (inner wins over outer)", () => {
    // Outer at line 1-2, col 0-10. Inner at line 1-1, col 0-200001 (same line
    // as outer's start, far larger column span but strictly contained in
    // outer on the line axis: inner line range [1,1] ⊂ outer [1,2]).
    // With the old numeric heuristic: outer size = (2-1)*100000 + 10 = 100010;
    // inner size = (1-1)*100000 + 200001 = 200001. The heuristic would pick
    // outer as "more specific" — WRONG, because inner [1,1] is a strict
    // line-subset of outer [1,2]. Exact ordering must pick inner.
    //
    // A fnMap entry at line 1 col 0 to line 1 col 50 is contained in both.
    // It must be assigned to inner (the true most-specific container).
    const entry = makeFileEntry(
      {
        "0": {
          name: "inner",
          start: 1,
          end: 1,
          startCol: 0,
          endCol: 50,
        },
      },
      { "0": 1 },
      "/abs/path/sample.ts",
      { "0": { start: 1, end: 1, startCol: 0, endCol: 50 } },
      { "0": 1 },
    );
    const outer = makeFunction(
      "outer",
      1,
      2,
      "/abs/path/sample.ts",
      0,
      10,
    );
    const inner = makeFunction(
      "inner",
      1,
      1,
      "/abs/path/sample.ts",
      0,
      200001,
    );
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    // Inner is the true most-specific container (line range [1,1] ⊂ [1,2]).
    // The fnMap entry and statement are assigned to inner.
    expect(innerResult.matched).toBe(true);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coveredStatements).toBe(1);
    expect(innerResult.coverage).toBe(1);

    // Outer has no assigned fnMap entry → unmatched.
    expect(outerResult.matched).toBe(false);
    expect(outerResult.totalStatements).toBe(0);
  });

  it("exact nested behavior: inner line-subset wins over outer with larger column span", () => {
    // Outer at line 1-3, col 0-5. Inner at line 2-2, col 0-500000.
    // Inner line range [2,2] ⊂ outer [1,3] → inner is more specific.
    // Old heuristic: outer = 2*100000 + 5 = 200005; inner = 0 + 500000 = 500000
    // → heuristic wrongly picks outer. Exact ordering picks inner.
    const entry = makeFileEntry(
      {
        "0": {
          name: "inner",
          start: 2,
          end: 2,
          startCol: 0,
          endCol: 10,
        },
      },
      { "0": 1 },
      "/abs/path/sample.ts",
      { "0": { start: 2, end: 2, startCol: 0, endCol: 10 } },
      { "0": 1 },
    );
    const outer = makeFunction("outer", 1, 3, "/abs/path/sample.ts", 0, 5);
    const inner = makeFunction(
      "inner",
      2,
      2,
      "/abs/path/sample.ts",
      0,
      500000,
    );
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    expect(innerResult.matched).toBe(true);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coverage).toBe(1);

    expect(outerResult.matched).toBe(false);
    expect(outerResult.totalStatements).toBe(0);
  });

  it("same-line large columns: strictly-contained inner wins by column", () => {
    // Both functions on line 1. Outer col 0-200000, inner col 50-100.
    // Inner is a strict column-subset of outer on the same line → inner is
    // more specific. A fnMap entry at col 60-80 is contained in both,
    // assigned to inner.
    const entry = makeFileEntry(
      {
        "0": {
          name: "inner",
          start: 1,
          end: 1,
          startCol: 60,
          endCol: 80,
        },
      },
      { "0": 1 },
      "/abs/path/sample.ts",
      { "0": { start: 1, end: 1, startCol: 60, endCol: 80 } },
      { "0": 1 },
    );
    const outer = makeFunction(
      "outer",
      1,
      1,
      "/abs/path/sample.ts",
      0,
      200000,
    );
    const inner = makeFunction(
      "inner",
      1,
      1,
      "/abs/path/sample.ts",
      50,
      100,
    );
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    expect(innerResult.matched).toBe(true);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coverage).toBe(1);

    expect(outerResult.matched).toBe(false);
    expect(outerResult.totalStatements).toBe(0);
  });
});
