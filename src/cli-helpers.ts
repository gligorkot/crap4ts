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
 * @packageDocumentation
 */
import * as path from "node:path";
import { EXIT_INVALID_INPUT } from "./crap.js";
import {
  renderHumanReport,
  renderJsonReport,
  renderMarkdownReport,
} from "./report.js";
import type { CrapReport, ReportRow } from "./report.js";

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
 * Resolve configured source paths against the project root.
 *
 * A single string becomes a one-element list; undefined yields an empty list.
 */
export function resolveConfigSourcePaths(
  src: string | readonly string[] | undefined,
  projectRoot: string,
): string[] {
  const paths = src === undefined ? [] : typeof src === "string" ? [src] : [...src];
  return paths.map((entry) => path.resolve(projectRoot, entry));
}

const VALUE_OPTIONS = new Set(["--coverage", "--config", "--threshold", "--changed-since", "--format"]);

const FORMATS: readonly string[] = ["human", "json", "markdown"];

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
  const args = argv.slice(2);
  let coverageFile: string | undefined;
  let threshold: number | undefined;
  let configPath: string | undefined;
  let changedSince: string | undefined;
  let format: CliOutputFormat = "human";
  const sourcePaths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    const value = args[index + 1];
    if (VALUE_OPTIONS.has(arg)) {
      if (value === undefined || value.startsWith("--")) throw new CliArgError(`${arg} requires a value`);
      if (arg === "--coverage") coverageFile = value;
      else if (arg === "--config") configPath = value;
      else if (arg === "--changed-since") changedSince = value;
      else if (arg === "--format") {
        if (!FORMATS.includes(value)) {
          throw new CliArgError(`--format must be one of human, json, markdown, got "${value}"`);
        }
        format = value as CliOutputFormat;
      } else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new CliArgError(`--threshold must be a non-negative number, got "${value}"`);
        }
        threshold = parsed;
      }
      index++;
    } else if (arg === "--json") format = "json";
    else if (arg === MARKDOWN_ALIAS) format = "markdown";
    else if (arg.startsWith("--")) throw new CliArgError(`unknown option "${arg}"`);
    else sourcePaths.push(arg);
  }
  if (coverageFile === undefined) throw new CliArgError("--coverage is required");
  return {
    sourcePaths,
    coverageFile,
    ...(threshold === undefined ? {} : { threshold }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(changedSince === undefined ? {} : { changedSince }),
    format,
  };
}

/**
 * True when the given argv requests help output (`--help` or `-h`).
 *
 * @param argv - Full argv array including node binary and script path.
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
 * @returns The rendered report body (without trailing newline).
 */
export function renderReportFor(format: CliOutputFormat, report: CrapReport): string {
  if (format === "json") return renderJsonReport(report);
  if (format === "markdown") return renderMarkdownReport(report);
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
 * @param io - Output/exit surface.
 */
export function failInvalid(message: string, io: CliIo): never {
  io.err(`Error: ${message}\n`);
  io.exit(EXIT_INVALID_INPUT);
}
