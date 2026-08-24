import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mapAllCoverage,
  mapFileCoverage,
  mapFunctionCoverage,
  readCoverage,
} from "../src/coverage.js";
import type {
  FunctionCoverage,
  LocationRange,
  Position,
} from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";

/**
 * Direct in-process tests for the coverage mapping edge cases that the
 * extraction of pure helpers from findFileEntry, mostSpecificContainer, and
 * mapFileCoverage must preserve:
 *
 * - source-to-Istanbul matching stays fail-closed on ambiguity (suffix ties,
 *   basename-only suffixes, partial suffixes all rejected);
 * - exact boundary containment (loc start/end equal to function boundaries,
 *   null columns defaulting to 0, endColumn 0 functions);
 * - nested-function statements never leak to matched parents; no statement is
 *   ever counted by more than one function;
 * - statement count semantics (missing s keys, non-positive counts, sparse
 *   statementMap entries);
 * - filesystem/path identity (matching on entry path vs. top-level key, real
 *   existing directories through canonicalPath).
 */

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

interface FnLocSpec {
  name: string;
  start: number;
  end: number;
  startCol?: number | null;
  endCol?: number | null;
}

interface StLocSpec {
  start: number;
  end: number;
  startCol?: number | null;
  endCol?: number | null;
  count: number;
}

/**
 * Build an Istanbul-shaped file entry. fnMap locs default to col 0 → null
 * (end of line); statement ranges likewise.
 */
function makeEntry(
  filePath: string,
  fnLocs: FnLocSpec[],
  stmtLocs: StLocSpec[] = [],
): {
  path: string;
  fnMap: Record<string, { name: string; decl: LocationRange; loc: LocationRange }>;
  f: Record<string, number>;
  statementMap: Record<string, { start: Position; end: Position }>;
  s: Record<string, number>;
  b: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  meta: Record<string, unknown>;
} {
  const fnMap: Record<string, { name: string; decl: LocationRange; loc: LocationRange }> = {};
  const f: Record<string, number> = {};
  fnLocs.forEach((v, i) => {
    const startCol = v.startCol ?? 0;
    fnMap[String(i)] = {
      name: v.name,
      decl: {
        start: { line: v.start, column: startCol },
        end: { line: v.start, column: startCol + 10 },
      },
      loc: {
        start: { line: v.start, column: startCol },
        end: { line: v.end, column: v.endCol ?? null },
      },
    };
    f[String(i)] = 1;
  });
  const statementMap: Record<string, { start: Position; end: Position }> = {};
  const s: Record<string, number> = {};
  stmtLocs.forEach((v, i) => {
    statementMap[String(i)] = {
      start: { line: v.start, column: v.startCol ?? 0 },
      end: { line: v.end, column: v.endCol ?? null },
    };
    s[String(i)] = v.count;
  });
  return {
    path: filePath,
    fnMap,
    f,
    statementMap,
    s,
    b: {},
    branchMap: {},
    meta: {},
  };
}

// ---------------------------------------------------------------------------
// readCoverage — JSON shape validation (direct)
// ---------------------------------------------------------------------------

describe("readCoverage — JSON shape validation (direct)", () => {
  const tmpDirs: string[] = [];

  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-coverage-direct-"));
    tmpDirs.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws 'must be a JSON object' when the JSON root is an array", () => {
    const file = writeTmp("array.json", "[1, 2, 3]");
    expect(() => readCoverage(file)).toThrow("must be a JSON object");
  });

  it("throws 'must be a JSON object' when the JSON root is null", () => {
    const file = writeTmp("null.json", "null");
    expect(() => readCoverage(file)).toThrow("must be a JSON object");
  });

  it("throws 'must be a JSON object' when the JSON root is a string", () => {
    const file = writeTmp("string.json", '"data"');
    expect(() => readCoverage(file)).toThrow("must be a JSON object");
  });

  it("wraps invalid JSON with the absolute path of the file", () => {
    const file = writeTmp("broken.json", "not json {");
    const abs = path.resolve(file);
    expect(() => readCoverage(file)).toThrow(
      new RegExp(`^Coverage file ${abs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON: `),
    );
  });

  it("throws a file-system error (not a JSON error) for a missing file", () => {
    const missing = path.join(os.tmpdir(), "definitely-absent-coverage.json");
    expect(() => readCoverage(missing)).toThrow();
    expect(() => readCoverage(missing)).not.toThrow("is not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// Exact path matching — entry path vs. top-level key, real filesystem paths
// ---------------------------------------------------------------------------

describe("mapAllCoverage — exact path matching (direct)", () => {
  const tmpDirs: string[] = [];
  const realFile = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-coverage-direct-"));
    tmpDirs.push(dir);
    return path.join(dir, "sample.ts");
  })();

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches on the entry's path even when the top-level key differs", () => {
    // The coverage top-level key is unrelated; the entry's own `path` is the
    // real existing source file. Exact entry-path match must win.
    const coverage = {
      "unrelated/key/name": makeEntry(realFile, [{ name: "fn", start: 1, end: 3 }], [
        { start: 1, end: 2, count: 4 },
        { start: 2, end: 3, count: 0 },
      ]),
    };
    const fn = makeFunction("fn", 1, 3, realFile);
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(true);
    expect(results[0]?.totalStatements).toBe(2);
    expect(results[0]?.coveredStatements).toBe(1);
  });

  it("matches when only the top-level key equals the source path", () => {
    // The entry's own `path` points elsewhere; only the top-level key matches
    // the source path. Key match must still be accepted (and must select this
    // entry, proving the statement counts come from it).
    const coverage = {
      [realFile]: makeEntry("/elsewhere/entirely/different.ts", [{ name: "fn", start: 1, end: 3 }], [
        { start: 1, end: 3, count: 7 },
      ]),
    };
    const fn = makeFunction("fn", 1, 3, realFile);
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(true);
    expect(results[0]?.totalStatements).toBe(1);
    expect(results[0]?.coveredStatements).toBe(1);
    expect(results[0]?.coverage).toBe(1);
  });

  it("does not exact-match a different file that merely shares the directory", () => {
    const sibling = path.join(path.dirname(realFile), "other.ts");
    const coverage = {
      [sibling]: makeEntry(sibling, [{ name: "fn", start: 1, end: 3 }]),
    };
    const fn = makeFunction("fn", 1, 3, realFile);
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
    expect(results[0]?.coverage).toBe(0);
    expect(results[0]?.totalStatements).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Anchored suffix matching — fail-closed on ambiguity and partial suffixes
// ---------------------------------------------------------------------------

describe("mapAllCoverage — anchored suffix matching (direct)", () => {
  it("accepts an unambiguous suffix that covers the full relative path", () => {
    // Target 3 segments; entry path shares all 3 (plus extra leading segments
    // on the coverage side). bestScore >= target segment count → accept.
    const coverage = {
      k1: makeEntry("/home/user/repo/src/foo.ts", [{ name: "fn", start: 1, end: 3 }]),
    };
    const fn = makeFunction("fn", 1, 3, "/repo/src/foo.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(true);
  });

  it("rejects a suffix that does not cover the full target relative path", () => {
    // Target 5 segments; entry shares only the trailing 1 segment
    // (sample.ts) — bestScore 1 < 5 → anchored match required, reject.
    const coverage = {
      k1: makeEntry("/tmp/a/b/d/sample.ts", [{ name: "fn", start: 1, end: 3 }]),
    };
    const fn = makeFunction("fn", 1, 3, "/tmp/a/b/c/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
    expect(results[0]?.coverage).toBe(0);
  });

  it("rejects ambiguous ties at a best score below the target length", () => {
    // Two entries each share a 2-segment suffix with the target (bestScore 2)
    // — they tie, so the match is ambiguous and rejected even though no
    // single entry dominates.
    const coverage = {
      k1: makeEntry("/tmp/a/x/sample.ts", [{ name: "fnA", start: 1, end: 3 }]),
      k2: makeEntry("/tmp/b/x/sample.ts", [{ name: "fnB", start: 1, end: 3 }]),
    };
    const fn = makeFunction("fn", 1, 3, "/tmp/c/x/y/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
    expect(results[0]?.coverage).toBe(0);
  });

  it("rejects basename-only matches for multi-segment source paths", () => {
    const coverage = {
      k1: makeEntry("/x/y/sample.ts", [{ name: "fn", start: 1, end: 3 }]),
    };
    const fn = makeFunction("fn", 1, 3, "/different/path/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
  });

  it("rejects when no entry shares the target's final segment at all", () => {
    const coverage = {
      k1: makeEntry("/tmp/a/b/sample2.ts", [{ name: "fn", start: 1, end: 3 }]),
    };
    const fn = makeFunction("fn", 1, 3, "/tmp/a/b/sample.ts");
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fnMap identity edge cases (direct)
// ---------------------------------------------------------------------------

describe("mapFileCoverage — fnMap identity edge cases (direct)", () => {
  it("matches when the fnMap loc range is exactly equal to the function range", () => {
    // Exact-equality containment: loc (1,0)-(3,0) vs fn (1,0)-(3,100) —
    // start equal, end inside. Contained → unique candidate → matched.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3 }],
      [{ start: 1, end: 3, count: 2 }],
    );
    const fn = makeFunction("fn", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("leaves unmatched an fnMap entry that is outside every function range", () => {
    // The only fnMap entry's loc (1-3) is above the function (10-20): no
    // container → the function has no coverage identity, even though a
    // statement inside its range exists. A statement alone never matches.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "outer", start: 1, end: 3 }],
      [{ start: 12, end: 14, count: 5 }],
    );
    const fn = makeFunction("fn", 10, 20);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
    expect(result.totalStatements).toBe(0);
    expect(result.coveredStatements).toBe(0);
  });

  it("rejects an fnMap entry that starts inside the function but ends after it", () => {
    // loc (2,0)-(8,null) vs fn (2,0)-(5,100): end past the function end →
    // not contained → no identity.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 2, end: 8 }],
    );
    const fn = makeFunction("fn", 2, 5);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(false);
    expect(result.coverage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Containment exactness (direct)
// ---------------------------------------------------------------------------

describe("mapFileCoverage — containment exactness (direct)", () => {
  it("contains a loc ending exactly at the function end column; one column past is not", () => {
    const fn = makeFunction("fn", 1, 3, "/abs/path/sample.ts", 0, 100);
    const contained = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3, startCol: 0, endCol: 100 }],
    );
    const exceeded = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3, startCol: 0, endCol: 101 }],
    );
    expect(mapFunctionCoverage(contained, fn).matched).toBe(true);
    expect(mapFunctionCoverage(exceeded, fn).matched).toBe(false);
  });

  it("contains a loc starting exactly at the function start boundary", () => {
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 2 }],
    );
    const fn = makeFunction("fn", 1, 3);
    expect(mapFunctionCoverage(entry, fn).matched).toBe(true);
  });

  it("treats null end columns as column 0 when testing containment", () => {
    // fn ends at (3, 100); loc ends at (3, null→0): 0 <= 100 → contained.
    const nullEnd = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3, endCol: null }],
    );
    const fnWide = makeFunction("fn", 1, 3, "/abs/path/sample.ts", 0, 100);
    expect(mapFunctionCoverage(nullEnd, fnWide).matched).toBe(true);

    // But a function whose own end column is 0 cannot contain a loc ending
    // at column 5 on the same line.
    const fnZeroEnd = makeFunction("fn", 1, 3, "/abs/path/sample.ts", 0, 0);
    const wideEnd = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3, endCol: 5 }],
    );
    expect(mapFunctionCoverage(wideEnd, fnZeroEnd).matched).toBe(false);
  });

  it("excludes a statement whose range is outside every function (owner null)", () => {
    // fn (10-20) is matched; the statement sits at (30-40), outside all
    // functions → no owner → excluded; the matched fn keeps zero statements.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 10, end: 20 }],
      [{ start: 30, end: 40, count: 9 }],
    );
    const fn = makeFunction("fn", 10, 20);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(0);
    expect(result.coverage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Most-specific container ambiguity (direct)
// ---------------------------------------------------------------------------

describe("mapFileCoverage — most-specific container ambiguity (direct)", () => {
  it("rejects identity when two incomparable overlapping containers both contain the loc", () => {
    // fnA (1-5) and fnB (3-7) overlap but neither strictly contains the
    // other. The loc (4) sits in the overlap → both minimal → tie → the
    // entry is assigned to neither → both functions unmatched.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "shared", start: 4, end: 4 }],
      [{ start: 4, end: 4, count: 3 }],
    );
    const fnA = makeFunction("fnA", 1, 5);
    const fnB = makeFunction("fnB", 3, 7);
    const results = mapFileCoverage(entry, [fnA, fnB]);
    expect(results[0]?.matched).toBe(false);
    expect(results[0]?.totalStatements).toBe(0);
    expect(results[1]?.matched).toBe(false);
    expect(results[1]?.totalStatements).toBe(0);
  });

  it("resolves a three-level nesting to the innermost unique minimal", () => {
    // outer (1-10) ⊃ mid (3-7) ⊃ inner (4-5). The loc (4) is contained in
    // all three; only inner is minimal → inner matched, outer/mid not.
    // The statement at (4) is owned by inner alone.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "inner", start: 4, end: 4 }],
      [{ start: 4, end: 4, count: 1 }],
    );
    const outer = makeFunction("outer", 1, 10);
    const mid = makeFunction("mid", 3, 7);
    const inner = makeFunction("inner", 4, 5);
    const results = mapFileCoverage(entry, [outer, mid, inner]);
    expect(results[0]?.matched).toBe(false);
    expect(results[1]?.matched).toBe(false);
    expect(results[2]?.matched).toBe(true);
    expect(results[2]?.totalStatements).toBe(1);
    expect(results[2]?.coveredStatements).toBe(1);
    expect(results[2]?.coverage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Statement count semantics (direct)
// ---------------------------------------------------------------------------

describe("mapFileCoverage — statement count semantics (direct)", () => {
  it("counts a statement whose count key is absent from s as total-only", () => {
    // statementMap has the statement but `s` omits its key: total 1,
    // covered 0, matched stays true.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3 }],
      [{ start: 1, end: 3, count: -1 }], // placeholder, replaced below
    );
    delete entry.s["0"];
    const fn = makeFunction("fn", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(1);
    expect(result.coveredStatements).toBe(0);
    expect(result.coverage).toBe(0);
  });

  it("does not credit non-positive counts as covered", () => {
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3 }],
      [
        { start: 1, end: 2, count: -5 },
        { start: 2, end: 3, count: 0 },
      ],
    );
    const fn = makeFunction("fn", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.totalStatements).toBe(2);
    expect(result.coveredStatements).toBe(0);
    expect(result.coverage).toBe(0);
  });

  it("skips a sparse statementMap slot (key present, value undefined)", () => {
    // Malformed Istanbul shape: the statementMap declares "1" but its value
    // is undefined. The mapper must skip it, not crash or count it.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3 }],
      [{ start: 1, end: 2, count: 2 }],
    );
    (entry.statementMap as Record<string, unknown>)["1"] = undefined;
    entry.s["1"] = 4;
    const fn = makeFunction("fn", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(1);
    expect(result.coveredStatements).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("keeps a matched function at zero statements when statementMap is empty", () => {
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "fn", start: 1, end: 3 }],
    );
    const fn = makeFunction("fn", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(0);
    expect(result.coverage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// One-to-one ownership: nested statements never leak to parents
// ---------------------------------------------------------------------------

describe("mapFileCoverage — one-to-one ownership invariants (direct)", () => {
  it("no statement is counted by more than one function (leak check)", () => {
    // Matched outer (1-10) and matched inner (5-7). Statements:
    //   s0 (2-3) covered → outer
    //   s1 (5-6) covered → inner (must NOT also count for outer)
    //   s2 (8-9) uncovered → outer
    //   s3 (12-13) covered → outside all functions, unattributed
    // Totals: outer 2 (1 covered), inner 1 (1 covered), sum 3 of 4.
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [
        { name: "outer", start: 1, end: 10 },
        { name: "inner", start: 5, end: 7 },
      ],
      [
        { start: 2, end: 3, count: 1 },
        { start: 5, end: 6, count: 2 },
        { start: 8, end: 9, count: 0 },
        { start: 12, end: 13, count: 3 },
      ],
    );
    const outer = makeFunction("outer", 1, 10);
    const inner = makeFunction("inner", 5, 7);
    const results = mapFileCoverage(entry, [outer, inner]);
    const outerResult = results[0]!;
    const innerResult = results[1]!;

    expect(outerResult.totalStatements).toBe(2);
    expect(outerResult.coveredStatements).toBe(1);
    expect(innerResult.totalStatements).toBe(1);
    expect(innerResult.coveredStatements).toBe(1);
    // Sum of owned statements equals exactly the attributable statements.
    const ownedTotal = results.reduce(
      (sum: number, r: FunctionCoverage) => sum + r.totalStatements,
      0,
    );
    expect(ownedTotal).toBe(3);
  });

  it("an unmatched inner function absorbs its statements away from the matched outer", () => {
    // Outer (1-10) matched; inner (5-7) has NO fnMap entry → unmatched.
    // Statement (5-6) is most-specifically owned by inner → excluded
    // entirely (no fall-through to outer).
    const entry = makeEntry(
      "/abs/path/sample.ts",
      [{ name: "outer", start: 1, end: 10 }],
      [
        { start: 2, end: 3, count: 1 },
        { start: 5, end: 6, count: 1 },
        { start: 8, end: 9, count: 1 },
      ],
    );
    const outer = makeFunction("outer", 1, 10);
    const inner = makeFunction("inner", 5, 7);
    const results = mapFileCoverage(entry, [outer, inner]);
    expect(results[0]?.matched).toBe(true);
    expect(results[0]?.totalStatements).toBe(2);
    expect(results[1]?.matched).toBe(false);
    expect(results[1]?.totalStatements).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Grouping and order preservation (direct)
// ---------------------------------------------------------------------------

describe("mapAllCoverage — grouping and order preservation (direct)", () => {
  it("preserves input order across multiple files", () => {
    const fileA = "/proj/src/a.ts";
    const fileB = "/proj/src/b.ts";
    const coverage = {
      a: makeEntry(fileA, [{ name: "fnA", start: 1, end: 3 }]),
      b: makeEntry(fileB, [{ name: "fnB", start: 1, end: 3 }]),
    };
    const fnA1 = makeFunction("fnA1", 1, 3, fileA);
    const fnB1 = makeFunction("fnB1", 1, 3, fileB);
    const fnA2 = makeFunction("fnA2", 5, 7, fileA);
    const results = mapAllCoverage([fnA1, fnB1, fnA2], coverage);
    expect(results.length).toBe(3);
    expect(results[0]?.functionInfo).toBe(fnA1);
    expect(results[1]?.functionInfo).toBe(fnB1);
    expect(results[2]?.functionInfo).toBe(fnA2);
    expect(results[0]?.matched).toBe(true);
    expect(results[1]?.matched).toBe(true);
    // fnA2 has no fnMap identity of its own (the entry's loc 1-3 is
    // contained only in fnA1's range 1-3... fnA2 is 5-7 → unmatched).
    expect(results[2]?.matched).toBe(false);
  });

  it("zeroes functions whose file is absent without affecting other files", () => {
    const present = "/proj/src/present.ts";
    const coverage = {
      p: makeEntry(present, [{ name: "fn", start: 1, end: 3 }], [
        { start: 1, end: 3, count: 2 },
      ]),
    };
    const presentFn = makeFunction("fn", 1, 3, present);
    const absentFn = makeFunction("fn", 1, 3, "/proj/src/absent.ts");
    const results = mapAllCoverage([presentFn, absentFn], coverage);
    expect(results[0]?.matched).toBe(true);
    expect(results[0]?.coverage).toBe(1);
    expect(results[1]?.matched).toBe(false);
    expect(results[1]?.coverage).toBe(0);
    expect(results[1]?.totalStatements).toBe(0);
  });
});
