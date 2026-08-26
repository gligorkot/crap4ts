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

  const prefix = lines.join("\n");
  if (report.rows.length === 0) {
    return `${prefix}\n${renderHumanEmptyBody(report)}\n\n${renderHumanSummary(report)}`;
  }

  return `${prefix}\n${renderHumanTable(report)}\n\n${renderHumanSummary(report)}`;
}

/**
 * The body of an empty human report: the row set is absent, so only the
 * no-functions message is rendered before the summary.
 */
function renderHumanEmptyBody(report: CrapReport): string {
  return report.filter === undefined
    ? "No functions found."
    : "No eligible changed functions found.";
}

/**
 * The column header row of the human table.
 */
function renderHumanHeader(nameW: number, fileW: number): string {
  return (
    `${"Function".padEnd(nameW)}  ` +
    `${"File".padEnd(fileW)}  ` +
    `${"Line".padStart(5)}  ` +
    `${"CC".padStart(4)}  ` +
    `${"Cov".padStart(7)}  ` +
    `${"Threshold".padStart(9)}  ` +
    `${"CRAP".padStart(8)}`
  );
}

/**
 * One data row of the human table. Breached rows (crap strictly greater
 * than the row's applicable threshold) carry the leading `!` marker.
 */
function renderHumanRow(row: ReportRow, nameW: number, fileW: number): string {
  const marker = row.crap > row.threshold ? "!" : " ";
  return (
    `${(marker + row.displayName).padEnd(nameW)}  ` +
    `${shortenPath(row.filePath).padEnd(fileW)}  ` +
    `${String(row.startLine).padStart(5)}  ` +
    `${String(row.complexity).padStart(4)}  ` +
    `${formatPct(row.coverage).padStart(7)}  ` +
    `${row.threshold.toFixed(1).padStart(9)}  ` +
    `${row.crap.toFixed(1).padStart(8)}`
  );
}

/**
 * The full data table of the human report: column header, dashed
 * underline, and one padded row per function in report order.
 */
function renderHumanTable(report: CrapReport): string {
  // Column widths
  const nameW = Math.max(8, ...report.rows.map((r) => r.displayName.length));
  const fileW = Math.max(4, ...report.rows.map((r) => shortenPath(r.filePath).length));

  const header = renderHumanHeader(nameW, fileW);
  const lines: string[] = [];
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const row of report.rows) {
    lines.push(renderHumanRow(row, nameW, fileW));
  }
  return lines.join("\n");
}

/**
 * The trailing summary block of the human report. Empty reports show only
 * the threshold and breached state; non-empty reports add the function
 * count, max CRAP, and gate, plus the exceeded note when the gate fails.
 */
function renderHumanSummary(report: CrapReport): string {
  const lines: string[] = [];
  if (report.rows.length === 0) {
    lines.push(`Threshold: ${report.summary.threshold}`);
    lines.push(`Breached: ${report.summary.breached ? "YES" : "no"}`);
    return lines.join("\n");
  }

  lines.push(`Threshold:     ${report.summary.threshold}`);
  lines.push(`Functions:     ${report.summary.totalFunctions}`);
  lines.push(`Max CRAP:      ${report.summary.maxCrap.toFixed(1)}`);
  lines.push(`Breached:      ${report.summary.breachedCount} function(s)`);
  lines.push(`Gate:          ${report.summary.breached ? "FAIL" : "PASS"}`);

  if (report.summary.breached) {
    lines.push("");
    lines.push("CRAP threshold exceeded; see applicable row thresholds above.");
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

/**
 * Render an untrusted value as a literal inline code span that cannot be
 * broken out of or used to inject HTML:
 *
 * - replace control characters (including CR/LF/TAB) with spaces so the
 *   value can never start a new line or block;
 * - choose a backtick delimiter strictly longer than the longest embedded
 *   backtick run, so no sequence inside the value can close the span early.
 */
export function literalCode(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  let longestRun = 0;
  for (const match of cleaned.match(/`+/g) ?? []) {
    if (match.length > longestRun) longestRun = match.length;
  }
  const fence = "`".repeat(longestRun + 1);
  // Pad with spaces so boundary backticks cannot fuse with the delimiters.
  return `${fence} ${cleaned} ${fence}`;
}

/**
 * Render dynamic table content safely without making ordinary TypeScript names
 * and paths visually noisy. Common function/path characters are plain text;
 * values containing Markdown/HTML syntax become literal code instead.
 *
 * Pipes are always escaped because GitHub parses them as table-cell boundaries
 * even when they appear inside an inline code span. Control characters cannot
 * create a new row or block.
 */
function isPlainTableText(value: string): boolean {
  if (!/^[A-Za-z0-9._/ -]+$/.test(value)) return false;
  // GFM extended autolinks `www.*` and treats underscore-delimited text as
  // emphasis/strong. Keep ordinary `normal_name` readable, but route forms
  // that can change rendered meaning through the literal-code path.
  if (/www\./i.test(value)) return false;
  if (/\b[0-9a-f]{7,40}\b/i.test(value)) return false;
  if (/gh-\d+/i.test(value)) return false;
  return !/(^|[^A-Za-z0-9])_{1,3}.+_{1,3}($|[^A-Za-z0-9])/.test(value);
}

/** Render a dynamic table cell without permitting GFM interpretation. */
export function escapeCell(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (isPlainTableText(cleaned)) return cleaned;
  const escaped = cleaned.replace(/[!-/:-@[-`{-~]/g, "\\$&");
  return literalCode(escaped);
}

/** Options that control optional Markdown report detail. */
export interface MarkdownReportOptions {
  /** Include the per-function GFM table. Defaults to false. */
  readonly withTable?: boolean;
}

/** Render the optional per-function GFM table in report order. */
function renderMarkdownTable(rows: readonly ReportRow[]): string[] {
  const lines = [
    "| Function | File | Line | CC | Cov | Threshold | CRAP |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
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
  return lines;
}

/**
 * Render a PR-friendly Markdown report. The summary is always included; the
 * per-function table is opt-in so job summaries stay compact by default.
 */
export function renderMarkdownReport(report: CrapReport, options: MarkdownReportOptions = {}): string {
  const { withTable = false } = options;
  const lines: string[] = [];
  lines.push("## CRAP Report");
  lines.push("");
  if (report.filter !== undefined) {
    lines.push(`Changed-only mode: since ${literalCode(report.filter.changedSince)} (merge base ${literalCode(report.filter.mergeBase)}, ${report.filter.changedFileCount} changed file(s))`);
    lines.push("");
  }

  if (report.rows.length === 0) {
    lines.push(report.filter === undefined ? "No functions found." : "No eligible changed functions found.");
    lines.push("");
    lines.push(`**Threshold:** ${report.summary.threshold} · **Breached:** ${report.summary.breached ? "YES" : "no"}`);
    return lines.join("\n");
  }

  lines.push("");
  const gate = report.summary.breached ? "❌ FAIL" : "✅ PASS";
  lines.push(
    `**Threshold:** ${report.summary.threshold} · **Functions:** ${report.summary.totalFunctions}` +
    ` · **Max CRAP:** ${report.summary.maxCrap.toFixed(1)}` +
    ` · **Breached:** ${report.summary.breachedCount} function(s) · **Gate:** ${gate}`,
  );
  lines.push("");

  if (withTable) {
    lines.push(...renderMarkdownTable(report.rows));
  }
  return lines.join("\n");
}
