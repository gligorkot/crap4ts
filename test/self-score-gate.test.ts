/**
 * Focused unit tests for the own-source self-score gate logic exported from
 * scripts/self-score.ts:
 *
 * - parseSelfScoreReport: JSON parse + structural validation of CLI stdout;
 * - breachingRowsOf: strict crap > applicable-threshold recomputation;
 * - validateSelfScoreReport: own-source, fresh, summary-consistent report
 *   validation (fail closed on stale/foreign/partial/contradictory reports);
 * - assertCoverageFreshness: missing and stale coverage detection;
 * - formatSelfScorePassAudit / formatBreachedRows: exact output strings.
 *
 * These pin the fail-closed semantics of the threshold-8 integration gate:
 * a code-0 report is only accepted after it is proven to be a meaningful
 * own-source result of the current tree.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCoverageFreshness,
  breachingRowsOf,
  formatBreachedRows,
  formatSelfScorePassAudit,
  parseSelfScoreReport,
  validateSelfScoreReport,
} from "../scripts/self-score.js";
import type {
  SelfScoreGateContext,
} from "../scripts/self-score.js";
import type {
  SelfScoreReport,
  SelfScoreRow,
} from "../src/self-score-helpers.js";

/** Repository root (parent of the test/ directory). */
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * One structurally valid report row. The values are chosen so that a clean
 * two-row report (one at threshold, one under it) validates against the
 * default context below.
 */
function makeRow(overrides: Partial<SelfScoreRow> = {}): SelfScoreRow {
  return {
    name: "alpha",
    displayName: "alpha",
    filePath: "src/alpha.ts",
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

/** A report whose summary is consistent with its own rows. */
function makeReport(
  rows: SelfScoreRow[],
  overrides: {
    threshold?: number;
    totalFunctions?: number;
    breachedCount?: number;
    maxCrap?: number;
    breached?: boolean;
  } = {},
): SelfScoreReport {
  const maxCrap = rows.reduce((max, row) => Math.max(max, row.crap), 0);
  const breachedCount = rows.filter((row) => row.crap > row.threshold).length;
  return {
    rows,
    summary: {
      totalFunctions: rows.length,
      breachedCount,
      maxCrap,
      threshold: 8,
      breached: breachedCount > 0,
      ...overrides,
    },
  };
}

/**
 * The default gate context: threshold 8, two tracked src files, and the same
 * degenerate-report floors the script itself uses. Paths are resolved the
 * same way the script normalizes them (absolute; canonical where possible).
 */
function makeContext(
  overrides: Partial<SelfScoreGateContext> = {},
): SelfScoreGateContext {
  const tracked = ["src/alpha.ts", "src/beta.ts"].map((p) =>
    path.resolve(REPO_ROOT, p),
  );
  return {
    threshold: 8,
    expectedSourceFiles: new Set(tracked),
    expectedCoverageSourceFiles: new Set(tracked),
    minTotalFunctions: 1,
    minMatchedFunctions: 1,
    ...overrides,
  };
}

/**
 * The two rows of a clean own-source report: both files tracked by the
 * default context, both under their applicable threshold, both
 * coverage-matched, and summary-consistent.
 */
function cleanRows(): SelfScoreRow[] {
  return [
    makeRow(),
    makeRow({
      name: "beta",
      displayName: "beta",
      filePath: "src/beta.ts",
      complexity: 4,
      coverage: 1,
      crap: 6,
      totalStatements: 8,
      coveredStatements: 8,
    }),
  ];
}

/** A clean own-source report that must pass the default context. */
function cleanReport(): SelfScoreReport {
  return makeReport(cleanRows());
}

describe("parseSelfScoreReport", () => {
  it("parses a valid report object", () => {
    const raw = JSON.stringify(cleanReport());
    const parsed = parseSelfScoreReport(raw);
    expect(parsed.error).toBeNull();
    expect(parsed.report?.rows).toHaveLength(2);
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
    (report.rows[1] as { crap: unknown }).crap = NaN;
    const parsed = parseSelfScoreReport(JSON.stringify(report));
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe("rows[1].crap is not a finite number");
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

describe("breachingRowsOf", () => {
  it("returns rows whose crap strictly exceeds their applicable threshold", () => {
    const report = makeReport([
      makeRow({ crap: 9 }),
      makeRow({ name: "edge", displayName: "edge", crap: 8 }),
      makeRow({
        name: "high",
        displayName: "high",
        complexity: 7,
        coverage: 0,
        crap: 56,
        totalStatements: 0,
        coveredStatements: 0,
      }),
    ]);
    const breaches = breachingRowsOf(report);
    expect(breaches.map((row) => row.name)).toEqual(["alpha", "high"]);
  });

  it("does not count a row at exactly its threshold as a breach", () => {
    const report = makeReport([makeRow({ crap: 8 })]);
    expect(breachingRowsOf(report)).toEqual([]);
  });

  it("evaluates each row against its own threshold, not a shared one", () => {
    const report = makeReport([
      makeRow({ threshold: 4, crap: 5 }),
      makeRow({
        name: "beta",
        displayName: "beta",
        filePath: "src/beta.ts",
        threshold: 30,
        crap: 20,
      }),
    ]);
    const breaches = breachingRowsOf(report);
    expect(breaches.map((row) => row.name)).toEqual(["alpha"]);
  });
});

describe("validateSelfScoreReport", () => {
  it("passes a clean own-source report", () => {
    expect(validateSelfScoreReport(cleanReport(), makeContext())).toBeNull();
  });

  it("fails when the summary threshold does not match the gate threshold", () => {
    const report = makeReport(cleanReport().rows, { threshold: 30 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("summary threshold 30");
    expect(err).toContain("does not match the gate threshold 8");
  });

  it("fails when totalFunctions does not match the actual row count", () => {
    const report = makeReport(cleanReport().rows, { totalFunctions: 99 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("totalFunctions 99");
    expect(err).toContain("actual row count 2");
  });

  it("fails when maxCrap does not match the recomputed maximum", () => {
    const report = makeReport(cleanReport().rows, { maxCrap: 1 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("maxCrap 1");
    expect(err).toContain("recomputed maximum row CRAP 6");
  });

  it("fails when breachedCount does not match the recomputed breach count", () => {
    const report = makeReport(cleanReport().rows, { breachedCount: 3 });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("breachedCount 3");
    expect(err).toContain("recomputed");
  });

  it("fails when the breached flag contradicts the recomputed breach state", () => {
    const report = makeReport(cleanReport().rows, { breached: true });
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("summary breached=true");
    expect(err).toContain("0 breached row(s)");
  });

  it("fails when a row's file is not part of the current src tree", () => {
    const report = makeReport([
      makeRow({ filePath: "src/legacy.ts" }),
      makeRow({ name: "beta", displayName: "beta", filePath: "src/beta.ts" }),
    ]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("not part");
    expect(err).toContain("src/legacy.ts");
  });

  it("fails when a coverage-tracked src file has no rows in the report", () => {
    const report = makeReport([makeRow()]);
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("src/beta.ts");
    expect(err).toContain("no rows");
  });

  it("fails when the report is below the minimum function count", () => {
    const context = makeContext({ minTotalFunctions: 3 });
    const err = validateSelfScoreReport(cleanReport(), context);
    expect(err).toContain("only 2 functions");
    expect(err).toContain("< 3");
  });

  it("fails when too few functions are coverage-matched", () => {
    const report = makeReport([
      makeRow({ coverageMatched: false, coverage: 0, totalStatements: 0, coveredStatements: 0 }),
      makeRow({
        name: "beta",
        displayName: "beta",
        filePath: "src/beta.ts",
        coverageMatched: false,
        coverage: 0,
        totalStatements: 0,
        coveredStatements: 0,
      }),
    ]);
    const context = makeContext({ minMatchedFunctions: 1 });
    const err = validateSelfScoreReport(report, context);
    expect(err).toContain("only 0 coverage-matched functions");
  });

  it("reports the threshold mismatch before row-level checks", () => {
    const report = makeReport(
      [makeRow({ filePath: "src/legacy.ts" })],
      { threshold: 30 },
    );
    const err = validateSelfScoreReport(report, makeContext());
    expect(err).toContain("summary threshold 30");
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
    const missing = path.join(tmpDir ?? os.tmpdir(), "nope", "coverage-final.json");
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
    const [first] = sources;
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
    const [first] = sources;
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
        filePath: "src/beta.ts",
        coverage: 0.5,
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
      makeRow({ complexity: 3, coverage: 0.5, crap: 12.5 }),
      makeRow({
        name: "beta",
        displayName: "beta",
        filePath: "src/beta.ts",
        complexity: 6,
        coverage: 0,
        crap: 42,
        threshold: 8,
      }),
    ];
    expect(formatBreachedRows(breaches)).toBe(
      [
        "  alpha (src/alpha.ts:1): CRAP 12.5 > threshold 8, cc 3, coverage 50.0%",
        "  beta (src/beta.ts:1): CRAP 42.0 > threshold 8, cc 6, coverage 0.0%",
      ].join("\n"),
    );
  });

  it("returns an empty string for no breaches", () => {
    expect(formatBreachedRows([])).toBe("");
  });
});
