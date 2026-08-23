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
  const breaches = report.rows.filter((r) => r.crap > threshold);

  // Every expected function must be present and breaching.
  for (const name of expectedNames) {
    const row = report.rows.find(
      (r) => r.name === name || r.displayName === name,
    );
    if (row === undefined) {
      return `Expected breach function "${name}" not found in report rows`;
    }
    if (row.crap <= threshold) {
      return `Expected "${name}" to breach threshold ${threshold} but crap=${row.crap}`;
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
