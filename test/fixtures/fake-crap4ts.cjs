#!/usr/bin/env node
/**
 * Controlled local CLI fixture for action step tests (test/action.test.ts).
 *
 * Mimics the crap4ts CLI contract the composite action relies on:
 * - reads SOURCE_PATH / COVERAGE_FILE / CRAP_THRESHOLD env-driven args,
 * - emits `--format json` output with summary.breachedCount / summary.maxCrap,
 * - exits 2 on threshold breach, 0 on pass.
 */
const fs = require("node:fs");

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const threshold = Number(argValue("--threshold") ?? "8");
const source = argValue("_source") ?? process.argv[2] ?? "src/sample.ts";

// One covered trivial function plus two uncovered complex ones — enough to
// produce both a breach at low thresholds and a pass at very high ones.
const rows = [
  { name: "plain", displayName: "plain", filePath: `${source}/sample.ts`, startLine: 5, endLine: 6, complexity: 1, coverage: 1, crap: 1, coverageMatched: true, totalStatements: 2, coveredStatements: 2, threshold },
  { name: "withIf", displayName: "withIf", filePath: `${source}/sample.ts`, startLine: 10, endLine: 14, complexity: 2, coverage: 0, crap: 6, coverageMatched: true, totalStatements: 4, coveredStatements: 0, threshold },
  { name: "bigUgly", displayName: "bigUgly", filePath: `${source}/sample.ts`, startLine: 20, endLine: 30, complexity: 5, coverage: 0, crap: 30, coverageMatched: true, totalStatements: 8, coveredStatements: 0, threshold },
];
const breachedCount = rows.filter((row) => row.crap > threshold).length;
const maxCrap = Math.max(...rows.map((row) => row.crap));

process.stdout.write(
  JSON.stringify({
    rows: rows.filter((row) => row.crap > 0),
    summary: { threshold, totalFunctions: rows.length, maxCrap, breachedCount, breached: breachedCount > 0 },
  }),
);

process.exit(breachedCount > 0 ? 2 : 0);
