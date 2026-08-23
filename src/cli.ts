#!/usr/bin/env node
/** crap4ts CLI entry point. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_THRESHOLD, EXIT_INVALID_INPUT, EXIT_THRESHOLD_EXCEEDED } from "./crap.js";
import { isConfigExcluded, loadConfig, thresholdForPath } from "./config.js";
import { analyzeFiles, discoverSourceFiles } from "./complexity.js";
import { assertNoDirtyTypeScriptFiles, changedFunctionFilter, collectChangedFiles } from "./changed.js";
import { readCoverage, mapAllCoverage } from "./coverage.js";
import { buildReport, renderHumanReport, renderJsonReport } from "./report.js";

interface CliArgs {
  readonly sourcePaths: string[];
  readonly coverageFile: string;
  readonly threshold?: number;
  readonly configPath?: string;
  readonly changedSince?: string;
  readonly json: boolean;
}

function printUsage(stream: NodeJS.WriteStream): void {
  stream.write([
    "Usage: crap4ts [source-paths...] --coverage <file> [options]",
    "",
    "Options:",
    "  --coverage <file>     Path to Istanbul coverage-final.json (required)",
    "  --config <path>       Load exactly this TS, ESM (.mjs), CommonJS (.cjs), JS, or JSON config file",
    "  --threshold <number>  Override configured CRAP failure threshold",
    "  --changed-since <ref> Analyze only functions changed since ref's merge base with HEAD",
    "  --json                Output JSON report instead of human-readable",
    "  --help                Show this help",
    "",
    "Exit codes:",
    "  0  success, no threshold breach",
    "  1  invalid arguments or input",
    "  2  CRAP threshold exceeded",
    "",
  ].join("\n"));
}

function invalid(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  printUsage(process.stderr);
  process.exit(EXIT_INVALID_INPUT);
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage(process.stdout);
    process.exit(0);
  }
  let coverageFile: string | undefined;
  let threshold: number | undefined;
  let configPath: string | undefined;
  let changedSince: string | undefined;
  let json = false;
  const sourcePaths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    const value = args[index + 1];
    if (arg === "--coverage" || arg === "--config" || arg === "--threshold" || arg === "--changed-since") {
      if (value === undefined || value.startsWith("--")) invalid(`${arg} requires a value`);
      if (arg === "--coverage") coverageFile = value;
      else if (arg === "--config") configPath = value;
      else if (arg === "--changed-since") changedSince = value;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) invalid(`--threshold must be a non-negative number, got "${value}"`);
        threshold = parsed;
      }
      index++;
    } else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) invalid(`unknown option "${arg}"`);
    else sourcePaths.push(arg);
  }
  if (coverageFile === undefined) invalid("--coverage is required");
  return {
    sourcePaths,
    coverageFile,
    ...(threshold === undefined ? {} : { threshold }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(changedSince === undefined ? {} : { changedSince }),
    json,
  };
}

function configSourcePaths(src: string | readonly string[] | undefined, projectRoot: string): string[] {
  if (src === undefined) return [];
  const paths = typeof src === "string" ? [src] : src;
  return paths.map((entry) => path.resolve(projectRoot, entry));
}

function writeEmptyResult(json: boolean, message: string, threshold: number): void {
  if (json) {
    process.stdout.write(JSON.stringify({
      rows: [],
      summary: { totalFunctions: 0, breachedCount: 0, maxCrap: 0, threshold, breached: false },
    }, null, 2) + "\n");
  } else process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const loaded = await loadConfig(cwd, args.configPath);
  const projectRoot = loaded?.projectRoot ?? cwd;
  const sourcePaths = args.sourcePaths.length > 0
    ? args.sourcePaths.map((entry) => path.resolve(cwd, entry))
    : configSourcePaths(loaded?.config.src, projectRoot);
  if (sourcePaths.length === 0) invalid("no source paths provided and config has no src");
  const defaultThreshold = args.threshold ?? loaded?.config.threshold ?? DEFAULT_THRESHOLD;
  const changedSince = args.changedSince ?? loaded?.config.changedSince;
  const changed = changedSince === undefined ? undefined : collectChangedFiles(changedSince, cwd);
  if (changed !== undefined) assertNoDirtyTypeScriptFiles(cwd);
  const filter = changed === undefined ? undefined : {
    mode: "changed" as const,
    changedSince: changedSince!,
    mergeBase: changed.mergeBase,
    changedFileCount: changed.files.size,
  };

  for (const root of sourcePaths) {
    if (!fs.existsSync(root)) {
      process.stderr.write(`Error: source path does not exist: ${root}\n`);
      process.exit(EXIT_INVALID_INPUT);
    }
  }
  const coverageFilePath = path.resolve(cwd, args.coverageFile);
  if (!fs.existsSync(coverageFilePath)) {
    process.stderr.write(`Error: coverage file does not exist: ${args.coverageFile}\n`);
    process.exit(EXIT_INVALID_INPUT);
  }

  const files = discoverSourceFiles(sourcePaths, (filePath) => isConfigExcluded(filePath, projectRoot, loaded?.config));
  const changedFiles = changed === undefined ? files : files.filter((filePath) => changed.files.has(filePath));
  if (files.length === 0) {
    writeEmptyResult(args.json, `No TypeScript source files found under: ${sourcePaths.join(", ")}`, defaultThreshold);
    process.exit(0);
  }
  let coverage;
  try {
    coverage = readCoverage(coverageFilePath);
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(EXIT_INVALID_INPUT);
  }
  const functions = analyzeFiles(changedFiles);
  const eligibleFunctions = changed === undefined ? functions : changedFunctionFilter(functions, changed.files);
  if (eligibleFunctions.length === 0) {
    const report = buildReport([], defaultThreshold, undefined, filter);
    process.stdout.write((args.json ? renderJsonReport(report) : renderHumanReport(report)) + "\n");
    process.exit(0);
  }
  const functionCoverage = mapAllCoverage(eligibleFunctions, coverage);
  const report = buildReport(
    functionCoverage,
    defaultThreshold,
    (filePath) => thresholdForPath(filePath, projectRoot, loaded?.config, args.threshold),
    filter,
  );
  process.stdout.write((args.json ? renderJsonReport(report) : renderHumanReport(report)) + "\n");
  if (report.summary.breached) {
    const breach = report.rows.find((row) => row.crap > row.threshold);
    if (breach !== undefined) process.stderr.write(`CRAP threshold exceeded: ${breach.crap.toFixed(1)} > ${breach.threshold}\n`);
    process.exit(EXIT_THRESHOLD_EXCEEDED);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${(error as Error).message}\n`);
  process.exit(EXIT_INVALID_INPUT);
});
