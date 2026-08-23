/**
 * CRAP report generation: human-readable and JSON formats.
 *
 * @packageDocumentation
 */

import type { FunctionInfo } from "./complexity.js";
import type { FunctionCoverage } from "./coverage.js";
import type { CrapResult } from "./crap.js";
import { computeCrap } from "./crap.js";

/**
 * A complete report row combining function identity, complexity, coverage,
 * and the computed CRAP score.
 */
export interface ReportRow {
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

/**
 * The full report: all rows sorted by CRAP descending, plus summary stats.
 */
export interface ReportFilter {
  readonly mode: "changed";
  readonly changedSince: string;
  readonly mergeBase: string;
  readonly changedFileCount: number;
}

export interface CrapReport {
  readonly rows: ReportRow[];
  readonly filter?: ReportFilter;
  readonly summary: {
    readonly totalFunctions: number;
    readonly breachedCount: number;
    readonly maxCrap: number;
    readonly threshold: number;
    readonly breached: boolean;
  };
}

/**
 * Build report rows from function coverage mappings, computing CRAP for each.
 */
export function buildReportRows(
  coverage: FunctionCoverage[],
  thresholdForPath: (filePath: string) => number = () => 8,
): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const fc of coverage) {
    const fn = fc.functionInfo;
    const result: CrapResult = computeCrap(fn.complexity, fc.coverage);
    rows.push({
      name: fn.name,
      displayName: fn.displayName,
      filePath: fn.filePath,
      startLine: fn.startLine,
      endLine: fn.endLine,
      complexity: fn.complexity,
      coverage: fc.coverage,
      crap: result.crap,
      coverageMatched: fc.matched,
      totalStatements: fc.totalStatements,
      coveredStatements: fc.coveredStatements,
      threshold: thresholdForPath(fn.filePath),
    });
  }
  return rows;
}

/**
 * Sort rows by CRAP descending. Ties are broken by complexity descending,
 * then by display name for stable ordering.
 */
export function sortRows(rows: ReportRow[]): ReportRow[] {
  return [...rows].sort((a, b) => {
    if (b.crap !== a.crap) return b.crap - a.crap;
    if (b.complexity !== a.complexity) return b.complexity - a.complexity;
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Build the complete CRAP report from function coverage and a threshold.
 */
export function buildReport(
  coverage: FunctionCoverage[],
  threshold: number,
  thresholdForPath: (filePath: string) => number = () => threshold,
  filter?: ReportFilter,
): CrapReport {
  const sorted = sortRows(buildReportRows(coverage, thresholdForPath));
  let maxCrap = 0;
  let breachedCount = 0;
  for (const row of sorted) {
    if (row.crap > maxCrap) {
      maxCrap = row.crap;
    }
    if (row.crap > row.threshold) {
      breachedCount++;
    }
  }
  return {
    rows: sorted,
    ...(filter === undefined ? {} : { filter }),
    summary: {
      totalFunctions: sorted.length,
      breachedCount,
      maxCrap,
      threshold,
      breached: breachedCount > 0,
    },
  };
}

function formatPct(coverage: number): string {
  return `${(coverage * 100).toFixed(1)}%`;
}

/**
 * Render the human-readable report to a string.
 */
export function renderHumanReport(report: CrapReport): string {
  const lines: string[] = [];
  lines.push("CRAP Report");
  lines.push("===========");
  if (report.filter !== undefined) {
    lines.push(`Changed-only mode: since ${report.filter.changedSince}`);
    lines.push(`Merge base: ${report.filter.mergeBase}`);
    lines.push(`Changed files: ${report.filter.changedFileCount}`);
  }
  lines.push("");

  if (report.rows.length === 0) {
    lines.push(report.filter === undefined ? "No functions found." : "No eligible changed functions found.");
    lines.push("");
    lines.push(`Threshold: ${report.summary.threshold}`);
    lines.push(`Breached: ${report.summary.breached ? "YES" : "no"}`);
    return lines.join("\n");
  }

  // Column widths
  const nameW = Math.max(8, ...report.rows.map((r) => r.displayName.length));
  const fileW = Math.max(4, ...report.rows.map((r) => shortenPath(r.filePath).length));

  // Header
  const header =
    `${"Function".padEnd(nameW)}  ` +
    `${"File".padEnd(fileW)}  ` +
    `${"Line".padStart(5)}  ` +
    `${"CC".padStart(4)}  ` +
    `${"Cov".padStart(7)}  ` +
    `${"Threshold".padStart(9)}  ` +
    `${"CRAP".padStart(8)}`;
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const row of report.rows) {
    const breach = row.crap > row.threshold;
    const marker = breach ? "!" : " ";
    const line =
      `${(marker + row.displayName).padEnd(nameW)}  ` +
      `${shortenPath(row.filePath).padEnd(fileW)}  ` +
      `${String(row.startLine).padStart(5)}  ` +
      `${String(row.complexity).padStart(4)}  ` +
      `${formatPct(row.coverage).padStart(7)}  ` +
      `${row.threshold.toFixed(1).padStart(9)}  ` +
      `${row.crap.toFixed(1).padStart(8)}`;
    lines.push(line);
  }

  lines.push("");
  lines.push(`Threshold:     ${report.summary.threshold}`);
  lines.push(`Functions:     ${report.summary.totalFunctions}`);
  lines.push(`Max CRAP:      ${report.summary.maxCrap.toFixed(1)}`);
  lines.push(`Breached:      ${report.summary.breachedCount} function(s)`);
  lines.push(`Gate:          ${report.summary.breached ? "FAIL" : "PASS"}`);

  if (report.summary.breached) {
    lines.push("");
    lines.push(
      "CRAP threshold exceeded; see applicable row thresholds above.",
    );
  }
  return lines.join("\n");
}

function shortenPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

/**
 * Render the JSON report to a string.
 */
export function renderJsonReport(report: CrapReport): string {
  return JSON.stringify(report, null, 2);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Render a PR-friendly Markdown report with a proper table.
 */
export function renderMarkdownReport(report: CrapReport): string {
  const lines: string[] = [];
  lines.push("## CRAP Report");
  lines.push("");
  if (report.filter !== undefined) {
    lines.push(`Changed-only mode: since \`${report.filter.changedSince}\` (merge base \`${report.filter.mergeBase}\`, ${report.filter.changedFileCount} changed file(s))`);
    lines.push("");
  }

  if (report.rows.length === 0) {
    lines.push(report.filter === undefined ? "No functions found." : "No eligible changed functions found.");
    lines.push("");
    lines.push(`**Threshold:** ${report.summary.threshold} · **Breached:** ${report.summary.breached ? "YES" : "no"}`);
    return lines.join("\n");
  }

  lines.push("| Function | File | Line | CC | Cov | Threshold | CRAP |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.rows) {
    const breach = row.crap > row.threshold;
    const name = breach ? `⚠️ ${escapeCell(row.displayName)}` : escapeCell(row.displayName);
    const coverage = `${(row.coverage * 100).toFixed(1)}%`;
    lines.push(
      `| ${name} ` +
      `| ${escapeCell(shortenPath(row.filePath))} ` +
      `| ${row.startLine} ` +
      `| ${row.complexity} ` +
      `| ${coverage} ` +
      `| ${row.threshold.toFixed(1)} ` +
      `| ${row.crap.toFixed(1)} |`,
    );
  }

  lines.push("");
  const gate = report.summary.breached ? "❌ FAIL" : "✅ PASS";
  lines.push(
    `**Threshold:** ${report.summary.threshold} · **Functions:** ${report.summary.totalFunctions}` +
    ` · **Max CRAP:** ${report.summary.maxCrap.toFixed(1)}` +
    ` · **Breached:** ${report.summary.breachedCount} function(s) · **Gate:** ${gate}`,
  );
  return lines.join("\n");
}
