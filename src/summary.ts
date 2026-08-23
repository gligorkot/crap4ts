#!/usr/bin/env node
/**
 * Render the Markdown CRAP report into $GITHUB_STEP_SUMMARY from a JSON
 * report file produced by the crap4ts CLI (`--format json`).
 *
 * Usage: node summary.cjs <report.json>
 * Part of the composite GitHub Action's self-contained bundle.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { renderMarkdownReport } from "./report.js";

const jsonPath = process.argv[2];
if (jsonPath === undefined || process.argv[3] !== undefined) {
  process.stderr.write("Error: usage: summary.cjs <report.json>\n");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (error) {
  process.stderr.write(`Error: cannot read report JSON: ${(error as Error).message}\n`);
  process.exit(1);
}

const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary === undefined || summary === "") {
  process.stderr.write("Error: GITHUB_STEP_SUMMARY is not set\n");
  process.exit(1);
}
appendFileSync(summary, renderMarkdownReport(report) + "\n\n");
