/**
 * Focused unit tests for the own-source self-score gate logic exported from
 * scripts/self-score.ts (gate-integrity remediation, threshold-8 stack):
 *
 * - parseSelfScoreReport: JSON parse + structural validation of CLI stdout,
 *   including coherent numeric/integer/range/count checks;
 * - breachingRowsOf: strict crap > applicable-threshold recomputation;
 * - validateSelfScoreReport: row-level gate integrity (every row threshold
 *   exactly 8, coverage semantics, coverageMatched coherence, CRAP
 *   independently recomputed from the production formula, breached rows
 *   recomputed) and report completeness (exact one-to-one representation of
 *   the independently built current function inventory, zero-function
 *   source files, coverage-file entries vs report rows);
 * - buildExpectedFunctions / functionIdentityKey: the independent inventory
 *   built via the production discovery/analysis API;
 * - assertCoverageFreshness: missing and stale coverage detection;
 * - formatSelfScorePassAudit / formatBreachedRows: exact output strings;
 * - runSelfScoreGate: real CLI execution, end to end (a clean pass over the
 *   actual repository coverage and a fail-closed run against a corrupted
 *   coverage file), with freshness diagnostics preserved.
 *
 * The adversarial regression cases mirror the review proofs: a raised row
 * threshold, a forged CRAP score, impossible count/coverage/matched
 * relationships, an omitted current function/source, and
 * duplicate/unexpected rows.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCoverageFreshness,
  buildExpectedFunctions,
  breachingRowsOf,
  formatBreachedRows,
  formatSelfScorePassAudit,
  functionIdentityKey,
  parseSelfScoreReport,
  runSelfScoreGate,
  validateSelfScoreReport,
} from "../scripts/self-score.js";
import type {
  SelfScoreGateContext,
} from "../scripts/self-score.js";
import { discoverSourceFiles } from "../src/complexity.js";
import type {
  SelfScoreReport,
  SelfScoreRow,
} from "../src/self-score-helpers.js";

/** Repository root (parent of the test/ directory). */
const REPO_ROOT = path.resolve(__dirname, "..");

/** Long-running end-to-end tests (real CLI subprocess) need a generous budget. */
const E2E_TIMEOUT_MS = 180000;

/**
 * One structurally valid report row. The values are coherent with the
 * production coverage semantics: coverage = covered/total, CRAP computed by
 * the production formula cc^2 * (1-cov)^3 + cc (cc 2, cov 1 -> 2).
 */
function makeRow(overrides: Partial<SelfScoreRow> = {}): SelfScoreRow {
  return {
    name: "alpha",
    displayName: "alpha",
    filePath: "/repo/src/alpha.ts",
    startLine: 1,
    endLine: 10,
    complexity: 2,
    coverage: 1,
    crap: 2,
    coverageMatched: true,
    totalStatements: 4,
    coveredStatements: 4,
    threshold: 8,
    ...overrides,
  };
}

/** A summary that is consistent with the given rows (breach recomputed). */
function makeSummary(
  rows: SelfScoreRow[],
  overrides: {
    threshold?: number;
    totalFunctions?: number;
    breachedCount?: number;
    maxCrap?: number;
    breached?: boolean;
  } = {},
): SelfScoreReport["summary"] {
  const maxCrap = rows.reduce((max, row) => Math.max(max, row.crap), 0);
  const breachedCount = rows.filter((row) => row.crap > row.threshold).length;
  return {
    totalFunctions: rows.length,
    breachedCount,
    maxCrap,
    threshold: 8,
    breached: breachedCount > 0,
    ...overrides,
  };
}

/** A report whose summary is consistent with its own rows. */
function makeReport(
  rows: SelfScoreRow[],
  summaryOverrides: Parameters<typeof makeSummary>[1] = {},
): SelfScoreReport {
  return { rows, summary: makeSummary(rows, summaryOverrides) };
}

/**
 * The default gate context: threshold 8, two tracked src files (one with a
 * real function, one with zero functions), and the same degenerate-report
 * floors the script itself uses.
 */
function makeContext(
  overrides: Partial<SelfScoreGateContext> = {},
): SelfScoreGateContext {
  const tracked = ["/repo/src/alpha.ts", "/repo/src/beta.ts"];
  return {
    threshold: 8,
    expectedSourceFiles: new Set(tracked),
    expectedCoverageTrackedFiles: new Set(tracked),
    expectedCoverageSourceFiles: new Set(tracked),
    expectedFunctions: [
      {
        key: functionIdentityKey("/repo/src/alpha.ts", 1, 10, "alpha", "alpha", 2),
        filePath: "/repo/src/alpha.ts",
        name: "alpha",
        displayName: "alpha",
        startLine: 1,
        endLine: 10,
        startColumn: 0,
        endColumn: 20,
        complexity: 2,
      },
    ],
    minTotalFunctions: 1,
    minMatchedFunctions: 1,
    ...overrides,
  };
}

/** The one row of a clean own-source report against the default context. */
function cleanReport(): SelfScoreReport {
  return makeReport([makeRow()]);
}

/** A valid report with two rows, both representing current functions. */
function twoRowContextAndReport(): { ctx: SelfScoreGateContext; report: SelfScoreReport } {
  const alpha = makeRow();
  const beta = makeRow({
    name: "beta",
    displayName: "beta",
    filePath: "/repo/src/beta.ts",
    startLine: 5,
    endLine: 9,
    complexity: 4,
    totalStatements: 8,
    coveredStatements: 8,
    crap: 4, // cc 4, cov 1 -> 4
  });
  const ctx = makeContext({
    expectedFunctions: [
      {
        key: functionIdentityKey("/repo/src/alpha.ts", 1, 10, "alpha", "alpha", 2),
        filePath: "/repo/src/alpha.ts",
        name: "alpha",
        displayName: "alpha",
        startLine: 1,
        endLine: 10,
        startColumn: 0,
        endColumn: 20,
        complexity: 2,
      },
      {
        key: functionIdentityKey("/repo/src/beta.ts", 5, 9, "beta", "beta", 4),
        filePath: "/repo/src/beta.ts",
        name: "beta",
        displayName: "beta",
        startLine: 5,
        endLine: 9,
        startColumn: 0,
        endColumn: 15,
        complexity: 4,
      },
    ],
  });
  return { ctx, report: makeReport([alpha, beta]) };
}

describe("parseSelfScoreReport", () => {
  it("parses a valid report object", () => {
    const raw = JSON.stringify(cleanReport());
    const parsed = parseSelfScoreReport(raw);
    expect(parsed.error).toBeNull();
    expect(parsed.report?.rows).toHaveLength(1);
    expect(parsed.report?.summary.threshold).toBe(8);
  });

  it("rejects non-JSON output", () => {
    const parsed = parseSelfScoreReport("not json at all");
    expect(parsed.report).toBeNull();
    expect(parsed.error).toContain("not valid JSON");
  });

  it("rejects a JSON top level that is not an object", () => {
    const parsed = parseSelfScoreReport("[1, 2, 3]");
    expect(parsed.report).toBeNull();
    expect(parsed.error).toContain("must be a report object");
  });

  it("rejects a missing rows array", () => {
    const parsed = parseSelfScoreReport(
      JSON.stringify({ summary: cleanReport().summary }),
    );
    expect(parsed.report).toBeNull();
    expect(parsed.error).toContain("report.rows is missing or not an array");
  });

  it("rejects a row with a non-string name", () => {
    const report = cleanReport();
    (report.rows[0] as { name: unknown }).name = 42;
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("rows[0].name is not a string");
  });

  it("rejects a row with a non-finite crap value", () => {
    const report = cleanReport();
    (report.rows[0] as { crap: unknown }).crap = NaN;
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("rows[0].crap is not a finite number");
  });

  it("rejects a row with coverage outside [0, 1]", () => {
    const report = cleanReport();
    (report.rows[0] as { coverage: unknown }).coverage = 1.5;
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("rows[0].coverage is outside [0, 1]");
  });

  it("rejects a row with a non-boolean coverageMatched", () => {
    const report = cleanReport();
    (report.rows[0] as { coverageMatched: unknown }).coverageMatched = "yes";
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("rows[0].coverageMatched is not a boolean");
  });

  it("rejects a row that is not an object", () => {
    const parsed = parseSelfScoreReport(
      JSON.stringify({ rows: ["not a row"], summary: cleanReport().summary }),
    );
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("rows[0] is not an object");
  });

  it("rejects a missing summary object", () => {
    const parsed = parseSelfScoreReport(JSON.stringify({ rows: [] }));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toContain("report.summary is missing or not an object");
  });

  it("rejects a summary with a non-finite maxCrap", () => {
    const report = cleanReport();
    (report.summary as { maxCrap: unknown }).maxCrap = "lots";
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("report.summary.maxCrap is not a finite number");
  });

  it("rejects a summary with a non-boolean breached flag", () => {
    const report = cleanReport();
    (report.summary as { breached: unknown }).breached = "no";
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("report.summary.breached is not a boolean");
  });
});

describe("parseSelfScoreReport: coherent numeric/integer/range/count shape", () => {
  function parsedRowError(row: Record<string, unknown>): string | null {
    const parsed = parseSelfScoreReport(
      JSON.stringify({ rows: [row], summary: cleanReport().summary }),
    );
    return parsed.error ?? "unexpectedly parsed as valid";
  }

  it("rejects coveredStatements greater than totalStatements (impossible count)", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["coveredStatements"] = 9;
    (row as unknown as Record<string, unknown>)["totalStatements"] = 4;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "exceeds",
    );
  });

  it("rejects a negative statement count", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["totalStatements"] = -1;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "statement count",
    );
  });

  it("rejects non-integer statement counts", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["totalStatements"] = 4.5;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "statement count",
    );
  });

  it("rejects non-integer line numbers", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["startLine"] = 1.5;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "line numbers",
    );
  });

  it("rejects an endLine before the startLine (impossible range)", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["endLine"] = 0;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "line numbers",
    );
  });

  it("rejects a startLine of 0 (lines are 1-based)", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["startLine"] = 0;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "line numbers",
    );
  });

  it("rejects a non-integer complexity", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["complexity"] = 2.5;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "complexity",
    );
  });

  it("rejects a zero or negative complexity", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["complexity"] = 0;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "complexity",
    );
  });

  it("rejects a non-integer threshold", () => {
    const row = makeRow();
    (row as unknown as Record<string, unknown>)["threshold"] = 8.5;
    expect(parsedRowError(row as unknown as Record<string, unknown>)).toContain(
      "threshold",
    );
  });

  it("accepts coherent zero-statement rows (the zero-statement case)", () => {
    // Parse-time shape check only: an unmatched row with coverage 0 and zero
    // statements is structurally coherent (the zero-statement case). The
    // CRAP recomputation for such a row is pinned separately in the
    // validateSelfScoreReport tests.
    const parsed = parseSelfScoreReport(
      JSON.stringify(
        makeReport([
          makeRow({
            coverageMatched: false,
            coverage: 0,
            totalStatements: 0,
            coveredStatements: 0,
            crap: 6,
          }),
        ]),
      ),
    );
    expect(parsed.error).toBeNull();
  });
});

describe("breachingRowsOf", () => {
  it("returns rows whose crap strictly exceeds their applicable threshold", () => {
    const report = makeReport([
      makeRow({ crap: 9 }),
      makeRow({ name: "edge", displayName: "edge", crap: 8 }),
    ]);
    const breaches = breachingRowsOf(report);
    expect(breaches.map((row) => row.name)).toEqual(["alpha"]);
  });

  it("does not count a row at exactly its threshold as a breach", () => {
    const report = makeReport([makeRow({ crap: 8 })]);
    expect(breachingRowsOf(report)).toEqual([]);
  });
});

describe("validateSelfScoreReport: row-level gate integrity", () => {
  it("passes a clean own-source report", () => {
    expect(validateSelfScoreReport(cleanReport(), makeContext())).toBeNull();
  });

  it("rejects a RAISED row threshold (9) even when the summary threshold is 8", () => {
    const report = makeReport([makeRow({ threshold: 9, crap: 9 })]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("row threshold 9");
    expect(err).toContain("exactly 8");
    expect(err).toContain("no path config");
  });

  it("rejects a LOWERED row threshold (7) the same way", () => {
    const report = makeReport([makeRow({ threshold: 7 })]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("row threshold 7");
  });

  it("fails when the summary threshold does not match the gate threshold", () => {
    const report = makeReport(cleanReport().rows, { threshold: 30 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("summary threshold 30");
    expect(err).toContain("does not match the gate threshold 8");
  });

  it("rejects a FORGED crap score that deviates from the production formula", () => {
    // alpha is cc 2, coverage 1: the production formula gives exactly 2.
    // The row is otherwise internally coherent (coverage matches its
    // counts), so only the independent CRAP recomputation catches this.
    const report = makeReport([makeRow({ crap: 1.9 })]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("deviates from");
    expect(err).toContain("independently recomputed CRAP 2");
  });

  it("rejects a forged CRAP produced by a forged complexity (inventory still matches)", () => {
    // Forging the row's complexity to 3 keeps the row matched against a
    // current function only if that function really has cc 3; here the
    // inventory cc is 2, so the row identity itself no longer matches and
    // the gate must fail (either as an unexpected row or a CRAP
    // deviation). Both are acceptable rejections of the forgery.
    const report = makeReport([makeRow({ complexity: 3 })]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toMatch(/deviates from|does not match any function/);
  });

  it("rejects impossible coverage semantics: coverage != covered/total", () => {
    const report = makeReport([
      makeRow({ coverage: 0.5, coveredStatements: 3, totalStatements: 10 }),
    ]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("inconsistent");
    expect(err).toContain("0.3");
  });

  it("enforces the zero-statement coverage semantics: total 0 requires coverage 0", () => {
    const report = makeReport([
      makeRow({ coverage: 0.25, totalStatements: 0, coveredStatements: 0 }),
    ]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("inconsistent");
    expect(err).toContain("the correct coverage for");
  });

  it("rejects an UNMATCHED row claiming positive coverage (matched-status incoherence)", () => {
    // coverage 0.5 is impossible for a row with zero statements: the
    // fraction check (coverage must equal covered/total) is the gate's
    // first defense and rejects it before the matched-status check.
    const report = makeReport([
      makeRow({
        coverageMatched: false,
        coverage: 0.5,
        totalStatements: 0,
        coveredStatements: 0,
        crap: 2.5, // 2^2 * 0.5^3 + 2 = 0.25 + 2 = 2.5, so CRAP verifies
      }),
    ]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("inconsistent with its statement counts");
    expect(err).toContain("the correct coverage for");
  });

  it("rejects an UNMATCHED row carrying statement counts (matched-status incoherence)", () => {
    const report = makeReport([
      makeRow({
        coverageMatched: false,
        coverage: 0,
        totalStatements: 5,
        coveredStatements: 0,
      }),
    ]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).not.toBeNull();
    expect(err).toContain("carries");
    expect(err).toContain("zero statements");
  });

  it("accepts an unmatched row with coverage 0 and zero statements", () => {
    // src/beta.ts is tracked by the coverage but has zero functions in the
    // current tree: zero rows represent it, and the single (unmatched)
    // alpha row proves every current function exactly once. The matched
    // floor is 0 here: the floor under test is not matched coverage.
    const report = makeReport([
      makeRow({
        coverageMatched: false,
        coverage: 0,
        totalStatements: 0,
        coveredStatements: 0,
        crap: 6, // cc 2, cov 0 -> 6
      }),
    ]);
    const ctx = makeContext({ minMatchedFunctions: 0 });
    expect(validateSelfScoreReport(report, ctx)).toBeNull();
  });

  it("fails when totalFunctions does not match the actual row count", () => {
    const report = makeReport(cleanReport().rows, { totalFunctions: 99 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("totalFunctions 99");
    expect(err).toContain("actual row count 1");
  });

  it("fails when maxCrap does not match the recomputed maximum", () => {
    const report = makeReport(cleanReport().rows, { maxCrap: 1 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("maxCrap 1");
    expect(err).toContain("recomputed maximum row CRAP 2");
  });

  it("recomputes the breached row set from the rows: summary breachedCount mismatch", () => {
    const report = makeReport(cleanReport().rows, { breachedCount: 3 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("breachedCount 3");
    expect(err).toContain("recomputed");
  });

  it("recomputes the breached row set from the rows: summary breached flag mismatch", () => {
    const report = makeReport(cleanReport().rows, { breached: true });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("summary breached=true");
    expect(err).toContain("0 breached row(s)");
  });
});

describe("validateSelfScoreReport: report completeness (one-to-one inventory)", () => {
  it("rejects an OMITTED current function (missing row)", () => {
    const { ctx, report } = twoRowContextAndReport();
    const dropped = makeReport(report.rows.filter((r) => r.name !== "beta"));
    const err = validateSelfScoreReport(dropped, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("omits current function");
    expect(err).toContain("beta");
  });

  it("rejects DUPLICATE rows for the same current function", () => {
    // The default context's alpha identity appears exactly once in the
    // current tree, so a second row for it is a genuine duplicate.
    const { ctx, report } = twoRowContextAndReport();
    const duplicated = makeReport([
      ...report.rows,
      { ...report.rows[0]! },
    ]);
    const err = validateSelfScoreReport(duplicated, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("duplicate rows");
    expect(err).toContain("alpha");
    expect(err).toContain("only 1 such function");
  });

  it("rejects an UNEXPECTED row that matches no current function", () => {
    const { ctx, report } = twoRowContextAndReport();
    const ghost = makeRow({
      name: "ghost",
      displayName: "ghost",
      startLine: 50,
      endLine: 60,
    });
    const unexpected = makeReport([...report.rows, ghost]);
    const err = validateSelfScoreReport(unexpected, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("does not match any function in the current source tree");
    expect(err).toContain("ghost");
  });

  it("rejects a row whose name no longer exists in the current tree (stale row)", () => {
    const { ctx } = twoRowContextAndReport();
    const stale = makeReport([
      makeRow({ name: "alpha", displayName: "alpha" }),
      makeRow({
        name: "oldBeta",
        displayName: "oldBeta",
        filePath: "/repo/src/beta.ts",
        startLine: 5,
        endLine: 9,
        complexity: 4,
        totalStatements: 8,
        coveredStatements: 8,
        crap: 4,
      }),
    ]);
    const err = validateSelfScoreReport(stale, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("does not match any function in the current source tree");
  });

  it("rejects a row for a zero-function source file (explicit zero-function handling)", () => {
    // /repo/src/beta.ts is in the expected source files but its inventory
    // entry is absent from this context: the file has zero functions.
    const ctx = makeContext({ expectedFunctions: [] });
    const report = makeReport([
      makeRow({ filePath: "/repo/src/beta.ts", name: "beta", displayName: "beta" }),
    ]);
    const err = validateSelfScoreReport(report, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("has zero functions in the current tree");
    expect(err).toContain("src/beta.ts");
  });

  it("rejects a row whose file is not part of the current src tree", () => {
    const report = makeReport([makeRow({ filePath: "/repo/src/legacy.ts" })]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("not part");
    expect(err).toContain("src/legacy.ts");
  });

  it("rejects a coverage-tracked file with functions whose rows are missing", () => {
    // beta is tracked by the coverage AND has a function in the current
    // tree: omitting that row is caught by the one-to-one inventory
    // proof (an omitted current function), not by a row-presence floor.
    const { ctx } = twoRowContextAndReport();
    const report = makeReport([
      makeRow({ name: "alpha", displayName: "alpha", filePath: "/repo/src/alpha.ts" }),
    ]);
    const err = validateSelfScoreReport(report, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("omits current function");
    expect(err).toContain("beta");
  });

  it("rejects a MISSING coverage entry for a file the run expects to track (corrupted coverage)", () => {
    const { ctx, report } = twoRowContextAndReport();
    const corruptCtx = {
      ...ctx,
      expectedCoverageSourceFiles: new Set(["/repo/src/alpha.ts"]),
    };
    const err = validateSelfScoreReport(report, corruptCtx);
    expect(err).not.toBeNull();
    expect(err).toContain("missing an entry");
    expect(err).toContain("beta.ts");
    expect(err).toContain("corrupted, stale, or was generated from a different tree");
  });

  it("rejects coverage entries for files the run is NOT expected to track (stale coverage)", () => {
    const { ctx, report } = twoRowContextAndReport();
    const staleCtx = {
      ...ctx,
      expectedSourceFiles: new Set([
        "/repo/src/alpha.ts",
        "/repo/src/beta.ts",
        "/repo/src/stale.ts",
      ]),
      expectedCoverageTrackedFiles: new Set(["/repo/src/alpha.ts", "/repo/src/beta.ts"]),
      expectedCoverageSourceFiles: new Set([
        "/repo/src/alpha.ts",
        "/repo/src/beta.ts",
        "/repo/src/stale.ts",
      ]),
    };
    const err = validateSelfScoreReport(report, staleCtx);
    expect(err).not.toBeNull();
    expect(err).toContain("not expected to track");
    expect(err).toContain("stale.ts");
  });

  it("fails when the report is below the secondary minimum function-count floor", () => {
    // Only alpha is tracked (the floor under test, not the inventory):
    // the report is otherwise a complete own-source result for it.
    const ctx = makeContext({
      minTotalFunctions: 3,
      expectedCoverageTrackedFiles: new Set(["/repo/src/alpha.ts"]),
      expectedCoverageSourceFiles: new Set(["/repo/src/alpha.ts"]),
    });
    const err = validateSelfScoreReport(cleanReport(), ctx);
    expect(err).toContain("only 1 functions");
    expect(err).toContain("< 3");
  });

  it("fails when too few functions are coverage-matched (secondary floor)", () => {
    const report = makeReport([
      makeRow({
        coverageMatched: false,
        coverage: 0,
        totalStatements: 0,
        coveredStatements: 0,
        crap: 6, // cc 2, cov 0 -> 6
      }),
    ]);
    const ctx = makeContext({
      minMatchedFunctions: 1,
      expectedCoverageTrackedFiles: new Set(["/repo/src/alpha.ts"]),
      expectedCoverageSourceFiles: new Set(["/repo/src/alpha.ts"]),
    });
    const err = validateSelfScoreReport(report, ctx);
    expect(err).toContain("only 0 coverage-matched functions");
  });
  it("reports the threshold mismatch before row-level checks", () => {
    const report = makeReport(
      [makeRow({ filePath: "/repo/src/legacy.ts" })],
      { threshold: 30 },
    );
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("summary threshold 30");
  });
});

describe("functionIdentityKey and buildExpectedFunctions (independent inventory)", () => {
  it("builds the canonical identity key from file, range, name, and complexity", () => {
    const key = functionIdentityKey("/repo/src/a.ts", 3, 9, "fn", "fn", 5);
    expect(key).toContain("/repo/src/a.ts");
    expect(key).toContain("3:9");
    expect(key).toContain("fn");
    expect(key).toContain("5");
    // A different complexity or range yields a different identity.
    expect(functionIdentityKey("/repo/src/a.ts", 3, 9, "fn", "fn", 6)).not.toBe(key);
    expect(functionIdentityKey("/repo/src/a.ts", 4, 9, "fn", "fn", 5)).not.toBe(key);
    expect(functionIdentityKey("/repo/src/a.ts", 3, 9, "other", "other", 5)).not.toBe(key);
  });

  it("builds the inventory from the ACTUAL current src tree via the production API", () => {
    const files = discoverSourceFiles([path.join(REPO_ROOT, "src")]);
    expect(files.length).toBeGreaterThanOrEqual(10);
    const expected = buildExpectedFunctions(files);
    expect(expected.length).toBeGreaterThanOrEqual(150);
    for (const fn of expected) {
      expect(typeof fn.key).toBe("string");
      expect(fn.key.length).toBeGreaterThan(0);
      expect(Number.isInteger(fn.startLine)).toBe(true);
      expect(fn.startLine).toBeGreaterThanOrEqual(1);
      expect(fn.endLine).toBeGreaterThanOrEqual(fn.startLine);
      expect(fn.complexity).toBeGreaterThanOrEqual(1);
    }
    // Every inventory entry belongs to a file in the discovered set.
    const filesSet = new Set(files.map((f) => f.split(path.sep).join("/")));
    for (const fn of expected) {
      expect(filesSet.has(fn.filePath.split(path.sep).join("/"))).toBe(true);
    }
  });

  it("represents zero-function source files with zero inventory entries", () => {
    const files = discoverSourceFiles([path.join(REPO_ROOT, "src")]);
    const expected = buildExpectedFunctions(files);
    const byFile = new Map<string, number>();
    for (const fn of expected) {
      byFile.set(fn.filePath, (byFile.get(fn.filePath) ?? 0) + 1);
    }
    const zeroFunctionFiles = files.filter(
      (f) => (byFile.get(f.split(path.sep).join("/")) ?? 0) === 0,
    );
    // src/index.ts is the known zero-function source file in this repo.
    const relNames = zeroFunctionFiles.map((f) => path.relative(REPO_ROOT, f));
    expect(relNames).toContain("src/index.ts");
  });
});

describe("assertCoverageFreshness", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir !== undefined && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeSandbox(): { coverage: string; sources: string[] } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-score-fresh-"));
    const src = path.join(tmpDir, "src");
    fs.mkdirSync(src, { recursive: true });
    const coverage = path.join(tmpDir, "coverage-final.json");
    fs.writeFileSync(coverage, "{}");
    const sources = ["a.ts", "b.ts"].map((name) => {
      const file = path.join(src, name);
      fs.writeFileSync(file, "export const x = 1;\n");
      return file;
    });
    return { coverage, sources };
  }

  it("fails when the coverage file is missing", () => {
    const missing = path.join(os.tmpdir(), "nope", "coverage-final.json");
    const err = assertCoverageFreshness(missing, []);
    expect(err).toContain("not found");
    expect(err).toContain("npm run coverage");
  });

  it("passes when the coverage file is newer than every source file", () => {
    const { coverage, sources } = makeSandbox();
    const past = new Date(Date.now() - 60000).getTime();
    for (const file of sources) {
      fs.utimesSync(file, new Date(past), new Date(past));
    }
    expect(assertCoverageFreshness(coverage, sources)).toBeNull();
  });

  it("fails when a source file is meaningfully newer than the coverage", () => {
    const { coverage, sources } = makeSandbox();
    const first = sources[0]!;
    const future = new Date(Date.now() + 60000).getTime();
    fs.utimesSync(first, new Date(future), new Date(future));
    const err = assertCoverageFreshness(coverage, sources);
    expect(err).toContain("stale");
    expect(err).toContain("1 source file(s)");
    expect(err).toContain("a.ts");
    expect(err).toContain("npm run coverage");
  });

  it("tolerates mtime jitter within the staleness tolerance", () => {
    const { coverage, sources } = makeSandbox();
    const first = sources[0]!;
    // 200ms newer: within the script's 1000ms tolerance, so not stale.
    const soon = new Date(Date.now() + 200).getTime();
    fs.utimesSync(first, new Date(soon), new Date(soon));
    expect(assertCoverageFreshness(coverage, sources)).toBeNull();
  });
});

describe("formatSelfScorePassAudit", () => {
  it("prints the exact audit block for a clean report", () => {
    const report = makeReport([
      makeRow(),
      makeRow({
        name: "beta",
        displayName: "beta",
        filePath: "/repo/src/beta.ts",
        coverage: 0.5,
        coveredStatements: 4,
        totalStatements: 8,
        crap: 20,
      }),
    ]);
    expect(formatSelfScorePassAudit(report, 8)).toBe(
      [
        "Self-score OK: own-source CRAP gate passed at threshold 8.",
        "  functions: 2 (coverage-matched: 2)",
        "  max CRAP: 20.0",
        "  breached rows: 0",
      ].join("\n"),
    );
  });
});

describe("formatBreachedRows", () => {
  it("formats one diagnostic line per breached row", () => {
    const breaches = [
      makeRow({ complexity: 3, coverage: 0.5, coveredStatements: 1, totalStatements: 2, crap: 12.5 }),
      makeRow({
        name: "beta",
        displayName: "beta",
        filePath: "/repo/src/beta.ts",
        complexity: 6,
        coverage: 0,
        totalStatements: 0,
        coveredStatements: 0,
        crap: 42,
        threshold: 8,
      }),
    ];
    expect(formatBreachedRows(breaches)).toBe(
      [
        "  alpha (/repo/src/alpha.ts:1): CRAP 12.5 > threshold 8, cc 3, coverage 50.0%",
        "  beta (/repo/src/beta.ts:1): CRAP 42.0 > threshold 8, cc 6, coverage 0.0%",
      ].join("\n"),
    );
  });

  it("returns an empty string for no breaches", () => {
    expect(formatBreachedRows([])).toBe("");
  });
});

describe("runSelfScoreGate: real CLI execution (end to end)", () => {
  const REPO_COVERAGE = path.join(REPO_ROOT, "coverage", "coverage-final.json");
  // The two report-dependent tests below need this repository's own V8
  // coverage output. Under `npm run coverage` vitest clears the coverage
  // directory before the run and only writes the file again at the end, so
  // the tests skip there (the same convention as the self-run tests in
  // test/self-score-direct.test.ts). Under `npm test` after a coverage
  // run — and whenever the gate is run for real (`npm run self-score`) —
  // they exercise the real CLI end to end. The freshness tests do not
  // depend on the repository coverage file and always run.
  const HAS_REPO_COVERAGE = fs.existsSync(REPO_COVERAGE);

  it.skipIf(!HAS_REPO_COVERAGE)(
    "passes end to end against the actual fresh repository coverage",
    () => {
      const outcome = runSelfScoreGate();
      expect(outcome.code).toBe(0);
      expect(outcome.error).toBeNull();
      expect(outcome.cliExitCode).toBe(0);
      expect(outcome.breaches).toEqual([]);
      expect(outcome.report).not.toBeNull();
      expect(outcome.report?.rows.length).toBeGreaterThanOrEqual(100);
      expect(outcome.report?.summary.threshold).toBe(8);
      expect(outcome.report?.summary.breached).toBe(false);
      expect(outcome.stdout).toContain("Self-score OK: own-source CRAP gate passed at threshold 8.");
      expect(outcome.stdout).toContain("breached rows: 0");
      expect(outcome.stdout).toContain("re-verified independently");
      expect(outcome.stdout).toContain("recomputed from the production formula");
      expect(outcome.stdout).toContain("exactly once");
      expect(outcome.stderr).toBe("");
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "fails closed when the coverage file is missing (freshness diagnostic)",
    () => {
      const outcome = runSelfScoreGate({
        args: [
          "npx",
          "tsx",
          path.join(REPO_ROOT, "src/cli.ts"),
          "src",
          "--coverage",
          path.join(REPO_ROOT, "coverage", "does-not-exist.json"),
          "--threshold",
          "8",
          "--json",
        ],
      });
      // The freshness check runs BEFORE the CLI: no subprocess is spawned.
      expect(outcome.code).toBe(1);
      expect(outcome.cliExitCode).toBeNull();
      expect(outcome.stderr).toContain("not found");
      expect(outcome.stderr).toContain("npm run coverage");
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "fails closed when the coverage is stale relative to src/",
    () => {
      // Point the CLI at a coverage file whose mtime is older than every
      // source file (24h back: older than any src mtime in this checkout),
      // so the freshness pre-check must fail before any run.
      const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-score-stale-"));
      try {
        const staleCoverage = path.join(staleDir, "coverage-final.json");
        fs.writeFileSync(staleCoverage, "{}");
        const past = new Date(Date.now() - 86_400_000).getTime();
        fs.utimesSync(staleCoverage, new Date(past), new Date(past));
        const outcome = runSelfScoreGate({
          args: [
            "npx",
            "tsx",
            path.join(REPO_ROOT, "src/cli.ts"),
            "src",
            "--coverage",
            staleCoverage,
            "--threshold",
            "8",
            "--json",
          ],
        });
        expect(outcome.code).toBe(1);
        expect(outcome.cliExitCode).toBeNull();
        expect(outcome.stderr).toContain("stale");
        expect(outcome.stderr).toContain("npm run coverage");
      } finally {
        fs.rmSync(staleDir, { recursive: true, force: true });
      }
    },
    E2E_TIMEOUT_MS,
  );

  it.skipIf(!HAS_REPO_COVERAGE)(
    "fails closed when an alternate real CLI coverage file omits a tracked source",
    () => {
      // The controlled-run API accepts --coverage, so validation must inspect
      // that exact file rather than silently falling back to the repository
      // default. Remove a low-complexity tracked source: the CLI can still
      // exit 0, but the gate must reject the incomplete coverage inventory.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-score-corrupt-"));
      try {
        const alternateCoverage = path.join(tempDir, "coverage-final.json");
        const coverage = JSON.parse(fs.readFileSync(REPO_COVERAGE, "utf8")) as Record<string, unknown>;
        const removedKey = Object.keys(coverage).find((key) =>
          key.endsWith("src/path-identity.ts"),
        );
        expect(removedKey).toBeDefined();
        delete coverage[removedKey!];
        fs.writeFileSync(alternateCoverage, JSON.stringify(coverage, null, 2));
        const now = new Date();
        fs.utimesSync(alternateCoverage, now, now);

        const outcome = runSelfScoreGate({
          args: [
            "npx", "tsx", path.join(REPO_ROOT, "src/cli.ts"), "src",
            "--coverage", alternateCoverage, "--threshold", "8", "--json",
          ],
        });
        expect(outcome.code).toBe(1);
        expect(outcome.error).toContain("self-score report validation failed");
        expect(outcome.error).toContain("src/path-identity.ts");
        expect(outcome.error).toContain("missing an entry");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    E2E_TIMEOUT_MS,
  );
});
