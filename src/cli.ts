#!/usr/bin/env node
/** crap4ts CLI entry point. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_THRESHOLD, EXIT_INVALID_INPUT, EXIT_THRESHOLD_EXCEEDED } from "./crap.js";
import { isConfigExcluded, loadConfig, thresholdForPath } from "./config.js";
import { analyzeFiles, discoverSourceFiles } from "./complexity.js";
import { assertNoDirtyTypeScriptFiles, changedFunctionFilter, collectChangedFiles } from "./changed.js";
import { readCoverage, mapAllCoverage } from "./coverage.js";
import { buildReport } from "./report.js";
import {
  defaultCliIo,
  failInvalid,
  parseArgsOrExit,
  renderReportFor,
  resolveConfigSourcePaths,
  writeEmptyResultFor,
} from "./cli-helpers.js";

const io = defaultCliIo();

async function main(): Promise<void> {
  const args = parseArgsOrExit(process.argv, io);
  const cwd = process.cwd();
  const loaded = await loadConfig(cwd, args.configPath);
  const projectRoot = loaded?.projectRoot ?? cwd;
  const sourcePaths = args.sourcePaths.length > 0
    ? args.sourcePaths.map((entry) => path.resolve(cwd, entry))
    : resolveConfigSourcePaths(loaded?.config.src, projectRoot);
  if (sourcePaths.length === 0) failInvalid("no source paths provided and config has no src", io);
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
    if (!fs.existsSync(root)) failInvalid(`source path does not exist: ${root}`, io);
  }
  const coverageFilePath = path.resolve(cwd, args.coverageFile);
  if (!fs.existsSync(coverageFilePath)) failInvalid(`coverage file does not exist: ${args.coverageFile}`, io);

  const files = discoverSourceFiles(sourcePaths, (filePath) => isConfigExcluded(filePath, projectRoot, loaded?.config));
  const changedFiles = changed === undefined ? files : files.filter((filePath) => changed.files.has(filePath));
  if (files.length === 0) {
    writeEmptyResultFor(
      args.format,
      `No TypeScript source files found under: ${sourcePaths.join(", ")}`,
      defaultThreshold,
      io,
    );
    io.exit(0);
  }
  let coverage;
  try {
    coverage = readCoverage(coverageFilePath);
  } catch (error) {
    failInvalid((error as Error).message, io);
  }
  // Changed-only mode still maps every function in each changed file before
  // selecting rows. Per-file mapping needs unchanged nested siblings to retain
  // statement ownership rather than letting their statements fall through to a
  // changed parent.
  const functions = analyzeFiles(changedFiles);
  const eligibleFunctions = changed === undefined ? functions : changedFunctionFilter(functions, changed.files);
  const allFunctionCoverage = mapAllCoverage(functions, coverage!);
  const eligibleFunctionSet = new Set(eligibleFunctions);
  const functionCoverage = changed === undefined
    ? allFunctionCoverage
    : allFunctionCoverage.filter(({ functionInfo }) => eligibleFunctionSet.has(functionInfo));
  if (functionCoverage.length === 0) {
    const report = buildReport([], defaultThreshold, undefined, filter);
    process.stdout.write(renderReportFor(args.format, report) + "\n");
    io.exit(0);
  }
  const report = buildReport(
    functionCoverage,
    defaultThreshold,
    (filePath) => thresholdForPath(filePath, projectRoot, loaded?.config, args.threshold),
    filter,
  );
  process.stdout.write(renderReportFor(args.format, report) + "\n");
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
