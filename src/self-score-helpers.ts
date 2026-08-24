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
    const row = findRowByName(report, name);
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
 * The row set of a report whose CRAP score strictly exceeds the row's
 * applicable threshold.
 */
function breachingRows(report: SelfScoreReport): SelfScoreRow[] {
  return report.rows.filter((row) => row.crap > row.threshold);
}

/**
 * Find the row for a given function by its `name` or `displayName`.
 * Returns undefined when no row matches either field.
 */
function findRowByName(
  report: SelfScoreReport,
  name: string,
): SelfScoreRow | undefined {
  return report.rows.find(
    (r) => r.name === name || r.displayName === name,
  );
}

/**
 * Whether a row is one of the expected breach functions, matched by its
 * `name` or its `displayName`.
 */
function isExpectedBreachRow(
  row: SelfScoreRow,
  expectedNames: readonly string[],
): boolean {
  return (
    expectedNames.includes(row.name) ||
    expectedNames.includes(row.displayName)
  );
}

/**
 * Check one expected breach row against its applicable row threshold and
 * coverage. Returns an error message string when the row is present but
 * not a valid expected breach (not breaching, or covered), or null when it
 * is a valid expected breach.
 */
function checkExpectedBreachRow(
  row: SelfScoreRow,
  name: string,
): string | null {
  if (row.crap <= row.threshold) {
    return `Expected "${name}" to breach threshold ${row.threshold} (applicable row threshold) but crap=${row.crap}`;
  }
  // Must be unmatched or uncovered (coverage 0).
  if (row.coverage > 0) {
    return `Expected "${name}" to be uncovered (coverage 0) but coverage=${row.coverage}`;
  }
  return null;
}

/**
 * Validate that every expected breach function is present in the report
 * and that each is an unmatched/uncovered row breaching its applicable row
 * threshold. Returns the first error message found, or null when every
 * expected function is a valid breach.
 */
function validateExpectedBreachRows(
  report: SelfScoreReport,
  expectedNames: readonly string[],
): string | null {
  for (const name of expectedNames) {
    const row = findRowByName(report, name);
    if (row === undefined) {
      return `Expected breach function "${name}" not found in report rows`;
    }
    const rowError = checkExpectedBreachRow(row, name);
    if (rowError !== null) {
      return rowError;
    }
  }
  return null;
}

/**
 * Validate that every breaching row in the report is one of the expected
 * breach functions. Returns the first unexpected breach as an error
 * message, or null when no unexpected breaches exist.
 */
function validateNoUnexpectedBreaches(
  report: SelfScoreReport,
  expectedNames: readonly string[],
): string | null {
  for (const breach of breachingRows(report)) {
    if (!isExpectedBreachRow(breach, expectedNames)) {
      return `Unexpected threshold breach: "${breach.displayName}" (crap=${breach.crap}) is not in expected breach list [${expectedNames.join(", ")}]`;
    }
  }
  return null;
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

  const expectedError = validateExpectedBreachRows(report, expectedNames);
  if (expectedError !== null) {
    return expectedError;
  }

  return validateNoUnexpectedBreaches(report, expectedNames);
}
