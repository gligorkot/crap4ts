#!/usr/bin/env node
/**
 * crap4ts CLI entry point.
 *
 * Usage:
 *   crap4ts <source-paths...> --coverage <file> [--threshold <n>] [--json]
 *
 * Exit codes:
 *   0  success, no threshold breach
 *   1  invalid arguments or input
 *   2  CRAP threshold exceeded
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_THRESHOLD,
  EXIT_INVALID_INPUT,
  EXIT_THRESHOLD_EXCEEDED,
} from "./crap.js";
import { analyzeFiles, discoverSourceFiles } from "./complexity.js";
import { readCoverage, mapAllCoverage } from "./coverage.js";
import { buildReport, renderHumanReport, renderJsonReport } from "./report.js";

interface CliArgs {
  sourcePaths: string[];
  coverageFile: string;
  threshold: number;
  json: boolean;
}

/** Print usage text to the given stream. */
function printUsage(stream: NodeJS.WriteStream): void {
  stream.write(
    [
      "Usage: crap4ts <source-paths...> --coverage <file> [options]",
      "",
      "Options:",
      "  --coverage <file>     Path to Istanbul coverage-final.json (required)",
      "  --threshold <number>  CRAP failure threshold (default: 8)",
      "  --json                Output JSON report instead of human-readable",
      "  --help                Show this help",
      "",
      "Exit codes:",
      "  0  success, no threshold breach",
      "  1  invalid arguments or input",
      "  2  CRAP threshold exceeded",
      "",
    ].join("\n"),
  );
}

/** Parse and validate CLI arguments. Returns args or exits with code 1. */
function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // skip node + script path
  if (args.length === 0) {
    process.stderr.write("Error: no arguments provided\n");
    printUsage(process.stderr);
    process.exit(EXIT_INVALID_INPUT);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printUsage(process.stdout);
    process.exit(0);
  }

  let coverageFile: string | undefined;
  let threshold = DEFAULT_THRESHOLD;
  let json = false;
  const sourcePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--coverage") {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        process.stderr.write("Error: --coverage requires a file path\n");
        printUsage(process.stderr);
        process.exit(EXIT_INVALID_INPUT);
      }
      coverageFile = val;
      i++;
    } else if (arg === "--threshold") {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        process.stderr.write("Error: --threshold requires a number\n");
        printUsage(process.stderr);
        process.exit(EXIT_INVALID_INPUT);
      }
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed < 0) {
        process.stderr.write(
          `Error: --threshold must be a non-negative number, got "${val}"\n`,
        );
        printUsage(process.stderr);
        process.exit(EXIT_INVALID_INPUT);
      }
      threshold = parsed;
      i++;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Error: unknown option "${arg}"\n`);
      printUsage(process.stderr);
      process.exit(EXIT_INVALID_INPUT);
    } else {
      sourcePaths.push(arg);
    }
  }

  if (sourcePaths.length === 0) {
    process.stderr.write("Error: no source paths provided\n");
    printUsage(process.stderr);
    process.exit(EXIT_INVALID_INPUT);
  }

  if (coverageFile === undefined) {
    process.stderr.write("Error: --coverage is required\n");
    printUsage(process.stderr);
    process.exit(EXIT_INVALID_INPUT);
  }

  return { sourcePaths, coverageFile, threshold, json };
}

function main(): void {
  const args = parseArgs(process.argv);

  // Fail early when any source path does not exist on disk. This distinguishes
  // an explicit misspelled/nonexistent path (invalid input, exit 1) from a valid
  // directory that simply contains no analyzable source files (exit 0).
  for (const root of args.sourcePaths) {
    if (!fs.existsSync(path.resolve(root))) {
      process.stderr.write(`Error: source path does not exist: ${root}\n`);
      process.exit(EXIT_INVALID_INPUT);
    }
  }

  // Discover source files from the given paths.
  const files = discoverSourceFiles(args.sourcePaths);
  if (files.length === 0) {
    const msg = `No TypeScript source files found under: ${args.sourcePaths.join(", ")}`;
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            rows: [],
            summary: {
              totalFunctions: 0,
              breachedCount: 0,
              maxCrap: 0,
              threshold: args.threshold,
              breached: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(msg + "\n");
    }
    process.exit(0);
  }

  // Read coverage.
  const coverageFilePath = args.coverageFile;
  let coverage;
  try {
    coverage = readCoverage(coverageFilePath);
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    process.exit(EXIT_INVALID_INPUT);
  }

  // Analyze functions.
  const functions = analyzeFiles(files);
  if (functions.length === 0) {
    const msg = "No functions found in source files.";
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            rows: [],
            summary: {
              totalFunctions: 0,
              breachedCount: 0,
              maxCrap: 0,
              threshold: args.threshold,
              breached: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(msg + "\n");
    }
    process.exit(0);
  }

  // Map coverage.
  const functionCoverage = mapAllCoverage(functions, coverage);

  // Build report.
  const report = buildReport(functionCoverage, args.threshold);

  // Output.
  if (args.json) {
    process.stdout.write(renderJsonReport(report) + "\n");
  } else {
    process.stdout.write(renderHumanReport(report) + "\n");
  }

  // Exit code based on threshold.
  if (report.summary.breached) {
    process.stderr.write(
      `CRAP threshold exceeded: ${report.summary.maxCrap.toFixed(1)} > ${args.threshold}\n`,
    );
    process.exit(EXIT_THRESHOLD_EXCEEDED);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  // No stack trace by default; just the message.
  process.stderr.write(`Error: ${(e as Error).message}\n`);
  process.exit(EXIT_INVALID_INPUT);
}
