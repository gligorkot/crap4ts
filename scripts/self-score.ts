/**
 * Self-score: run crap4ts's real source CLI against this repository's own
 * fresh coverage and enforce the repository's own CRAP gate at threshold 8.
 *
 * The honest premise (threshold-8 remediation, self-score integration):
 * this codebase currently scores CLEAN at threshold 8. The gate therefore
 * does NOT expect any named breach. The legacy premise — "the CLI must exit
 * 2 with parseArgs/main breaching threshold 30" — is retired: parseArgs no
 * longer exists in src/cli.ts (its logic lives in cli-helpers.ts) and no
 * source function exceeds threshold 8. Accepting a bare exit-0 report
 * without verifying it would be dishonest, so the gate instead proves the
 * report is a meaningful own-source result and fails closed on anything it
 * cannot prove:
 *
 * 1. Fail closed BEFORE running the CLI when coverage/coverage-final.json
 *    is missing or stale (any src/ file newer than the coverage file).
 * 2. Run the real source CLI (`tsx src/cli.ts`) against the fresh coverage
 *    at threshold 8 with JSON output.
 * 3. Interpret the exit code fail closed: 0 or 2 are the only
 *    interpretable codes; 1 means invalid input (missing/malformed
 *    coverage or bad arguments) and any other code is unexpected.
 * 4. Parse stdout as the JSON report and validate it structurally, field
 *    by field (finite numbers, integer lines/complexity/counts,
 *    0 <= coveredStatements <= totalStatements, coverage in [0, 1]);
 *    malformed output fails.
 *
 * 5. ROW-LEVEL GATE INTEGRITY — the report's row fields are never trusted:
 *    - every row's threshold must be EXACTLY 8: the invocation uses
 *      `--threshold 8` with no path config, so no other row threshold is
 *      legitimate and a raised/lowered row threshold is rejected;
 *    - coherent numeric/integer/range/count relationships (integer lines
 *      with startLine <= endLine, integer complexity >= 1,
 *      0 <= coveredStatements <= totalStatements, coverage in [0, 1]);
 *    - correct coverage semantics: coverage must equal covered/total when
 *      total > 0 and exactly 0 otherwise (including the zero-statement
 *      case); an unmatched row carries coverage 0 and zero statements;
 *    - coherent coverageMatched status (an unmatched row may never claim
 *      positive coverage or statements);
 *    - CRAP is recomputed INDEPENDENTLY from the row's complexity and
 *      coverage using the production formula (computeCrap in
 *      src/crap.ts); any deviation is a forged score and is rejected;
 *    - the breached row set is recomputed from the verified rows
 *      (crap > row threshold, i.e. crap > 8), never read from the summary.
 *
 * 6. REPORT COMPLETENESS — the report is proven to be a FULL result for
 *    the CURRENT tree, not merely bounded by count floors:
 *    - the expected function inventory is built INDEPENDENTLY from the
 *      actual current source tree via the production discovery/analysis
 *      API (discoverSourceFiles + analyzeSource), with canonical file
 *      identity plus source range, name, display name, and complexity;
 *    - exact one-to-one representation is required: a missing current
 *      function, a duplicated row, or an unexpected/stale row (a row that
 *      matches no current function's file+range+name+complexity) is
 *      rejected;
 *    - source files with zero functions are handled explicitly: they are
 *      represented by exactly zero rows, and any row for such a file is
 *      rejected with a dedicated diagnostic;
 *    - the coverage file's entries are compared against the EXPECTED
 *      coverage-tracked source files (the current src files minus the
 *      files the vitest coverage run excludes, read from vitest.config.ts),
 *      not merely against entries already present in the report: a
 *      missing entry (corrupted/partial coverage) or a stale entry
 *      (coverage from a different tree) is rejected;
 *    - the count floors (>= MIN_TOTAL_FUNCTIONS functions, >=
 *      MIN_MATCHED_FUNCTIONS coverage-matched) remain only as SECONDARY
 *      sanity checks.
 *
 * 7. Re-check the report summary INDEPENDENTLY against the rows
 *    (summary threshold equals 8, totalFunctions, maxCrap, breachedCount,
 *    breached flag) — the summary is never trusted blindly.
 * 8. Exit 0 only when the recomputed breached row set is empty.
 *
 * The pure parts (parsing, validation, completeness proof, formatting,
 * freshness) are exported so test/self-score-gate.test.ts can unit-test
 * them without spawning a subprocess. `runSelfScoreGate` runs the entire
 * gate (freshness check, real CLI execution, validation, breach
 * recomputation) and returns a structured outcome instead of exiting, so
 * the direct-CLI behaviour is testable end to end. The script auto-runs
 * only when executed directly (not when imported).
 *
 * Run via: npm run coverage && npm run self-score
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource, discoverSourceFiles } from "../src/complexity.js";
import { readCoverage } from "../src/coverage.js";
import { computeCrap } from "../src/crap.js";
import type { SelfScoreReport, SelfScoreRow } from "../src/self-score-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_SOURCE = path.join(REPO_ROOT, "src/cli.ts");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const COVERAGE_FILE = path.join(REPO_ROOT, "coverage/coverage-final.json");

/** The gate threshold. This is the repository's own default; the gate must
 * never raise it, and the CLI is invoked with exactly this value. */
const THRESHOLD = 8;

/**
 * Degenerate-report guard (secondary sanity check only): a real run of
 * this repository analyzes well over 150 functions. A report with fewer
 * functions cannot be a full own-source result. Completeness is proven
 * primarily by the exact one-to-one inventory match, not by this floor.
 */
const MIN_TOTAL_FUNCTIONS = 100;

/**
 * Degenerate-report guard (secondary sanity check only): a real run
 * matches coverage for nearly every function (only the coverage-excluded
 * entry points are unmatched). If the coverage file does not match the
 * source tree, almost nothing matches and the gate fails closed instead
 * of scoring unmatched (coverage-0) functions.
 */
const MIN_MATCHED_FUNCTIONS = 80;

/**
 * Filesystem mtime granularity tolerance when judging coverage staleness:
 * a source file must be more than this much newer than the coverage file
 * for the coverage to count as stale.
 */
const STALE_TOLERANCE_MS = 1000;

/** Wall-clock budget for the CLI subprocess. */
const CLI_TIMEOUT_MS = 60000;

/**
 * Tolerance when comparing a row's reported CRAP against the
 * independently recomputed production-formula score. The production CLI
 * computes CRAP with the exact same arithmetic, so a genuine report
 * matches to the last bit; any deviation beyond this is a forged score.
 */
const CRAP_RECOMPUTE_TOLERANCE = 1e-9;

/** Tolerance when comparing a row's coverage decimal against covered/total. */
const COVERAGE_FRACTION_TOLERANCE = 1e-12;

/** The final success line printed after a passing gate. */
const SUCCESS_LINE =
  "Coverage verified present and fresh; report verified as an own-source result " +
  "of the real CLI at threshold 8: row integrity re-verified independently " +
  "(row thresholds, counts, coverage semantics, and CRAP recomputed from the " +
  "production formula), the coverage file's entries proven to match the " +
  "current tree's expected tracked files exactly, and the full current " +
  "function inventory represented exactly once (breaches recomputed from the " +
  "verified rows, not trusted from the summary).";

/** Result of parsing raw CLI stdout as a JSON CRAP report. */
export interface SelfScoreParseResult {
  readonly report: SelfScoreReport | null;
  readonly error: string | null;
}

/**
 * One function of the CURRENT source tree, as independently computed by the
 * production discovery/analysis API. The key is the row-matching identity:
 * canonical file + line range + name + display name + complexity. (The
 * column range is part of the inventory for completeness but is not
 * carried by report rows, so it is not part of the key.)
 */
export interface ExpectedFunction {
  /** Row-matching identity key (see module docs). */
  readonly key: string;
  /** Absolute, normalized file path. */
  readonly filePath: string;
  readonly name: string;
  readonly displayName: string;
  /** 1-based start line. */
  readonly startLine: number;
  /** 1-based end line. */
  readonly endLine: number;
  /** 0-based start column (inventory completeness). */
  readonly startColumn: number;
  /** 0-based end column, exclusive (inventory completeness). */
  readonly endColumn: number;
  /** Cyclomatic complexity. */
  readonly complexity: number;
}

/** Everything the gate knows about the current repository, for validation. */
export interface SelfScoreGateContext {
  readonly threshold: number;
  /** Normalized absolute paths of every current src/ source file. */
  readonly expectedSourceFiles: ReadonlySet<string>;
  /**
   * Normalized absolute paths of the src/ files the current coverage run is
   * EXPECTED to track: the current src files minus the files the vitest
   * coverage run excludes (read from vitest.config.ts).
   */
  readonly expectedCoverageTrackedFiles: ReadonlySet<string>;
  /** Normalized absolute paths of src/ files tracked by the coverage file. */
  readonly expectedCoverageSourceFiles: ReadonlySet<string>;
  /**
   * The independent inventory of every function in the CURRENT source tree
   * (production discovery/analysis API). Every one of these must be
   * represented by exactly one report row, and no other rows may exist.
   */
  readonly expectedFunctions: readonly ExpectedFunction[];
  readonly minTotalFunctions: number;
  readonly minMatchedFunctions: number;
}

/** Options for {@link runSelfScoreGate} (all optional; defaults are the real gate). */
export interface SelfScoreGateOptions {
  /**
   * Full CLI argument list override (defaults to the real repository
   * invocation: tsx src/cli.ts src --coverage <repo coverage> --threshold 8
   * --json). Used by tests to point the real CLI at a controlled coverage
   * file.
   */
  readonly args?: readonly string[];
  /** Repository working directory (defaults to this script's repo root). */
  readonly cwd?: string;
  /** Wall-clock budget for the CLI subprocess (defaults to 60s). */
  readonly timeoutMs?: number;
}

/** Structured outcome of one full gate run (no process.exit). */
export interface SelfScoreGateOutcome {
  /** 0 when the gate passed, 1 when it failed closed. */
  readonly code: 0 | 1;
  /** Text the gate would print to stdout (the success audit block). */
  readonly stdout: string;
  /** Text the gate would print to stderr (the `Error: ...` line). */
  readonly stderr: string;
  /** The CLI subprocess exit code (null when the CLI never ran or did not start). */
  readonly cliExitCode: number | null;
  /** The validated report (null when the report could not be produced). */
  readonly report: SelfScoreReport | null;
  /** The breached rows recomputed from the verified report (empty on pass). */
  readonly breaches: readonly SelfScoreRow[];
  /** The fail-closed error message (null on pass). */
  readonly error: string | null;
}

/** Outcome of one CLI subprocess run. `code` is null when the process could
 * not be started at all or was killed by a signal. */
interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal?: string;
  readonly spawnError?: string;
}

/**
 * Normalize a path for cross-checking: canonicalize (resolving filesystem
 * aliases such as macOS /var -> /private/var) and forward-slash it, mirroring
 * the CLI's own path-matching normalization.
 */
function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // Non-existing paths stay resolved (not canonical); the CLI tolerates
    // the same case for foreign coverage reports.
  }
  return canonical.split(path.sep).join("/");
}

/** Render a path relative to the repo root for diagnostics. */
function relativeToRepo(filePath: string): string {
  return path.relative(REPO_ROOT, filePath);
}

/** Truncate a captured stream for inclusion in an error message. */
function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

/** True when `value` is a finite (non-NaN, non-±Infinity) number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The row-matching identity key for one current function: canonical file +
 * line range + name + display name + complexity. This is the identity a
 * report row must match to count as that function's representation.
 */
export function functionIdentityKey(
  filePath: string,
  startLine: number,
  endLine: number,
  name: string,
  displayName: string,
  complexity: number,
): string {
  return [
    normalizePath(filePath),
    startLine,
    endLine,
    name,
    displayName,
    complexity,
  ].join(":");
}

/** The numeric fields of a report row, checked for finiteness as a group. */
const ROW_NUMERIC_FIELDS = [
  "startLine",
  "endLine",
  "complexity",
  "coverage",
  "crap",
  "totalStatements",
  "coveredStatements",
  "threshold",
] as const;

/** One entry of {@link ROW_NUMERIC_FIELDS}. */
type RowNumericField = (typeof ROW_NUMERIC_FIELDS)[number];

/**
 * Validate the shape of one report row. Returns an error message naming the
 * offending field, or null when the row is structurally sound.
 *
 * Beyond plain finiteness, the row's numbers must be coherent values:
 * integer line numbers (1-based, startLine <= endLine), integer complexity
 * >= 1, non-negative integer statement counts with
 * coveredStatements <= totalStatements, integer threshold >= 0, and
 * coverage within [0, 1].
 */
function validateRowShape(row: unknown, index: number): string | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return `rows[${index}] is not an object`;
  }
  const r = row as Record<string, unknown>;
  for (const field of ["name", "displayName", "filePath"] as const) {
    if (typeof r[field] !== "string") {
      return `rows[${index}].${field} is not a string`;
    }
  }
  // Check and narrow every numeric field in one pass; the narrowed record
  // below carries the proven-finite numbers for the relationship checks.
  const nums = {} as Record<RowNumericField, number>;
  for (const field of ROW_NUMERIC_FIELDS) {
    const value: unknown = r[field];
    if (!isFiniteNumber(value)) {
      return `rows[${index}].${field} is not a finite number`;
    }
    nums[field] = value;
  }
  if (
    !Number.isInteger(nums.startLine) ||
    nums.startLine < 1 ||
    !Number.isInteger(nums.endLine) ||
    nums.endLine < nums.startLine
  ) {
    return `rows[${index}] has incoherent line numbers (startLine ${nums.startLine}, endLine ${nums.endLine})`;
  }
  if (!Number.isInteger(nums.complexity) || nums.complexity < 1) {
    return `rows[${index}].complexity ${nums.complexity} is not a positive integer`;
  }
  if (
    !Number.isInteger(nums.totalStatements) ||
    nums.totalStatements < 0 ||
    !Number.isInteger(nums.coveredStatements) ||
    nums.coveredStatements < 0
  ) {
    return `rows[${index}] has a non-integer or negative statement count`;
  }
  if (nums.coveredStatements > nums.totalStatements) {
    return (
      `rows[${index}].coveredStatements ${nums.coveredStatements} exceeds ` +
      `totalStatements ${nums.totalStatements}`
    );
  }
  if (!Number.isInteger(nums.threshold) || nums.threshold < 0) {
    return `rows[${index}].threshold ${nums.threshold} is not a non-negative integer`;
  }
  if (nums.coverage < 0 || nums.coverage > 1) {
    return `rows[${index}].coverage is outside [0, 1]`;
  }
  if (typeof r["coverageMatched"] !== "boolean") {
    return `rows[${index}].coverageMatched is not a boolean`;
  }
  return null;
}

/**
 * Validate the COVERAGE SEMANTICS and independently recompute the CRAP of
 * one structurally-sound row. The row's fields are never trusted:
 *
 * - coverage must equal covered/total when total > 0, and exactly 0
 *   otherwise (the zero-statement case reports coverage 0);
 * - an unmatched row may never claim positive coverage or statements
 *   (unmatched functions carry coverage 0 and zero statements);
 * - a matched row with positive coverage must have covered statements;
 * - the CRAP score must match the production formula
 *   (computeCrap in src/crap.ts) applied to the row's own complexity and
 *   coverage, within CRAP_RECOMPUTE_TOLERANCE. A deviation means the score
 *   was forged or computed from different inputs.
 *
 * @returns an error message, or null when the row is coherent and its CRAP
 *   verifies.
 */
function validateRowSemantics(row: SelfScoreRow, index: number): string | null {
  const { totalStatements: total, coveredStatements: covered } = row;
  const expectedCoverage = total > 0 ? covered / total : 0;
  if (Math.abs(row.coverage - expectedCoverage) > COVERAGE_FRACTION_TOLERANCE) {
    return (
      `rows[${index}] ("${row.displayName}") coverage ${row.coverage} is inconsistent ` +
      `with its statement counts (${covered}/${total}); the correct coverage for ` +
      `those counts is ${expectedCoverage}`
    );
  }
  if (!row.coverageMatched) {
    if (row.coverage !== 0) {
      return (
        `rows[${index}] ("${row.displayName}") is not coverage-matched but reports ` +
        `coverage ${row.coverage}; an unmatched function's coverage is always 0`
      );
    }
    if (total !== 0 || covered !== 0) {
      return (
        `rows[${index}] ("${row.displayName}") is not coverage-matched but carries ` +
        `statement counts (${covered}/${total}); an unmatched function carries zero statements`
      );
    }
  }
  let computed: number;
  try {
    computed = computeCrap(row.complexity, row.coverage).crap;
  } catch (e) {
    return (
      `rows[${index}] ("${row.displayName}") CRAP cannot be independently ` +
      `verified: ${(e as Error).message}`
    );
  }
  if (Math.abs(row.crap - computed) > CRAP_RECOMPUTE_TOLERANCE) {
    return (
      `rows[${index}] ("${row.displayName}") crap ${row.crap} deviates from the ` +
      `independently recomputed CRAP ${computed} for complexity ${row.complexity} ` +
      `and coverage ${row.coverage}`
    );
  }
  return null;
}

/**
 * Parse raw CLI stdout as a JSON CRAP report.
 *
 * Fails closed: non-JSON output, a non-object top level, a missing or
 * non-array `rows`, a malformed row field (including incoherent integer /
 * range / count values), or a malformed `summary` all produce an `error`
 * (with `report: null`) instead of a report.
 */
export function parseSelfScoreReport(raw: string): SelfScoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { report: null, error: `CLI output is not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { report: null, error: "CLI output JSON must be a report object with rows and summary" };
  }
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p["rows"])) {
    return { report: null, error: "report.rows is missing or not an array" };
  }
  const rawRows = p["rows"] as unknown[];
  for (let i = 0; i < rawRows.length; i++) {
    const rowError = validateRowShape(rawRows[i], i);
    if (rowError !== null) {
      return { report: null, error: rowError };
    }
  }
  const s = p["summary"];
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    return { report: null, error: "report.summary is missing or not an object" };
  }
  const so = s as Record<string, unknown>;
  for (const field of ["totalFunctions", "breachedCount", "maxCrap", "threshold"] as const) {
    const value: unknown = so[field];
    if (!isFiniteNumber(value)) {
      return { report: null, error: `report.summary.${field} is not a finite number` };
    }
  }
  const breached: unknown = so["breached"];
  if (typeof breached !== "boolean") {
    return { report: null, error: "report.summary.breached is not a boolean" };
  }
  // Every row and every summary field passed the structural checks above, so
  // the shape-cast below is safe: the value is a structurally complete
  // SelfScoreReport (fields are finite numbers, strings, or booleans).
  const report: SelfScoreReport = {
    rows: rawRows as SelfScoreRow[],
    summary: {
      totalFunctions: so["totalFunctions"] as number,
      breachedCount: so["breachedCount"] as number,
      maxCrap: so["maxCrap"] as number,
      threshold: so["threshold"] as number,
      breached,
    },
  };
  return { report, error: null };
}

/**
 * The rows of a report whose CRAP score strictly exceeds the row's
 * applicable threshold.
 */
export function breachingRowsOf(report: SelfScoreReport): SelfScoreRow[] {
  return report.rows.filter((row) => row.crap > row.threshold);
}

/**
 * Build the independent expected function inventory from the CURRENT source
 * tree using the production discovery/analysis API
 * ({@link discoverSourceFiles} for the file set, {@link analyzeSource} for
 * per-function identity, range, and complexity).
 *
 * Files with zero functions contribute zero entries (that is the explicit
 * zero-function representation the completeness check relies on). Unreadable
 * files throw, because an inventory that silently skips a source file would
 * be exactly the kind of partial proof the gate must never accept.
 *
 * @param sourceFiles - the discovered current src/ source files.
 */
export function buildExpectedFunctions(sourceFiles: readonly string[]): ExpectedFunction[] {
  const expected: ExpectedFunction[] = [];
  for (const file of sourceFiles) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(
        `cannot read source file ${relativeToRepo(file)}: ${(e as Error).message}`,
      );
    }
    for (const fn of analyzeSource(file, source)) {
      expected.push({
        key: functionIdentityKey(
          fn.filePath,
          fn.startLine,
          fn.endLine,
          fn.name,
          fn.displayName,
          fn.complexity,
        ),
        filePath: fn.filePath,
        name: fn.name,
        displayName: fn.displayName,
        startLine: fn.startLine,
        endLine: fn.endLine,
        startColumn: fn.startColumn,
        endColumn: fn.endColumn,
        complexity: fn.complexity,
      });
    }
  }
  return expected;
}

/**
 * Validate that a parsed report is a gate-integrity and completeness
 * proof against the CURRENT repository state at the gate threshold.
 *
 * Checks, in order:
 * - summary threshold equals the gate threshold (a stale/foreign report
 *   from a different run is rejected);
 * - EVERY row's threshold equals the gate threshold exactly (the
 *   invocation uses --threshold 8 with no path config, so any other row
 *   threshold — raised or lowered — is rejected);
 * - every row's coverage semantics hold and its CRAP verifies against the
 *   independent production-formula recomputation (see
 *   {@link validateRowSemantics});
 * - summary.totalFunctions equals the actual row count;
 * - summary.maxCrap equals the recomputed maximum row crap;
 * - summary.breachedCount equals the recomputed breach count (rows whose
 *   crap strictly exceeds their applicable threshold, now uniformly the
 *   gate threshold);
 * - summary.breached equals (recomputed breach count > 0);
 * - every row's file belongs to the current src/ tree;
 * - no two rows represent the same current function (duplicate rows are
 *   rejected);
 * - every row matches exactly one current function's identity
 *   (canonical file + range + name + display name + complexity); a row for
 *   a zero-function source file is rejected with a dedicated diagnostic;
 * - every current function is represented (missing functions are rejected,
 *   so source files with zero functions are proven by having zero rows,
 *   not assumed);
 * - the coverage file's entries are compared against the EXPECTED
 *   coverage-tracked files (current src minus the vitest config's
 *   coverage excludes): a missing expected entry (corrupted/partial
 *   coverage) or an unexpected entry (stale coverage) is rejected;
 * - secondary sanity floors: at least `minTotalFunctions` functions and at
 *   least `minMatchedFunctions` coverage-matched functions.
 *
 * @returns the first error message found, or null when the report is valid.
 */
export function validateSelfScoreReport(
  report: SelfScoreReport,
  ctx: SelfScoreGateContext,
): string | null {
  if (report.summary.threshold !== ctx.threshold) {
    return (
      `report summary threshold ${report.summary.threshold} does not match the ` +
      `gate threshold ${ctx.threshold}; the report is stale or came from a different run`
    );
  }
  for (let i = 0; i < report.rows.length; i++) {
    const row = report.rows[i]!;
    if (row.threshold !== ctx.threshold) {
      return (
        `report row "${row.displayName}" (rows[${i}], filePath ${row.filePath}) has row ` +
        `threshold ${row.threshold}, but the gate invocation uses --threshold ` +
        `${ctx.threshold} with no path config; every row must carry exactly ${ctx.threshold}`
      );
    }
  }
  for (let i = 0; i < report.rows.length; i++) {
    const rowError = validateRowSemantics(report.rows[i]!, i);
    if (rowError !== null) {
      return rowError;
    }
  }
  if (report.summary.totalFunctions !== report.rows.length) {
    return (
      `report summary totalFunctions ${report.summary.totalFunctions} does not ` +
      `match the actual row count ${report.rows.length}`
    );
  }
  let maxCrap = 0;
  for (const row of report.rows) {
    if (row.crap > maxCrap) maxCrap = row.crap;
  }
  if (report.summary.maxCrap !== maxCrap) {
    return (
      `report summary maxCrap ${report.summary.maxCrap} does not match the ` +
      `recomputed maximum row CRAP ${maxCrap}`
    );
  }
  const breaches = breachingRowsOf(report);
  if (report.summary.breachedCount !== breaches.length) {
    return (
      `report summary breachedCount ${report.summary.breachedCount} does not ` +
      `match the ${breaches.length} row(s) recomputed to exceed their applicable threshold`
    );
  }
  if (report.summary.breached !== (breaches.length > 0)) {
    return (
      `report summary breached=${report.summary.breached} does not match the ` +
      `recomputed breach state (${breaches.length} breached row(s))`
    );
  }

  // --- Report completeness: exact one-to-one against the current tree. ---
  // Completeness is a MULTISET comparison on the row identity key: two
  // distinct current functions may share every identity field a report row
  // carries (e.g. two nested arrows on one line), in which case the report
  // must contain exactly as many rows for that identity as the tree has
  // functions. Set semantics would misclassify such a genuine report.
  const expectedByFile = new Map<string, ExpectedFunction[]>();
  for (const fn of ctx.expectedFunctions) {
    const file = normalizePath(fn.filePath);
    let list = expectedByFile.get(file);
    if (list === undefined) {
      list = [];
      expectedByFile.set(file, list);
    }
    list.push(fn);
  }
  const expectedCounts = new Map<string, number>();
  for (const fn of ctx.expectedFunctions) {
    expectedCounts.set(fn.key, (expectedCounts.get(fn.key) ?? 0) + 1);
  }
  for (let i = 0; i < report.rows.length; i++) {
    const row = report.rows[i]!;
    const normalized = normalizePath(row.filePath);
    if (!ctx.expectedSourceFiles.has(normalized)) {
      return (
        `report row "${row.displayName}" (filePath ${row.filePath}) is not part ` +
        `of the current src/ tree; the report is not an own-source result of this checkout`
      );
    }
  }
  const rowCounts = new Map<string, number>();
  const rowIndexesByKey = new Map<string, number[]>();
  for (let i = 0; i < report.rows.length; i++) {
    const row = report.rows[i]!;
    const key = functionIdentityKey(
      row.filePath,
      row.startLine,
      row.endLine,
      row.name,
      row.displayName,
      row.complexity,
    );
    rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    let indexes = rowIndexesByKey.get(key);
    if (indexes === undefined) {
      indexes = [];
      rowIndexesByKey.set(key, indexes);
    }
    indexes.push(i);
  }
  for (const [key, count] of rowCounts) {
    const expected = expectedCounts.get(key) ?? 0;
    if (expected === 0) {
      const rowIndexes = rowIndexesByKey.get(key)!;
      const row = report.rows[rowIndexes[0]!]!;
      const file = normalizePath(row.filePath);
      if (!expectedByFile.has(file)) {
        // The file is in the current tree (checked above) but has no
        // functions: it must be represented by zero rows.
        return (
          `source file ${relativeToRepo(row.filePath)} has zero functions in the ` +
          `current tree, but the report carries ${count} row(s) for it; the report ` +
          `is stale or contains unexpected rows`
        );
      }
      return (
        `report row "${row.displayName}" (${relativeToRepo(row.filePath)}:${row.startLine}) ` +
        `does not match any function in the current source tree (unexpected or stale ` +
        `row: no current function has that file, range, name, and complexity)`
      );
    }
    if (count > expected) {
      const rowIndexes = rowIndexesByKey.get(key)!;
      const row = report.rows[rowIndexes[0]!]!;
      return (
        `report contains duplicate rows for the same current function: ${count} ` +
        `row(s) (rows ${rowIndexes.join(", ")}) identify "${row.displayName}" at ` +
        `${relativeToRepo(row.filePath)}:${row.startLine} (cc ${row.complexity}) but ` +
        `the current tree has only ${expected} such function(s)`
      );
    }
  }
  for (const fn of ctx.expectedFunctions) {
    const present = rowCounts.get(fn.key) ?? 0;
    const expected = expectedCounts.get(fn.key)!;
    if (present < expected) {
      return (
        `report omits current function "${fn.displayName}" at ` +
        `${relativeToRepo(fn.filePath)}:${fn.startLine} (cc ${fn.complexity}); every ` +
        `function of the current source tree must be represented by exactly one row`
      );
    }
  }
  // --- Coverage completeness: entries vs the EXPECTED tracked files. ---
  // Compared against the files the current coverage run is expected to
  // track (current src minus the vitest config's coverage excludes), not
  // merely against the entries already present in the coverage file: a
  // corrupted/partial coverage is missing an expected entry, and stale
  // coverage tracks a file the current run does not expect. (Row presence
  // for tracked files that carry functions is already proven by the
  // one-to-one inventory check above; zero-function tracked files are
  // represented by exactly zero rows, which the inventory check verified.)
  for (const file of [...ctx.expectedCoverageTrackedFiles].sort()) {
    if (!ctx.expectedCoverageSourceFiles.has(file)) {
      return (
        `coverage file is missing an entry for ${relativeToRepo(file)}, which ` +
        `the current coverage run is expected to track; the coverage is ` +
        `corrupted, stale, or was generated from a different tree`
      );
    }
  }
  for (const file of [...ctx.expectedCoverageSourceFiles].sort()) {
    if (!ctx.expectedCoverageTrackedFiles.has(file)) {
      return (
        `coverage file tracks ${relativeToRepo(file)}, which the current ` +
        `coverage run is not expected to track; the coverage is stale or came ` +
        `from a different tree`
      );
    }
  }

  // --- Secondary sanity floors (completeness is proven above, not here). ---
  if (report.rows.length < ctx.minTotalFunctions) {
    return (
      `report has only ${report.rows.length} functions (< ${ctx.minTotalFunctions}); ` +
      `the run did not analyze the full src/ tree`
    );
  }
  const matched = report.rows.filter((row) => row.coverageMatched).length;
  if (matched < ctx.minMatchedFunctions) {
    return (
      `report has only ${matched} coverage-matched functions (< ${ctx.minMatchedFunctions}); ` +
      `the coverage file does not match the current source`
    );
  }
  return null;
}

/**
 * Format the success audit line block printed when the gate passes.
 */
export function formatSelfScorePassAudit(report: SelfScoreReport, threshold: number): string {
  const matched = report.rows.filter((row) => row.coverageMatched).length;
  return [
    `Self-score OK: own-source CRAP gate passed at threshold ${threshold}.`,
    `  functions: ${report.summary.totalFunctions} (coverage-matched: ${matched})`,
    `  max CRAP: ${report.summary.maxCrap.toFixed(1)}`,
    `  breached rows: 0`,
  ].join("\n");
}

/**
 * Format one diagnostic line per breached row for failure messages.
 */
export function formatBreachedRows(breaches: readonly SelfScoreRow[]): string {
  return breaches
    .map(
      (row) =>
        `  ${row.displayName} (${row.filePath}:${row.startLine}): ` +
        `CRAP ${row.crap.toFixed(1)} > threshold ${row.threshold}, ` +
        `cc ${row.complexity}, coverage ${(row.coverage * 100).toFixed(1)}%`,
    )
    .join("\n");
}

/**
 * Fail closed on missing or stale coverage BEFORE the CLI runs.
 *
 * @returns an error message, or null when the coverage file exists and is
 *   fresh (no src/ file is meaningfully newer than it).
 */
export function assertCoverageFreshness(
  coverageFile: string,
  sourceFiles: readonly string[],
): string | null {
  if (!fs.existsSync(coverageFile)) {
    return (
      `coverage file ${coverageFile} not found; ` +
      `run \`npm run coverage\` before \`npm run self-score\``
    );
  }
  let coverageMtime: number;
  try {
    coverageMtime = fs.statSync(coverageFile).mtimeMs;
  } catch (e) {
    return `coverage file ${coverageFile} cannot be stat'ed: ${(e as Error).message}`;
  }
  const stale = sourceFiles.filter(
    (file) => fs.statSync(file).mtimeMs > coverageMtime + STALE_TOLERANCE_MS,
  );
  if (stale.length > 0) {
    const examples = stale.slice(0, 3).map((file) => relativeToRepo(file)).join(", ");
    return (
      `coverage file ${coverageFile} is stale: ${stale.length} source file(s) under ` +
      `src/ are newer than it (${examples}${stale.length > 3 ? ", ..." : ""}); ` +
      `run \`npm run coverage\` again before \`npm run self-score\``
    );
  }
  return null;
}

/** Run one CLI subprocess against the repository (no auto-run of the gate). */
function runCli(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): CliResult {
  try {
    const stdout = execFileSync(args[0]!, args.slice(1), {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as {
      stdout?: unknown;
      stderr?: unknown;
      status?: number | null;
      signal?: string;
      message?: string;
      killed?: boolean;
    };
    const signal = err.signal;
    const spawnError = err.message;
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      code: typeof err.status === "number" ? err.status : null,
      ...(signal === undefined ? {} : { signal }),
      ...(spawnError === undefined ? {} : { spawnError }),
    };
  }
}

/**
 * Read the `coverage.exclude` file list from vitest.config.ts (the
 * repository's coverage provider config). The self-score gate is the
 * consumer of that coverage run, so its expected tracked file set derives
 * from the same config the run uses.
 *
 * @returns the exclude globs, or an error message when the config cannot
 *   be read or parsed (the gate must not assume a default it cannot see).
 */
function readVitestCoverageExclude(
  cwd: string,
): { exclude: readonly string[] } | string {
  const configPath = path.join(cwd, "vitest.config.ts");
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    return `vitest config ${relativeToRepo(configPath)} could not be read: ${(e as Error).message}`;
  }
  const start = raw.indexOf("exclude:");
  if (start < 0) {
    return `vitest config ${relativeToRepo(configPath)} has no coverage exclude list; cannot derive the expected tracked coverage files`;
  }
  const open = raw.indexOf("[", start);
  const close = raw.indexOf("]", open);
  if (open < 0 || close < 0 || close <= open) {
    return `vitest config ${relativeToRepo(configPath)} coverage exclude list is malformed`;
  }
  const inner = raw.slice(open + 1, close);
  const exclude: string[] = [];
  for (const match of inner.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    if (match[1] !== undefined) exclude.push(match[1]);
  }
  return { exclude };
}

/**
 * Build the validation context from the current repository state: the
 * discovered src/ tree, its independent function inventory, and the src
 * files the coverage file tracks (and is expected to track).
 *
 * @returns the gate context, or an error message when the coverage file
 *   cannot be re-read here (it must have been readable for the CLI to
 *   produce a report at all, so this is a defensive failure) or when the
 *   vitest coverage config cannot be read (the expected tracked set would
 *   be an assumption, not a proof).
 */
export function buildGateContext(
  sourceFiles: readonly string[],
  cwd: string = REPO_ROOT,
  coverageFile: string = path.join(cwd, "coverage", "coverage-final.json"),
): SelfScoreGateContext | string {
  let coveragePaths: string[];
  try {
    const coverage = readCoverage(coverageFile);
    coveragePaths = [];
    for (const [key, entry] of Object.entries(coverage)) {
      coveragePaths.push(entry.path ?? key);
    }
  } catch (e) {
    return `coverage file ${coverageFile} could not be re-read for validation: ${(e as Error).message}`;
  }
  const excludeResult = readVitestCoverageExclude(cwd);
  if (typeof excludeResult === "string") {
    return excludeResult;
  }
  const srcRoot = path.join(cwd, "src");
  const expectedSourceFiles = new Set(sourceFiles.map((file) => normalizePath(file)));
  /** True when a path matches one of the vitest coverage exclude globs. */
  const matchesExclude = (filePath: string): boolean =>
    excludeResult.exclude.some(
      (glob) => filePath === glob || filePath.endsWith("/" + glob.replace(/^\.\//, "")),
    );
  const expectedCoverageTrackedFiles = new Set<string>();
  for (const file of expectedSourceFiles) {
    if (!matchesExclude(file)) {
      expectedCoverageTrackedFiles.add(file);
    }
  }
  const expectedCoverageSourceFiles = new Set<string>();
  for (const entryPath of coveragePaths) {
    const abs = path.resolve(cwd, entryPath);
    const rel = path.relative(srcRoot, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    expectedCoverageSourceFiles.add(normalizePath(abs));
  }
  const expectedFunctions = buildExpectedFunctions(sourceFiles);
  return {
    threshold: THRESHOLD,
    expectedSourceFiles,
    expectedCoverageTrackedFiles,
    expectedCoverageSourceFiles,
    expectedFunctions,
    minTotalFunctions: MIN_TOTAL_FUNCTIONS,
    minMatchedFunctions: MIN_MATCHED_FUNCTIONS,
  };
}

/**
 * Run the entire self-score gate without touching process.exit: freshness
 * check, real CLI execution at threshold 8, structural parse,
 * gate-integrity + completeness validation, and breach recomputation.
 *
 * This is the single implementation of the gate; `main` is a thin adapter
 * that prints the outcome and exits with its code.
 */
export function runSelfScoreGate(
  options: SelfScoreGateOptions = {},
): SelfScoreGateOutcome {
  const cwd = options.cwd ?? REPO_ROOT;
  const srcRoot = path.join(cwd, "src");
  const sourceFiles = discoverSourceFiles([srcRoot]);

  const failure = (
    message: string,
    partial: {
      cliExitCode?: number | null;
      report?: SelfScoreReport | null;
      breaches?: readonly SelfScoreRow[];
    } = {},
  ): SelfScoreGateOutcome => ({
    code: 1,
    stdout: "",
    stderr: `Error: ${message}\n`,
    cliExitCode: partial.cliExitCode ?? null,
    report: partial.report ?? null,
    breaches: partial.breaches ?? [],
    error: message,
  });

  const cliArgs = options.args ?? [
    "npx",
    "tsx",
    CLI_SOURCE,
    path.relative(cwd, srcRoot),
    "--coverage",
    COVERAGE_FILE,
    "--threshold",
    String(THRESHOLD),
    "--json",
  ];
  // The freshness pre-check guards the very coverage file the CLI will read,
  // so it must use the run's --coverage argument, not the default path.
  // Match the production parser's left-to-right override semantics: when an
  // argument is repeated, the final --coverage value is the file the CLI uses.
  const coverageArgIndex = cliArgs.lastIndexOf("--coverage");
  const coverageFile =
    coverageArgIndex >= 0 && cliArgs[coverageArgIndex + 1] !== undefined
      ? path.resolve(cwd, cliArgs[coverageArgIndex + 1]!)
      : path.join(cwd, "coverage", "coverage-final.json");

  const freshnessError = assertCoverageFreshness(coverageFile, sourceFiles);
  if (freshnessError !== null) {
    return failure(freshnessError);
  }

  const result = runCli(cliArgs, cwd, options.timeoutMs ?? CLI_TIMEOUT_MS);
  if (result.code === null) {
    if (result.signal !== undefined) {
      return failure(
        `CLI was killed by signal ${result.signal} (timeout ${options.timeoutMs ?? CLI_TIMEOUT_MS}ms); ` +
          `re-run \`npm run self-score\` with a clean tree`,
      );
    }
    return failure(
      `failed to launch the CLI (npx tsx ${path.relative(cwd, CLI_SOURCE)}): ` +
        `${result.spawnError ?? "unknown spawn error"}; check that devDependencies are installed (npm ci)`,
    );
  }
  if (result.code === 1) {
    return failure(
      `CLI exited 1 (invalid input) — usually a missing, stale, or malformed coverage ` +
        `file or a bad argument; if src/ changed, run \`npm run coverage\` first.\n` +
        `CLI stderr:\n${truncate(result.stderr) || "(empty)"}\n` +
        (result.stdout !== "" ? `CLI stdout:\n${truncate(result.stdout)}\n` : "") +
        "Self-score aborted: the report could not be produced, so the gate fails closed.",
    );
  }
  if (result.code !== 0 && result.code !== 2) {
    return failure(
      `CLI exited with unexpected code ${result.code} (only 0 or 2 are interpretable).\n` +
        `CLI stderr:\n${truncate(result.stderr) || "(empty)"}\n` +
        (result.stdout !== "" ? `CLI stdout:\n${truncate(result.stdout)}\n` : "") +
        "Self-score aborted: the gate fails closed on uninterpretable CLI results.",
    );
  }

  const parsed = parseSelfScoreReport(result.stdout);
  if (parsed.report === null) {
    return failure(
      `CLI exited ${result.code} but stdout is not a valid JSON report: ${parsed.error}\n` +
        `CLI stdout:\n${truncate(result.stdout) || "(empty)"}`,
    );
  }

  const context = buildGateContext(sourceFiles, cwd, coverageFile);
  if (typeof context === "string") {
    return failure(context);
  }
  const validationError = validateSelfScoreReport(parsed.report, context);
  if (validationError !== null) {
    return failure(`self-score report validation failed: ${validationError}`, {
      cliExitCode: result.code,
      report: parsed.report,
    });
  }

  const breaches = breachingRowsOf(parsed.report);
  if (breaches.length > 0) {
    const detail = formatBreachedRows(breaches);
    if (result.code === 2) {
      return failure(
        `self-score gate FAILED: ${breaches.length} function(s) exceed the ` +
          `threshold-${THRESHOLD} gate:\n${detail}\n` +
          `Fix the flagged functions (raise coverage or reduce complexity), then re-run ` +
          `\`npm run coverage && npm run self-score\`.`,
        { cliExitCode: result.code, report: parsed.report, breaches },
      );
    }
    return failure(
      `inconsistent CLI result: exit 0 (no breach) but ${breaches.length} row(s) exceed ` +
        `their applicable threshold:\n${detail}\n` +
        `Self-score aborted: the gate fails closed on contradictory CLI results.`,
      { cliExitCode: result.code, report: parsed.report, breaches },
    );
  }
  if (result.code === 2) {
    return failure(
      "inconsistent CLI result: exit 2 (breach) but no row exceeds its applicable " +
        "threshold after independent recomputation; the gate fails closed",
      { cliExitCode: result.code, report: parsed.report },
    );
  }

  return {
    code: 0,
    stdout: `${formatSelfScorePassAudit(parsed.report, THRESHOLD)}\n${SUCCESS_LINE}\n`,
    stderr: "",
    cliExitCode: result.code,
    report: parsed.report,
    breaches: [],
    error: null,
  };
}

/** Print the gate outcome and exit with its code. */
function main(): void {
  const outcome = runSelfScoreGate();
  if (outcome.stdout !== "") {
    process.stdout.write(outcome.stdout);
  }
  if (outcome.stderr !== "") {
    process.stderr.write(outcome.stderr);
  }
  process.exit(outcome.code);
}

// Auto-run only when executed directly (`tsx scripts/self-score.ts` /
// `npm run self-score`), never when the module is imported by tests.
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === path.resolve(__filename);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
