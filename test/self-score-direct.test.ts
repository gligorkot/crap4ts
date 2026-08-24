import * as path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverSourceFiles, analyzeFiles } from "../src/complexity.js";
import { readCoverage, mapAllCoverage } from "../src/coverage.js";
import { buildReport } from "../src/report.js";
import type { CrapReport } from "../src/report.js";
import {
  formatSelfScoreAudit,
  validateSelfScoreBreach,
  EXPECTED_BREACH_NAMES,
} from "../src/self-score-helpers.js";
import type { SelfScoreReport, SelfScoreRow } from "../src/self-score-helpers.js";

/**
 * Direct tests for the validation helpers extracted from the
 * threshold-8-breaching validateSelfScoreBreach (src/self-score-helpers.ts).
 *
 * The extraction split the original function body into private,
 * directly testable helpers:
 *
 * - breachingRows: the rows whose crap strictly exceeds the row's
 *   applicable threshold;
 * - findRowByName: row lookup by name or displayName;
 * - isExpectedBreachRow: name/displayName membership in the expected list;
 * - checkExpectedBreachRow: present expected row must breach its
 *   applicable row threshold and have coverage 0;
 * - validateExpectedBreachRows: every expected name is present and valid;
 * - validateNoUnexpectedBreaches: no breaching row outside the expected
 *   list;
 * - validateSelfScoreBreach: summary-threshold check, then the two
 *   phases above in order.
 *
 * These tests pin the exact error message strings (so wording changes
 * fail here), the strict breach semantics (crap > threshold, never
 * >=), the coverage-0 requirement, the name/displayName matching rules,
 * the check ordering (expected rows first, then unexpected breaches),
 * and the custom expected-names behaviour. A self-run section validates
 * the threshold-8 self-report through the real pipeline and pins the
 * no-breach state of this file.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * The self-run tests need this repository's V8 coverage output; skip (not
 * fail) in environments where it was not generated yet.
 */
const COVERAGE_FILE = path.join(REPO_ROOT, "coverage/coverage-final.json");
const HAS_COVERAGE = existsSync(COVERAGE_FILE);

const THRESHOLD = 30;

function makeRow(
  name: string,
  crap: number,
  coverage: number,
  matched = false,
  threshold = THRESHOLD,
  displayName?: string,
): SelfScoreRow {
  return {
    name,
    displayName: displayName ?? name,
    filePath: `/src/${name}.ts`,
    startLine: 1,
    endLine: 10,
    complexity: 5,
    coverage,
    crap,
    coverageMatched: matched,
    totalStatements: coverage > 0 ? 1 : 0,
    coveredStatements: coverage > 0 ? 1 : 0,
    threshold,
  };
}

function makeReport(
  rows: SelfScoreRow[],
  threshold: number,
): SelfScoreReport {
  let maxCrap = 0;
  let breachedCount = 0;
  for (const row of rows) {
    if (row.crap > maxCrap) {
      maxCrap = row.crap;
    }
    if (row.crap > row.threshold) {
      breachedCount++;
    }
  }
  return {
    rows,
    summary: {
      totalFunctions: rows.length,
      breachedCount,
      maxCrap,
      threshold,
      breached: breachedCount > 0,
    },
  };
}

function selfRunSelfScoreReport(): SelfScoreReport {
  const files = discoverSourceFiles([path.join(REPO_ROOT, "src")]);
  const coverage = readCoverage(COVERAGE_FILE);
  return buildReport(mapAllCoverage(analyzeFiles(files), coverage), 8);
}

describe("validateSelfScoreBreach: preserved behaviour", () => {
  it("passes when all expected rows exist, are uncovered, and breach threshold", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0), makeRow("main", 45, 0), makeRow("computeCrap", 5, 1)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBeNull();
  });

  it("passes with an empty expected list when nothing breaches", () => {
    const report = makeReport([makeRow("computeCrap", 5, 1)], THRESHOLD);
    expect(validateSelfScoreBreach(report, THRESHOLD, [])).toBeNull();
  });

  it("passes with an empty expected list when the only breach is a non-expected row's own low score", () => {
    const report = makeReport([makeRow("ok", 8, 0, false, 10)], THRESHOLD);
    // crap 8 is below its applicable row threshold 10: no breach at all.
    expect(validateSelfScoreBreach(report, THRESHOLD, [])).toBeNull();
  });

  it("fails on the exact summary-threshold mismatch message", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0), makeRow("main", 45, 0)],
      31,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      "Report summary threshold 31 does not match self-score threshold 30",
    );
  });

  it("fails with the exact not-found message for a missing expected row", () => {
    const report = makeReport([makeRow("main", 45, 0)], THRESHOLD);
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      'Expected breach function "parseArgs" not found in report rows',
    );
  });

  it("fails with the exact message when an expected row does not breach its applicable threshold", () => {
    const report = makeReport(
      [makeRow("parseArgs", 20, 0), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      `Expected "parseArgs" to breach threshold ${THRESHOLD} (applicable row threshold) but crap=20`,
    );
  });

  it("fails with the exact message when an expected row is covered", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0.5, true), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      'Expected "parseArgs" to be uncovered (coverage 0) but coverage=0.5',
    );
  });

  it("fails with the exact unexpected-breach message including the expected list", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0), makeRow("main", 45, 0), makeRow("mysteryFn", 40, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      'Unexpected threshold breach: "mysteryFn" (crap=40) is not in expected breach list [parseArgs, main]',
    );
  });

  it("joins custom expected names with a comma and space in the message", () => {
    const report = makeReport(
      [
        makeRow("alpha", 50, 0),
        makeRow("beta", 40, 0),
        makeRow("other", 35, 0),
      ],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD, ["alpha", "beta"])).toBe(
      'Unexpected threshold breach: "other" (crap=35) is not in expected breach list [alpha, beta]',
    );
  });
});

describe("validateSelfScoreBreach: row matching", () => {
  it("matches an expected row by displayName when the row name differs", () => {
    const report = makeReport(
      [
        makeRow("parseArgs_impl", 50, 0, false, THRESHOLD, "parseArgs"),
        makeRow("main", 45, 0),
      ],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBeNull();
  });

  it("treats a displayName-matched expected row as expected in the unexpected-breach phase", () => {
    // name is not in the expected list, but displayName is: the breach
    // must NOT be reported as unexpected.
    const report = makeReport(
      [
        makeRow("parseArgs_impl", 50, 0, false, THRESHOLD, "parseArgs"),
        makeRow("main", 45, 0),
      ],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBeNull();
    const onlyUnexpected = makeReport(
      [
        makeRow("parseArgs_impl", 50, 0, false, THRESHOLD, "parseArgs"),
        makeRow("main", 45, 0),
        makeRow("mysteryFn", 42, 0),
      ],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(onlyUnexpected, THRESHOLD)).toBe(
      'Unexpected threshold breach: "mysteryFn" (crap=42) is not in expected breach list [parseArgs, main]',
    );
  });

  it("uses the custom expected list instead of the default parseArgs/main", () => {
    const report = makeReport([makeRow("customFn", 50, 0)], THRESHOLD);
    expect(validateSelfScoreBreach(report, THRESHOLD, ["customFn"])).toBeNull();
  });

  it("flags a default-named breach as unexpected under a custom list", () => {
    const report = makeReport(
      [makeRow("customFn", 50, 0), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD, ["customFn"])).toBe(
      'Unexpected threshold breach: "main" (crap=45) is not in expected breach list [customFn]',
    );
  });
});

describe("validateSelfScoreBreach: strict breach and coverage semantics", () => {
  it("rejects an expected row whose crap equals its applicable threshold (strict >)", () => {
    const report = makeReport(
      [makeRow("parseArgs", 30, 0, false, 30), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      "Expected \"parseArgs\" to breach threshold 30 (applicable row threshold) but crap=30",
    );
  });

  it("does not count a row at exactly its threshold as a breach", () => {
    const report = makeReport([makeRow("edge", 30, 0, false, 30)], THRESHOLD);
    expect(validateSelfScoreBreach(report, THRESHOLD, [])).toBeNull();
  });

  it("detects breaches against each row's applicable threshold, not the summary threshold", () => {
    const report = makeReport(
      [makeRow("lowThreshold", 9, 0, false, 8)],
      THRESHOLD,
    );
    // summary threshold is 30 but the row's applicable threshold is 8.
    expect(validateSelfScoreBreach(report, THRESHOLD, [])).toBe(
      'Unexpected threshold breach: "lowThreshold" (crap=9) is not in expected breach list []',
    );
  });

  it("accepts an expected row with coverage exactly 0", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBeNull();
  });

  it("rejects an expected row with any positive coverage, even fractional", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0.001, true), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      "Expected \"parseArgs\" to be uncovered (coverage 0) but coverage=0.001",
    );
  });

  it("rejects a fully covered expected row", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 1, true), makeRow("main", 45, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      "Expected \"parseArgs\" to be uncovered (coverage 0) but coverage=1",
    );
  });
});

describe("validateSelfScoreBreach: check ordering and precedence", () => {
  it("reports the expected-row failure before an unexpected breach", () => {
    const report = makeReport(
      [
        makeRow("parseArgs", 20, 0),
        makeRow("main", 45, 0),
        makeRow("mysteryFn", 40, 0),
      ],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      `Expected "parseArgs" to breach threshold ${THRESHOLD} (applicable row threshold) but crap=20`,
    );
  });

  it("reports a missing expected row before an unexpected breach", () => {
    const report = makeReport(
      [makeRow("main", 45, 0), makeRow("mysteryFn", 40, 0)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      'Expected breach function "parseArgs" not found in report rows',
    );
  });

  it("reports the first failing expected row in list order", () => {
    const report = makeReport(
      [makeRow("parseArgs", 50, 0), makeRow("main", 45, 0.5, true)],
      THRESHOLD,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      'Expected "main" to be uncovered (coverage 0) but coverage=0.5',
    );
  });

  it("reports the summary-threshold mismatch before any row checks", () => {
    const report = makeReport(
      [makeRow("mysteryFn", 40, 0)],
      31,
    );
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBe(
      "Report summary threshold 31 does not match self-score threshold 30",
    );
  });
});

describe("formatSelfScoreAudit (refactored row lookup)", () => {
  it("prints the maximum score and only the expected breached rows with audit fields", () => {
    const report = makeReport(
      [
        makeRow("parseArgs", 50, 0),
        makeRow("main", 45, 0),
        makeRow("computeCrap", 5, 1),
      ],
      THRESHOLD,
    );

    expect(formatSelfScoreAudit(report)).toBe(
      [
        "Self-score audit evidence:",
        "Maximum CRAP score: 50.0.",
        "Expected breached rows:",
        "- parseArgs: CRAP 50.0, coverage 0.0%, threshold 30.0",
        "- main: CRAP 45.0, coverage 0.0%, threshold 30.0",
      ].join("\n"),
    );
  });

  it("finds rows by displayName when the row name differs", () => {
    const report = makeReport(
      [
        makeRow("parseArgs_impl", 50, 0, false, THRESHOLD, "parseArgs"),
        makeRow("main", 45, 0),
      ],
      THRESHOLD,
    );
    expect(formatSelfScoreAudit(report)).toBe(
      [
        "Self-score audit evidence:",
        "Maximum CRAP score: 50.0.",
        "Expected breached rows:",
        "- parseArgs: CRAP 50.0, coverage 0.0%, threshold 30.0",
        "- main: CRAP 45.0, coverage 0.0%, threshold 30.0",
      ].join("\n"),
    );
  });

  it("uses the custom expected names in order", () => {
    const report = makeReport(
      [
        makeRow("second", 44.4, 0, false, 8),
        makeRow("first", 50, 0, false, 8),
      ],
      8,
    );
    expect(formatSelfScoreAudit(report, ["first", "second"])).toBe(
      [
        "Self-score audit evidence:",
        "Maximum CRAP score: 50.0.",
        "Expected breached rows:",
        "- first: CRAP 50.0, coverage 0.0%, threshold 8.0",
        "- second: CRAP 44.4, coverage 0.0%, threshold 8.0",
      ].join("\n"),
    );
  });

  it("throws the exact message when an expected row is missing", () => {
    const report = makeReport([makeRow("main", 45, 0)], THRESHOLD);
    expect(() => formatSelfScoreAudit(report)).toThrow(
      'Expected breach function "parseArgs" not found in report rows',
    );
  });
});

describe("EXPECTED_BREACH_NAMES", () => {
  it("contains parseArgs and main", () => {
    expect(EXPECTED_BREACH_NAMES).toContain("parseArgs");
    expect(EXPECTED_BREACH_NAMES).toContain("main");
  });
});

describe("self-run over this repository's own source at threshold 8", () => {
  it.skipIf(!HAS_COVERAGE)("has no threshold-8 breaches in any src file (this slice's target state)", () => {
    const report = selfRunSelfScoreReport();
    const breaches = report.rows.filter((row) => row.crap > row.threshold);
    expect(breaches).toEqual([]);
    // With no expected names, a fully-explained (breach-free) report is
    // valid; this pins that the whole-repo threshold-8 report passes.
    expect(validateSelfScoreBreach(report, 8, [])).toBeNull();
  });

  it.skipIf(!HAS_COVERAGE)("keeps every self-score-helpers row at or below threshold 8", () => {
    const report = selfRunSelfScoreReport();
    const helperRows = report.rows.filter((row) =>
      row.filePath.endsWith("src/self-score-helpers.ts"),
    );
    expect(helperRows.length).toBeGreaterThan(0);
    for (const row of helperRows) {
      expect(row.crap).toBeLessThanOrEqual(row.threshold);
    }
  });

  it.skipIf(!HAS_COVERAGE)("documents the honest current integration state for scripts/self-score.ts", () => {
    // scripts/self-score.ts is now a genuine own-source gate at threshold
    // 8: it runs the real source CLI against fresh coverage, proves the
    // report is a structurally valid, summary-consistent, own-source result
    // of the current tree, and exits 0 only when zero rows breach the
    // threshold (gate logic pinned in test/self-score-gate.test.ts). The
    // legacy premise — "the CLI must exit 2 with parseArgs/main breaching
    // threshold 30" — is retired: parseArgs no longer exists in src/cli.ts
    // (its logic lives in parseArgsOrExit in cli-helpers.ts), and no source
    // function breaches threshold 8, so the gate expects no breaches at
    // all. The helpers' default expected-name validation (used only with an
    // explicit expected list) still reports the missing row, not a
    // spurious pass.
    const report = selfRunSelfScoreReport();
    const names = new Set<string>();
    for (const row of report.rows) {
      names.add(row.name);
      names.add(row.displayName);
    }
    expect(names.has("parseArgs")).toBe(false);
    // The whole-repo threshold-8 report is currently clean: the gate's
    // pass state is the zero-breach state.
    expect(report.rows.filter((row) => row.crap > row.threshold)).toEqual([]);
    const err = validateSelfScoreBreach(report, 8);
    expect(err).toBe(
      'Expected breach function "parseArgs" not found in report rows',
    );
  });
});

describe("type-level: SelfScoreReport is structurally compatible with the CLI report", () => {
  it("accepts a CrapReport-shaped object as SelfScoreReport", () => {
    const cliReport: CrapReport = {
      rows: [
        {
          name: "fn",
          displayName: "fn",
          filePath: "/src/fn.ts",
          startLine: 1,
          endLine: 2,
          complexity: 1,
          coverage: 1,
          crap: 1,
          coverageMatched: true,
          totalStatements: 1,
          coveredStatements: 1,
          threshold: 8,
        },
      ],
      summary: {
        totalFunctions: 1,
        breachedCount: 0,
        maxCrap: 1,
        threshold: 8,
        breached: false,
      },
    };
    expect(validateSelfScoreBreach(cliReport, 8, [])).toBeNull();
  });
});
