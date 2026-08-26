/**
 * Pure, side-effect-free helpers extracted from the CLI entry point
 * (src/cli.ts) so argument parsing and output rendering can be directly
 * unit-tested without spawning a subprocess.
 *
 * These helpers intentionally never write to streams or call process.exit;
 * they return structured results that the thin CLI wrapper interprets.
 * Error messages and rendered output are byte-identical to what the CLI has
 * always produced.
 *
 * The second section (CLI pipeline orchestration) contains the directly
 * testable orchestration steps of a CLI run. Every step either returns a
 * plain value or terminates the run through the injected {@link CliIo}, so
 * each step is unit-testable without spawning a subprocess. `runCliPipeline`
 * chains the analysis phase; `main` in src/cli.ts performs only process-level
 * bindings (argv, cwd, the real output surface, the top-level unexpected
 * error guard) and delegates to these steps.
 *
 * @packageDocumentation
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_THRESHOLD, EXIT_INVALID_INPUT, EXIT_THRESHOLD_EXCEEDED } from "./crap.js";
import type { ChangedFile, ChangedFiles, GitRunner } from "./changed.js";
import { assertNoDirtyTypeScriptFiles, changedFunctionFilter, collectChangedFiles } from "./changed.js";
import type { Crap4tsConfig, LoadedConfig } from "./config.js";
import { isConfigExcluded, thresholdForPath } from "./config.js";
import type { FunctionInfo } from "./complexity.js";
import { analyzeFiles, discoverSourceFiles } from "./complexity.js";
import type { FunctionCoverage } from "./coverage.js";
import { mapAllCoverage, readCoverage } from "./coverage.js";
import {
  buildReport,
  renderHumanReport,
  renderJsonReport,
  renderMarkdownReport,
} from "./report.js";
import type { CrapReport, ReportFilter, ReportRow } from "./report.js";

/** Output formats supported by the CLI. */
export type CliOutputFormat = "human" | "json" | "markdown";

/** Parsed CLI arguments. Mirrors the shape consumed by `main`. */
export interface ParsedCliArgs {
  readonly sourcePaths: string[];
  readonly coverageFile: string;
  readonly threshold?: number;
  readonly configPath?: string;
  readonly changedSince?: string;
  readonly format: CliOutputFormat;
  /** Include per-function rows in Markdown output. */
  readonly withTable: boolean;
}

/** Error raised for invalid CLI input; the message is user-facing. */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

/** Exit code to use when argument parsing fails. */
export const CLI_ARG_ERROR_EXIT_CODE = EXIT_INVALID_INPUT;

/**
 * Output/exit surface used by the CLI orchestration helpers. Defaults to the
 * real process streams; tests inject fakes to assert exact output bytes and
 * exit codes without spawning subprocesses.
 */
export interface CliIo {
  /** Write to the process stdout stream. */
  out(text: string): void;
  /** Write to the process stderr stream. */
  err(text: string): void;
  /** Terminate the process with the given exit code. */
  exit(code: number): never;
}

/** Default {@link CliIo} backed by the real process. */
export function defaultCliIo(): CliIo {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    exit: (code) => process.exit(code),
  };
}

/** The exact usage/help text the CLI has always printed. */
export function usageText(): string {
  return [
    "Usage: crap4ts [source-paths...] --coverage <file> [options]",
    "",
    "Options:",
    "  --coverage <file>     Path to Istanbul coverage-final.json (required)",
    "  --config <path>       Load exactly this TS, ESM (.mjs), CommonJS (.cjs), JS, or JSON config file",
    "  --threshold <number>  Override configured CRAP failure threshold",
    "  --changed-since <ref> Analyze only functions changed since ref's merge base with HEAD",
    "  --format <format>     Output format: human (default), json, or markdown",
    "  --with-table          Include per-function rows in Markdown output",
    "  --markdown            Deprecated alias for --format markdown",
    "  --json                Output JSON report (equivalent to --format json)",
    "  --help                Show this help",
    "",
    "Exit codes:",
    "  0  success, no threshold breach",
    "  1  invalid arguments or input",
    "  2  CRAP threshold exceeded",
    "",
  ].join("\n");
}

/** @deprecated Legacy alias for --format markdown. */
export const MARKDOWN_ALIAS = "--markdown";

/**
 * Resolve configured source paths against the given base directory (the
 * config file's directory for loaded configs).
 *
 * A single string becomes a one-element list; undefined yields an empty list.
 */
export function resolveConfigSourcePaths(
  src: string | readonly string[] | undefined,
  baseDir: string,
): string[] {
  const paths = src === undefined ? [] : typeof src === "string" ? [src] : [...src];
  return paths.map((entry) => path.resolve(baseDir, entry));
}

const VALUE_OPTIONS = new Set(["--coverage", "--config", "--threshold", "--changed-since", "--format"]);

const FORMATS: readonly string[] = ["human", "json", "markdown"];

/**
 * Mutable parse state accumulated by {@link scanArgs} while walking the
 * argv token list.
 */
interface ArgParseState {
  coverageFile?: string;
  threshold?: number;
  configPath?: string;
  changedSince?: string;
  format: CliOutputFormat;
  withTable: boolean;
  sourcePaths: string[];
}

/** Fresh parse state for a new argv: human format, no paths or values. */
function initialArgParseState(): ArgParseState {
  return { format: "human", withTable: false, sourcePaths: [] };
}

/**
 * Validate that a value-taking option is followed by a value that is not
 * itself a flag, and return that value.
 *
 * @param option - The option the value belongs to (echoed in the message).
 * @param value - The argument following the option.
 */
function requireValue(option: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) throw new CliArgError(`${option} requires a value`);
  return value;
}

/**
 * Validate and convert a `--threshold` value to a non-negative number.
 *
 * @param value - The raw threshold argument.
 */
function parseThresholdValue(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliArgError(`--threshold must be a non-negative number, got "${value}"`);
  }
  return parsed;
}

/**
 * Validate a `--format` value against the supported formats.
 *
 * @param value - The raw format argument.
 */
function assertSupportedFormat(value: string): CliOutputFormat {
  if (!FORMATS.includes(value)) {
    throw new CliArgError(`--format must be one of human, json, markdown, got "${value}"`);
  }
  return value as CliOutputFormat;
}

/**
 * Apply one validated value-taking option to the parse state.
 *
 * The `--threshold` arm is the `else`: `VALUE_OPTIONS` contains exactly the
 * five value options, and the four named arms above cover all of the rest.
 *
 * @param state - The accumulating parse state.
 * @param option - The option being applied.
 * @param value - The validated option value.
 */
function applyValueOption(state: ArgParseState, option: string, value: string): void {
  if (option === "--coverage") state.coverageFile = value;
  else if (option === "--config") state.configPath = value;
  else if (option === "--changed-since") state.changedSince = value;
  else if (option === "--format") state.format = assertSupportedFormat(value);
  else state.threshold = parseThresholdValue(value);
}

/**
 * Apply one bare (flag) argument to the parse state.
 *
 * @param state - The accumulating parse state.
 * @param arg - The bare argument (never undefined).
 * @param value - The argument following `arg` (only consulted for value
 *   options).
 * @returns True when a value argument was consumed (the caller must skip
 * past it), false for flags that consume only themselves.
 */
function applyBareArg(state: ArgParseState, arg: string, value: string | undefined): boolean {
  if (VALUE_OPTIONS.has(arg)) {
    applyValueOption(state, arg, requireValue(arg, value));
    return true;
  }
  if (arg === "--json") state.format = "json";
  else if (arg === MARKDOWN_ALIAS) state.format = "markdown";
  else if (arg === "--with-table") state.withTable = true;
  else if (arg.startsWith("--")) throw new CliArgError(`unknown option "${arg}"`);
  else state.sourcePaths.push(arg);
  return false;
}

/**
 * Scan a token list (argv without the node binary and script path) into a
 * parse state, in the exact historical order and with the exact historical
 * error precedence: value-presence is checked before per-option validation,
 * flags are applied left-to-right, and later flags override earlier ones.
 *
 * @param args - Tokens after the node binary and script path.
 * @returns The accumulated parse state.
 */
function scanArgs(args: readonly string[]): ArgParseState {
  const state = initialArgParseState();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (applyBareArg(state, arg, args[index + 1])) index++;
  }
  return state;
}

/**
 * Parse raw process.argv-style arguments into structured CLI arguments.
 *
 * Throws {@link CliArgError} with the exact user-facing error messages the
 * CLI emits. The caller is responsible for printing usage text.
 *
 * @param argv - Full argv array including node binary and script path.
 * @returns The parsed arguments.
 */
export function parseArgsPure(argv: readonly string[]): ParsedCliArgs {
  const state = scanArgs(argv.slice(2));
  if (state.coverageFile === undefined) throw new CliArgError("--coverage is required");
  return {
    sourcePaths: state.sourcePaths,
    coverageFile: state.coverageFile,
    ...(state.threshold === undefined ? {} : { threshold: state.threshold }),
    ...(state.configPath === undefined ? {} : { configPath: state.configPath }),
    ...(state.changedSince === undefined ? {} : { changedSince: state.changedSince }),
    format: state.format,
    withTable: state.withTable,
  };
}

/**
 * True when the given argv requests help output (`--help` or `-h`).
 *
 * @param argv - Full process.argv array.
 */
export function isHelpRequest(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  return args.includes("--help") || args.includes("-h");
}

/**
 * Render a CRAP report in the requested output format.
 *
 * @param format - Target output format.
 * @param report - Report to render.
 * @param withTable - Include per-function rows for Markdown output.
 * @returns The rendered report body (without trailing newline).
 */
export function renderReportFor(format: CliOutputFormat, report: CrapReport, withTable = false): string {
  if (format === "json") return renderJsonReport(report);
  if (format === "markdown") return renderMarkdownReport(report, { withTable });
  return renderHumanReport(report);
}

/**
 * Build the JSON object emitted when no source files exist: an empty rows
 * list with a zeroed summary that echoes the effective threshold.
 *
 * @param threshold - Effective failure threshold.
 */
export function buildEmptyResult(threshold: number): {
  rows: ReportRow[];
  summary: {
    totalFunctions: number;
    breachedCount: number;
    maxCrap: number;
    threshold: number;
    breached: boolean;
  };
} {
  return {
    rows: [],
    summary: { totalFunctions: 0, breachedCount: 0, maxCrap: 0, threshold, breached: false },
  };
}

/**
 * Serialize the empty-result JSON payload exactly as the CLI writes it
 * (2-space indent plus trailing newline).
 *
 * @param threshold - Effective failure threshold.
 */
export function serializeEmptyResult(threshold: number): string {
  return JSON.stringify(buildEmptyResult(threshold), null, 2) + "\n";
}

/**
 * Print usage text to a stream and exit with the invalid-input code.
 *
 * @param message - User-facing error message (printed without the caller's
 *   `Error:` prefix, which is added here).
 * @param io - Output/exit surface.
 */
export function failWithUsage(message: string, io: CliIo): never {
  io.err(`Error: ${message}\n`);
  io.err(usageText() + "\n");
  io.exit(CLI_ARG_ERROR_EXIT_CODE);
}

/**
 * Parse argv for the CLI. On success returns the parsed arguments; on
 * failure prints the exact historical error + usage output and exits 1.
 * A help request (`--help` / `-h`) prints usage to stdout and exits 0.
 *
 * @param argv - Full process.argv array.
 * @param io - Output/exit surface.
 */
export function parseArgsOrExit(argv: readonly string[], io: CliIo): ParsedCliArgs {
  if (isHelpRequest(argv)) {
    io.out(usageText() + "\n");
    io.exit(0);
  }
  try {
    return parseArgsPure(argv);
  } catch (error) {
    if (error instanceof CliArgError) return failWithUsage(error.message, io);
    throw error;
  }
}

/**
 * Write the empty-result payload in the requested format.
 *
 * JSON emits the zeroed summary object; human/markdown emit the message
 * (markdown italicised) — exactly as the CLI always has.
 *
 * @param format - Output format.
 * @param message - Human/markdown message line.
 * @param threshold - Effective failure threshold echoed in the JSON payload.
 * @param io - Output surface.
 */
export function writeEmptyResultFor(format: CliOutputFormat, message: string, threshold: number, io: CliIo): void {
  if (format === "json") {
    io.out(serializeEmptyResult(threshold));
  } else if (format === "markdown") {
    io.out(`_${message}_\n`);
  } else io.out(`${message}\n`);
}

/**
 * Report an invalid-input error and exit 1 without printing usage.
 *
 * @param message - User-facing error text (prefixed with `Error: `).
 * @param io - Output surface.
 */
export function failInvalid(message: string, io: CliIo): never {
  io.err(`Error: ${message}\n`);
  io.exit(EXIT_INVALID_INPUT);
}

// ---------------------------------------------------------------------------
// CLI pipeline orchestration
// ---------------------------------------------------------------------------
// The steps below mirror the former `main` body of src/cli.ts one-for-one,
// in the same observable order. Each step is directly testable: pure steps
// return values, and steps that end the run route every write and exit
// through the injected CliIo. `runCliPipeline` chains the whole analysis
// phase for one invocation.

/** Everything one CLI run needs after argument parsing and config loading. */
export interface CliRunContext {
  /** Parsed CLI arguments. */
  readonly args: ParsedCliArgs;
  /** Loaded config, or undefined when no config file was found or given. */
  readonly loaded: LoadedConfig | undefined;
  /** Effective failure threshold (args > config > DEFAULT_THRESHOLD). */
  readonly defaultThreshold: number;
  /** Git runner used for changed-only collection (injectable for tests). */
  readonly gitRunner?: GitRunner;
}

/** Resolved run inputs: where to analyze and which config applies. */
export interface ResolvedCliRun {
  /** Project root the run was invoked in (contains the config file). */
  readonly projectRoot: string;
  /** Directory of the loaded config; base for config-relative paths and globs. */
  readonly configRoot: string;
  /** Resolved source paths the run analyzes. */
  readonly sourcePaths: string[];
  /** Effective config object, when one was loaded. */
  readonly config: Crap4tsConfig | undefined;
  /** The loaded config, when one was loaded. */
  readonly loaded: LoadedConfig | undefined;
}

/**
 * Resolve the effective default failure threshold:
 * CLI `--threshold` > configured `threshold` > {@link DEFAULT_THRESHOLD}.
 */
export function effectiveDefaultThreshold(
  args: ParsedCliArgs,
  loaded: LoadedConfig | undefined,
): number {
  return args.threshold ?? loaded?.config.threshold ?? DEFAULT_THRESHOLD;
}

/**
 * Resolve the effective changed-since ref: CLI `--changed-since` over
 * configured `changedSince`, or undefined when changed-only mode is off.
 */
export function effectiveChangedSince(
  ctx: CliRunContext,
): string | undefined {
  return ctx.args.changedSince ?? ctx.loaded?.config.changedSince;
}

/**
 * Resolve the source paths the run analyzes.
 *
 * CLI-provided paths are resolved against `cwd`; otherwise the configured
 * `src` paths are resolved against the config file's directory, so a nested
 * `--config` file analyzes what its own `src` validates. Glob matching for
 * exclusions and per-path thresholds also uses the config directory.
 */
export function resolveCliRun(ctx: CliRunContext, cwd: string): ResolvedCliRun {
  const loaded = ctx.loaded;
  const projectRoot = loaded?.projectRoot ?? cwd;
  const configRoot = loaded?.configRoot ?? cwd;
  const sourcePaths = ctx.args.sourcePaths.length > 0
    ? ctx.args.sourcePaths.map((entry) => path.resolve(cwd, entry))
    : resolveConfigSourcePaths(loaded?.config.src, configRoot);
  return { projectRoot, configRoot, sourcePaths, config: loaded?.config, loaded };
}

/**
 * Fail (exit 1) when any source path does not exist.
 *
 * @param sourcePaths - Resolved source path list.
 * @param io - Output/exit surface.
 */
export function assertSourcePathsExist(sourcePaths: readonly string[], io: CliIo): void {
  for (const root of sourcePaths) {
    if (!fs.existsSync(root)) failInvalid(`source path does not exist: ${root}`, io);
  }
}

/**
 * Fail (exit 1) when the coverage file does not exist in the working dir.
 *
 * The error message echoes the CLI argument, not the resolved path, exactly
 * as the CLI has always done.
 *
 * @param ctx - Run context (contributes the coverage file argument).
 * @param cwd - Working directory the relative coverage path resolves against.
 * @param io - Output/exit surface.
 */
export function assertCoverageFileExists(ctx: CliRunContext, cwd: string, io: CliIo): void {
  const coverageFilePath = path.resolve(cwd, ctx.args.coverageFile);
  if (!fs.existsSync(coverageFilePath)) {
    failInvalid(`coverage file does not exist: ${ctx.args.coverageFile}`, io);
  }
}

/**
 * Run the changed-only git phase: collect the change set for the effective
 * ref, then require a clean TypeScript worktree.
 *
 * Git failures propagate to the caller (the CLI entry maps them to the exact
 * `Error: <message>` line and exit 1).
 *
 * @returns The change set, or undefined when changed-only mode is off.
 */
export function loadChangedSince(ctx: CliRunContext, cwd: string): ChangedFiles | undefined {
  const changedSince = effectiveChangedSince(ctx);
  if (changedSince === undefined) return undefined;
  const changed = collectChangedFiles(changedSince, cwd, ctx.gitRunner);
  assertNoDirtyTypeScriptFiles(cwd);
  return changed;
}

/**
 * Build the changed-only report filter, or undefined outside changed mode.
 *
 * @param changed - Change set, when changed-only mode is active.
 * @param changedSince - The requested ref (falling back to the merge base).
 */
export function changedFilter(
  changed: ChangedFiles | undefined,
  changedSince: string | undefined,
): ReportFilter | undefined {
  if (changed === undefined) return undefined;
  return {
    mode: "changed",
    changedSince: changedSince ?? changed.mergeBase,
    mergeBase: changed.mergeBase,
    changedFileCount: changed.files.size,
  };
}

/**
 * Discover the source files under the resolved paths, applying the
 * configured exclusion globs.
 *
 * @param sourcePaths - Resolved source paths.
 * @param projectRoot - Project root for exclusion matching.
 * @param config - Effective config, for its exclude globs.
 */
export function discoverSourceFilesExcluded(
  sourcePaths: readonly string[],
  projectRoot: string,
  config: Crap4tsConfig | undefined,
): string[] {
  return discoverSourceFiles(
    [...sourcePaths],
    (filePath) => isConfigExcluded(filePath, projectRoot, config),
  );
}

/**
 * Select the functions eligible for reporting: everything in normal mode, or
 * the changed-line intersection in changed-only mode.
 *
 * @param functions - All analyzed functions of the analyzed files.
 * @param changedFiles - Changed-file map, when changed-only mode is active.
 */
export function eligibleFunctionsFor(
  functions: readonly FunctionInfo[],
  changedFiles: ReadonlyMap<string, ChangedFile> | undefined,
): FunctionInfo[] {
  if (changedFiles === undefined) return [...functions];
  return changedFunctionFilter(functions, changedFiles);
}

/**
 * Wrap functions in a set for O(1) membership during coverage selection.
 *
 * @param functions - Functions to index.
 */
export function eligibleSetOf(functions: readonly FunctionInfo[]): Set<FunctionInfo> {
  return new Set(functions);
}

/**
 * Read and parse the coverage file, exiting 1 with the parser's exact
 * message on failure (no usage text).
 *
 * Module-private by design: its return type is the internal
 * `IstanbulCoverage` shape of the coverage module, which stays unexported;
 * the pipeline's public entry (`runCliPipeline`) covers this behaviour
 * end-to-end, including the failure path.
 *
 * @param coverageFilePath - Resolved coverage file path.
 * @param io - Output/exit surface.
 * @returns The parsed Istanbul coverage object.
 */
function readCoverageOrExit(coverageFilePath: string, io: CliIo) {
  try {
    return readCoverage(coverageFilePath);
  } catch (error) {
    failInvalid((error as Error).message, io);
  }
}

/**
 * Write the rendered report to stdout (with trailing newline) and end the
 * run: exit 2 with the breach line on stderr when the gate failed, else exit 0.
 *
 * @param ctx - Run context (contributes format and threshold resolver inputs).
 * @param configRoot - Directory of the loaded config, for per-path threshold resolution.
 * @param functionCoverage - Eligible per-function coverage entries.
 * @param filter - Changed-only filter, when active.
 * @param io - Output/exit surface.
 */
export function writeReportAndExit(
  ctx: CliRunContext,
  configRoot: string,
  functionCoverage: readonly FunctionCoverage[],
  filter: ReportFilter | undefined,
  io: CliIo,
): void {
  const report = buildReport(
    [...functionCoverage],
    ctx.defaultThreshold,
    (filePath) => thresholdForPath(filePath, configRoot, ctx.loaded?.config, ctx.args.threshold),
    filter,
  );
  io.out(renderReportFor(ctx.args.format, report, ctx.args.withTable) + "\n");
  if (!report.summary.breached) {
    io.exit(0);
    return;
  }
  const breach = report.rows.find((row) => row.crap > row.threshold);
  if (breach !== undefined) {
    io.err(`CRAP threshold exceeded: ${breach.crap.toFixed(1)} > ${breach.threshold}\n`);
  }
  io.exit(EXIT_THRESHOLD_EXCEEDED);
}

/**
 * Run the full analysis pipeline for one CLI invocation.
 *
 * Chain, in the exact historical order: resolve source paths -> fail when
 * none are configured -> run the changed-only git phase (git errors
 * propagate to the caller) -> validate source paths and coverage file ->
 * discover files (fail with the empty result when none) -> read coverage ->
 * analyze, map, and select eligible functions -> build, render, and write
 * the report, exiting with the gate's exit code.
 *
 * Every byte written and the exit code are exactly what the CLI has always
 * produced; tests drive this with temp fixtures and a fake {@link CliIo}.
 *
 * @param ctx - Run context (args, config, effective threshold).
 * @param io - Output/exit surface.
 * @param cwd - Working directory the CLI was invoked in.
 */
export function runCliPipeline(ctx: CliRunContext, io: CliIo, cwd: string): void {
  const run = resolveCliRun(ctx, cwd);
  if (run.sourcePaths.length === 0) {
    failInvalid("no source paths provided and config has no src", io);
  }
  const changed = loadChangedSince(ctx, cwd);
  assertSourcePathsExist(run.sourcePaths, io);
  assertCoverageFileExists(ctx, cwd, io);
  const files = discoverSourceFilesExcluded(run.sourcePaths, run.configRoot, run.config);
  if (files.length === 0) {
    writeEmptyResultFor(
      ctx.args.format,
      `No TypeScript source files found under: ${run.sourcePaths.join(", ")}`,
      ctx.defaultThreshold,
      io,
    );
    io.exit(0);
    return;
  }
  const coverage = readCoverageOrExit(path.resolve(cwd, ctx.args.coverageFile), io);
  const changedFiles = changed?.files;
  const changedFileList = changedFiles === undefined
    ? files
    : files.filter((filePath) => changedFiles.has(filePath));
  const functions = analyzeFiles(changedFileList);
  const eligible = eligibleFunctionsFor(functions, changedFiles);
  // Build the membership set ONCE before filtering: rebuilding it inside the
  // filter callback would allocate a fresh Set per coverage entry.
  const eligibleSet = eligibleSetOf(eligible);
  const functionCoverage = changedFiles === undefined
    ? mapAllCoverage(functions, coverage)
    : mapAllCoverage(functions, coverage).filter((entry) =>
        eligibleSet.has(entry.functionInfo),
      );
  writeReportAndExit(
    ctx,
    run.configRoot,
    functionCoverage,
    changedFilter(changed, effectiveChangedSince(ctx)),
    io,
  );
}
