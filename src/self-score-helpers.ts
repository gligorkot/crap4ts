/**
 * Pure helpers for self-score validation.
 *
 * Extracted from scripts/self-score.ts so the assertion logic has unit test
 * coverage (the script itself auto-executes on import and is not directly
 * testable).
 *
 * @packageDocumentation
 */

/** A single row in the CRAP report JSON output. */
export interface SelfScoreRow {
  readonly name: string;
  readonly displayName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly complexity: number;
  readonly coverage: number;
  readonly crap: number;
  readonly coverageMatched: boolean;
  readonly totalStatements: number;
  readonly coveredStatements: number;
  readonly threshold: number;
}

/** The full CRAP report JSON structure. */
export interface SelfScoreReport {
  readonly rows: SelfScoreRow[];
  readonly summary: {
    readonly totalFunctions: number;
    readonly breachedCount: number;
    readonly maxCrap: number;
    readonly threshold: number;
    readonly breached: boolean;
  };
}

/**
 * The functions expected to breach the threshold in self-score.
 * These are cli.ts functions (parseArgs, main) that have high complexity
 * and no direct test coverage (exercised via subprocess, which V8 does
 * not attribute to the source file).
 */
export const EXPECTED_BREACH_NAMES = ["parseArgs", "main"] as const;

/**
 * Format the validated self-score breach as concise CI audit evidence.
 *
 * The caller must validate the report with validateSelfScoreBreach before
 * formatting it; missing expected rows are treated as a programming error.
 */
export function formatSelfScoreAudit(
  report: SelfScoreReport,
  expectedNames: readonly string[] = EXPECTED_BREACH_NAMES,
): string {
  const rows = expectedNames.map((name) => {
    const row = report.rows.find(
      (candidate) => candidate.name === name || candidate.displayName === name,
    );
    if (row === undefined) {
      throw new Error(`Expected breach function "${name}" not found in report rows`);
    }
    return `- ${name}: CRAP ${row.crap.toFixed(1)}, coverage ${(row.coverage * 100).toFixed(1)}%, threshold ${row.threshold.toFixed(1)}`;
  });

  return [
    "Self-score audit evidence:",
    `Maximum CRAP score: ${report.summary.maxCrap.toFixed(1)}.`,
    "Expected breached rows:",
    ...rows,
  ].join("\n");
}

/**
 * Validate that the self-score breach is caused by exactly the expected
 * functions, and that those functions are unmatched/uncovered and exceed
 * the threshold.
 *
 * This is a pure function exported for unit testing.
 *
 * @returns an error message string if validation fails, or null if valid.
 */
export function validateSelfScoreBreach(
  report: SelfScoreReport,
  threshold: number,
  expectedNames: readonly string[] = EXPECTED_BREACH_NAMES,
): string | null {
  if (report.summary.threshold !== threshold) {
    return `Report summary threshold ${report.summary.threshold} does not match self-score threshold ${threshold}`;
  }

  const breaches = report.rows.filter((row) => row.crap > row.threshold);

  // Every expected function must be present and breaching its applicable threshold.
  for (const name of expectedNames) {
    const row = report.rows.find(
      (r) => r.name === name || r.displayName === name,
    );
    if (row === undefined) {
      return `Expected breach function "${name}" not found in report rows`;
    }
    if (row.crap <= row.threshold) {
      return `Expected "${name}" to breach threshold ${row.threshold} (applicable row threshold) but crap=${row.crap}`;
    }
    // Must be unmatched or uncovered (coverage 0).
    if (row.coverage > 0) {
      return `Expected "${name}" to be uncovered (coverage 0) but coverage=${row.coverage}`;
    }
  }

  // Every breaching row must be one of the expected functions.
  for (const breach of breaches) {
    const isExpected =
      expectedNames.includes(breach.name) ||
      expectedNames.includes(breach.displayName);
    if (!isExpected) {
      return `Unexpected threshold breach: "${breach.displayName}" (crap=${breach.crap}) is not in expected breach list [${expectedNames.join(", ")}]`;
    }
  }

  return null;
}
