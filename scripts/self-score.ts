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
 *    by field; malformed output fails.
 * 5. Re-check the report summary INDEPENDENTLY against the rows
 *    (totalFunctions, maxCrap, breachedCount, breached flag, and that the
 *    summary threshold equals 8) — the summary is never trusted blindly.
 * 6. Verify the report is an own-source result of the CURRENT tree: every
 *    row's file is in the current src/ tree, every src file tracked by the
 *    coverage file has rows in the report, and the report carries at
 *    least MIN_TOTAL_FUNCTIONS functions, at least
 *    MIN_MATCHED_FUNCTIONS of them coverage-matched.
 * 7. Exit 0 only when ZERO rows have crap strictly greater than their
 *    applicable row threshold (recomputed from the rows, never read from
 *    the summary). Otherwise print every breached row and exit 1.
 *
 * The pure parts (parsing, validation, formatting, freshness) are
 * exported so test/self-score-gate.test.ts can unit-test them without
 * spawning a subprocess. The script auto-runs only when executed directly
 * (not when imported).
 *
 * Run via: npm run coverage && npm run self-score
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSourceFiles } from "../src/complexity.js";
import { readCoverage } from "../src/coverage.js";
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
 * Degenerate-report guard: a real run of this repository analyzes well over
 * 150 functions. A report with fewer functions cannot be a full own-source
 * result (a file silently failed to parse, the wrong directory was
 * analyzed, or the report is stale/partial), so the gate fails closed.
 */
const MIN_TOTAL_FUNCTIONS = 100;

/**
 * Degenerate-report guard: a real run matches coverage for nearly every
 * function (only the coverage-excluded entry points are unmatched). If the
 * coverage file does not match the source tree, almost nothing matches and
 * the gate fails closed instead of scoring unmatched (coverage-0) functions.
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

/** Result of parsing raw CLI stdout as a JSON CRAP report. */
export interface SelfScoreParseResult {
  readonly report: SelfScoreReport | null;
  readonly error: string | null;
}

/** Everything the gate knows about the current repository, for validation. */
export interface SelfScoreGateContext {
  readonly threshold: number;
  /** Normalized absolute paths of every current src/ source file. */
  readonly expectedSourceFiles: ReadonlySet<string>;
  /** Normalized absolute paths of src/ files tracked by the coverage file. */
  readonly expectedCoverageSourceFiles: ReadonlySet<string>;
  readonly minTotalFunctions: number;
  readonly minMatchedFunctions: number;
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
 * Validate the shape of one report row. Returns an error message naming the
 * offending field, or null when the row is structurally sound.
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
  for (const field of [
    "startLine",
    "endLine",
    "complexity",
    "coverage",
    "crap",
    "totalStatements",
    "coveredStatements",
    "threshold",
  ] as const) {
    const value: unknown = r[field];
    if (!isFiniteNumber(value)) {
      return `rows[${index}].${field} is not a finite number`;
    }
  }
  const coverage: unknown = r["coverage"];
  if (isFiniteNumber(coverage) && (coverage < 0 || coverage > 1)) {
    return `rows[${index}].coverage is outside [0, 1]`;
  }
  const totalStatements: unknown = r["totalStatements"];
  const coveredStatements: unknown = r["coveredStatements"];
  const threshold: unknown = r["threshold"];
  if (
    (isFiniteNumber(totalStatements) && totalStatements < 0) ||
    (isFiniteNumber(coveredStatements) && coveredStatements < 0) ||
    (isFiniteNumber(threshold) && threshold < 0)
  ) {
    return `rows[${index}] has a negative statement count or threshold`;
  }
  if (typeof r["coverageMatched"] !== "boolean") {
    return `rows[${index}].coverageMatched is not a boolean`;
  }
  return null;
}

/**
 * Parse raw CLI stdout as a JSON CRAP report.
 *
 * Fails closed: non-JSON output, a non-object top level, a missing or
 * non-array `rows`, a malformed row field, or a malformed `summary` all
 * produce an `error` (with `report: null`) instead of a report.
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
 * Validate that a parsed report is a meaningful own-source result of the
 * CURRENT repository state at the gate threshold.
 *
 * Checks, in order:
 * - summary threshold equals the gate threshold (a stale/foreign report
 *   from a different run is rejected);
 * - summary.totalFunctions equals the actual row count;
 * - summary.maxCrap equals the recomputed maximum row crap;
 * - summary.breachedCount equals the recomputed breach count (rows whose
 *   crap strictly exceeds their applicable threshold);
 * - summary.breached equals (recomputed breach count > 0);
 * - every row's file belongs to the current src/ tree;
 * - every src file tracked by the coverage file has rows in the report;
 * - the report carries at least `minTotalFunctions` functions;
 * - at least `minMatchedFunctions` functions are coverage-matched.
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
  const rowFiles = new Set<string>();
  for (const row of report.rows) {
    const normalized = normalizePath(row.filePath);
    rowFiles.add(normalized);
    if (!ctx.expectedSourceFiles.has(normalized)) {
      return (
        `report row "${row.displayName}" (filePath ${row.filePath}) is not part ` +
        `of the current src/ tree; the report is not an own-source result of this checkout`
      );
    }
  }
  for (const file of [...ctx.expectedCoverageSourceFiles].sort()) {
    if (!rowFiles.has(file)) {
      return (
        `coverage file tracks ${relativeToRepo(file)} but the report has no rows ` +
        `for it; the report is stale, partial, or the coverage does not match the source`
      );
    }
  }
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

/** Run the real source CLI against the repo's own coverage at the gate threshold. */
function runCli(): CliResult {
  const args = [
    "tsx",
    CLI_SOURCE,
    path.relative(REPO_ROOT, SRC_ROOT),
    "--coverage",
    COVERAGE_FILE,
    "--threshold",
    String(THRESHOLD),
    "--json",
  ];
  try {
    const stdout = execFileSync("npx", args, {
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: REPO_ROOT,
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
 * Build the validation context from the current repository state: the
 * discovered src/ tree and the src files tracked by the coverage file.
 *
 * @returns the gate context, or an error message when the coverage file
 *   cannot be re-read here (it must have been readable for the CLI to
 *   produce a report at all, so this is a defensive failure).
 */
function buildGateContext(sourceFiles: readonly string[]): SelfScoreGateContext | string {
  let coverageFile: string[];
  try {
    const coverage = readCoverage(COVERAGE_FILE);
    coverageFile = [];
    for (const [key, entry] of Object.entries(coverage)) {
      coverageFile.push(entry.path ?? key);
    }
  } catch (e) {
    return `coverage file ${COVERAGE_FILE} could not be re-read for validation: ${(e as Error).message}`;
  }
  const expectedSourceFiles = new Set(sourceFiles.map((file) => normalizePath(file)));
  const expectedCoverageSourceFiles = new Set<string>();
  for (const entryPath of coverageFile) {
    const abs = path.resolve(REPO_ROOT, entryPath);
    const rel = path.relative(SRC_ROOT, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    expectedCoverageSourceFiles.add(normalizePath(abs));
  }
  return {
    threshold: THRESHOLD,
    expectedSourceFiles,
    expectedCoverageSourceFiles,
    minTotalFunctions: MIN_TOTAL_FUNCTIONS,
    minMatchedFunctions: MIN_MATCHED_FUNCTIONS,
  };
}

/** Print a fail-closed error and exit 1. */
function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** The gate itself: pre-checks, real CLI run, validation, zero-breach assertion. */
function main(): void {
  const sourceFiles = discoverSourceFiles([SRC_ROOT]);

  const freshnessError = assertCoverageFreshness(COVERAGE_FILE, sourceFiles);
  if (freshnessError !== null) {
    fail(freshnessError);
  }

  const result = runCli();
  if (result.code === null) {
    if (result.signal !== undefined) {
      fail(
        `CLI was killed by signal ${result.signal} (timeout ${CLI_TIMEOUT_MS}ms); ` +
          `re-run \`npm run self-score\` with a clean tree`,
      );
    }
    fail(
      `failed to launch the CLI (npx tsx ${path.relative(REPO_ROOT, CLI_SOURCE)}): ` +
        `${result.spawnError ?? "unknown spawn error"}; check that devDependencies are installed (npm ci)`,
    );
  }
  if (result.code === 1) {
    fail(
      `CLI exited 1 (invalid input) — usually a missing, stale, or malformed coverage ` +
        `file or a bad argument; if src/ changed, run \`npm run coverage\` first.\n` +
        `CLI stderr:\n${truncate(result.stderr) || "(empty)"}\n` +
        (result.stdout !== "" ? `CLI stdout:\n${truncate(result.stdout)}\n` : "") +
        "Self-score aborted: the report could not be produced, so the gate fails closed.",
    );
  }
  if (result.code !== 0 && result.code !== 2) {
    fail(
      `CLI exited with unexpected code ${result.code} (only 0 or 2 are interpretable).\n` +
        `CLI stderr:\n${truncate(result.stderr) || "(empty)"}\n` +
        (result.stdout !== "" ? `CLI stdout:\n${truncate(result.stdout)}\n` : "") +
        "Self-score aborted: the gate fails closed on uninterpretable CLI results.",
    );
  }

  const parsed = parseSelfScoreReport(result.stdout);
  if (parsed.report === null) {
    fail(
      `CLI exited ${result.code} but stdout is not a valid JSON report: ${parsed.error}\n` +
        `CLI stdout:\n${truncate(result.stdout) || "(empty)"}`,
    );
  }

  const context = buildGateContext(sourceFiles);
  if (typeof context === "string") {
    fail(context);
  }
  const validationError = validateSelfScoreReport(parsed.report, context);
  if (validationError !== null) {
    fail(`self-score report validation failed: ${validationError}`);
  }

  const breaches = breachingRowsOf(parsed.report);
  if (breaches.length > 0) {
    const detail = formatBreachedRows(breaches);
    if (result.code === 2) {
      fail(
        `self-score gate FAILED: ${breaches.length} function(s) exceed the ` +
          `threshold-${THRESHOLD} gate:\n${detail}\n` +
          `Fix the flagged functions (raise coverage or reduce complexity), then re-run ` +
          `\`npm run coverage && npm run self-score\`.`,
      );
    }
    fail(
      `inconsistent CLI result: exit 0 (no breach) but ${breaches.length} row(s) exceed ` +
        `their applicable threshold:\n${detail}\n` +
        `Self-score aborted: the gate fails closed on contradictory CLI results.`,
    );
  }
  if (result.code === 2) {
    fail(
      "inconsistent CLI result: exit 2 (breach) but no row exceeds its applicable " +
        "threshold after independent recomputation; the gate fails closed",
    );
  }

  console.log(formatSelfScorePassAudit(parsed.report, THRESHOLD));
  console.log(
    "Coverage verified present and fresh; report verified as a structurally valid, " +
      "summary-consistent, own-source result of the real CLI at threshold " +
      `${THRESHOLD} (breaches recomputed from rows, not trusted from the summary).`,
  );
  process.exit(0);
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
