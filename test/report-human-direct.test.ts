import * as path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverSourceFiles, analyzeFiles } from "../src/complexity.js";
import { readCoverage, mapAllCoverage } from "../src/coverage.js";
import { buildReport, renderHumanReport } from "../src/report.js";
import type { CrapReport, ReportRow } from "../src/report.js";

/**
 * Direct tests for the human-report rendering extracted from the
 * threshold-8-breaching renderHumanReport (src/report.ts):
 *
 * - renderHumanReport: the header/filter block, the empty-row shortcut,
 *   and the table+summary composition (golden snapshots, byte-exact);
 * - the full self-run over this repository's own source and coverage
 *   file, rebuilt through the same pipeline the CLI uses, pinned on the
 *   stable rendering invariants (exact header and underline, per-row
 *   marker/name/column formatting, and the exact summary block);
 * - strict breach semantics: the "!" marker appears exactly when crap is
 *   strictly greater than the row's applicable threshold;
 * - empty vs non-empty reports, with and without the changed-only filter;
 * - column width floors (name >= 8, file >= 4), width growth, and the
 *   dashed underline exactly as long as the header;
 * - shortenPath boundaries in the rendered file column;
 * - toFixed(1) number formatting for coverage, threshold, max CRAP, and
 *   CRAP;
 * - the summary gate PASS/FAIL spelling and the exceeded note only on a
 *   failed gate.
 *
 * Goldens were generated from the pre-refactor renderHumanReport, so any
 * change to rendered human-report content, ordering, or formatting fails
 * here.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * The self-run golden test needs this repository's V8 coverage output;
 * skip (not fail) in environments where it was not generated yet.
 */
const COVERAGE_FILE = path.join(REPO_ROOT, "coverage/coverage-final.json");
const HAS_COVERAGE = existsSync(COVERAGE_FILE);

// --- Golden values (pre-refactor byte-exact) ---
const GOLDEN_EMPTY_NO_FILTER = "CRAP Report\n===========\n\nNo functions found.\n\nThreshold: 8\nBreached: no";
const GOLDEN_EMPTY_FILTER = "CRAP Report\n===========\nChanged-only mode: since HEAD~1\nMerge base: abc1234\nChanged files: 3\n\nNo eligible changed functions found.\n\nThreshold: 8\nBreached: no";
const GOLDEN_EMPTY_THRESHOLD_DECIMAL = "CRAP Report\n===========\n\nNo functions found.\n\nThreshold: 8.5\nBreached: no";
const GOLDEN_SINGLE_NO_BREACH = "CRAP Report\n===========\n\nFunction  File         Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------\n fn       /src/fn.ts      1     1   100.0%        8.0       1.0\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      1.0\nBreached:      0 function(s)\nGate:          PASS";
const GOLDEN_SINGLE_BREACH = "CRAP Report\n===========\n\nFunction  File         Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------\n!bad      /src/fn.ts      1     4     0.0%        8.0      20.0\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      20.0\nBreached:      1 function(s)\nGate:          FAIL\n\nCRAP threshold exceeded; see applicable row thresholds above.";
const GOLDEN_WIDE_NAME = "CRAP Report\n===========\n\nFunction          File                      Line    CC      Cov  Threshold      CRAP\n------------------------------------------------------------------------------------\n longFunctionName  /src/fn.ts                   1     1   100.0%        8.0       1.0\n x                .../nested/path/file.ts      1     1   100.0%        8.0       1.0\n\nThreshold:     8\nFunctions:     2\nMax CRAP:      1.0\nBreached:      0 function(s)\nGate:          PASS";
const GOLDEN_SHORTENED_PATH = "CRAP Report\n===========\n\nFunction  File                     Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------------------\n fn       .../lib/deep/module.ts      1     1   100.0%        8.0       1.0\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      1.0\nBreached:      0 function(s)\nGate:          PASS";
const GOLDEN_THREE_SEGMENT_PATH = "CRAP Report\n===========\n\nFunction  File           Line    CC      Cov  Threshold      CRAP\n-----------------------------------------------------------------\n fn       .../a/b/c.ts      1     1   100.0%        8.0       1.0\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      1.0\nBreached:      0 function(s)\nGate:          PASS";
const GOLDEN_TWO_SEGMENT_PATH = "CRAP Report\n===========\n\nFunction  File     Line    CC      Cov  Threshold      CRAP\n-----------------------------------------------------------\n fn       a/b.ts      1     1   100.0%        8.0       1.0\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      1.0\nBreached:      0 function(s)\nGate:          PASS";
const GOLDEN_BREACH_FILTER = "CRAP Report\n===========\nChanged-only mode: since HEAD~1\nMerge base: abc1234\nChanged files: 3\n\nFunction  File         Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------\n!bad      /src/fn.ts      1     4     0.0%        8.0      20.0\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      20.0\nBreached:      1 function(s)\nGate:          FAIL\n\nCRAP threshold exceeded; see applicable row thresholds above.";
const GOLDEN_DECIMAL_NUMBERS = "CRAP Report\n===========\n\nFunction  File         Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------\n a        /src/fn.ts      1     3    33.3%        8.0       7.7\n!b        /src/fn.ts      1     2    50.0%        8.0       8.5\n\nThreshold:     8\nFunctions:     2\nMax CRAP:      8.5\nBreached:      1 function(s)\nGate:          FAIL\n\nCRAP threshold exceeded; see applicable row thresholds above.";
const GOLDEN_MIXED_ROWS = "CRAP Report\n===========\n\nFunction  File         Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------\n ok-one   /src/fn.ts     10     2   100.0%        8.0       2.0\n!boom     /src/fn.ts     20     5    10.0%       12.0     135.1\n edge     /src/fn.ts     30     3   100.0%        3.0       3.0\n\nThreshold:     12\nFunctions:     3\nMax CRAP:      135.1\nBreached:      1 function(s)\nGate:          FAIL\n\nCRAP threshold exceeded; see applicable row thresholds above.";
const GOLDEN_BIG_NUMBERS = "CRAP Report\n===========\n\nFunction  File         Line    CC      Cov  Threshold      CRAP\n---------------------------------------------------------------\n!big      /src/fn.ts  123456   123     0.5%        8.0   15187.6\n\nThreshold:     8\nFunctions:     1\nMax CRAP:      15187.6\nBreached:      1 function(s)\nGate:          FAIL\n\nCRAP threshold exceeded; see applicable row thresholds above.";

/**
 * Rebuild the same report object the CLI self-run renders: discover this
 * repository's own source, map the coverage file, and build the threshold-8
 * report through the same pipeline the CLI uses.
 */
function selfRunReport(): CrapReport {
  const files = discoverSourceFiles([path.join(REPO_ROOT, "src")]);
  const coverage = readCoverage(
    path.join(REPO_ROOT, "coverage/coverage-final.json"),
  );
  return buildReport(
    mapAllCoverage(analyzeFiles(files), coverage),
    8,
  );
}

function row(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    name: "fn",
    displayName: "fn",
    filePath: "/src/fn.ts",
    startLine: 1,
    endLine: 2,
    complexity: 1,
    coverage: 1,
    crap: 1,
    coverageMatched: true,
    totalStatements: 1,
    coveredStatements: 1,
    threshold: 8,
    ...overrides,
  };
}

function report(
  rows: ReportRow[],
  threshold: number,
  maxCrap: number,
  breachedCount: number,
  filter?: CrapReport["filter"],
): CrapReport {
  return {
    rows,
    ...(filter === undefined ? {} : { filter }),
    summary: {
      totalFunctions: rows.length,
      breachedCount,
      maxCrap,
      threshold,
      breached: breachedCount > 0,
    },
  };
}

const CHANGE_FILTER: NonNullable<CrapReport["filter"]> = {
  mode: "changed",
  changedSince: "HEAD~1",
  mergeBase: "abc1234",
  changedFileCount: 3,
};

describe("renderHumanReport golden snapshots", () => {
  it.skipIf(!HAS_COVERAGE)("renders the full self-run report with the stable rendering invariants", () => {
    const report = selfRunReport();
    const lines = renderHumanReport(report).split("\n");

    // Exact header block, then the column header and the dashed
    // underline at exactly the header's length (any column widths).
    expect(lines[0]).toBe("CRAP Report");
    expect(lines[1]).toBe("===========");
    const headerIndex = lines.findIndex((line) => line.startsWith("Function"));
    expect(headerIndex).toBeGreaterThan(0);
    expect(lines[headerIndex + 1]).toBe("-".repeat(lines[headerIndex].length));

    // One data row per report row, in report order, with the exact
    // breach marker, padded display name, and formatted Line / CC /
    // Threshold / CRAP columns.
    const nameW = Math.max(8, ...report.rows.map((r) => r.displayName.length));
    for (let i = 0; i < report.rows.length; i++) {
      const dataLine = lines[headerIndex + 2 + i];
      const row = report.rows[i];
      const marker = row.crap > row.threshold ? "!" : " ";
      // The Function cell is the marker plus the display name padded to
      // nameW; a breached row whose name is already the widest overflows
      // by exactly the marker (pre-existing rendering behavior).
      const cell = (marker + row.displayName).padEnd(nameW);
      expect(dataLine.startsWith(cell + "  ")).toBe(true);
      expect(dataLine).toContain(String(row.startLine));
      expect(dataLine).toContain(String(row.complexity));
      expect(dataLine).toContain(row.threshold.toFixed(1));
      expect(dataLine).toContain(row.crap.toFixed(1));
    }

    // Exact trailing summary block: the non-empty summary with the gate,
    // and the exceeded note only when the gate failed.
    let thresholdLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith("Threshold:     ")) {
        thresholdLineIndex = i;
        break;
      }
    }
    expect(thresholdLineIndex).toBeGreaterThan(0);
    const expectedSummary = [
      `Threshold:     ${report.summary.threshold}`,
      `Functions:     ${report.summary.totalFunctions}`,
      `Max CRAP:      ${report.summary.maxCrap.toFixed(1)}`,
      `Breached:      ${report.summary.breachedCount} function(s)`,
      `Gate:          ${report.summary.breached ? "FAIL" : "PASS"}`,
    ];
    if (report.summary.breached) {
      expectedSummary.push(
        "",
        "CRAP threshold exceeded; see applicable row thresholds above.",
      );
    }
    expect(lines.slice(thresholdLineIndex)).toEqual(expectedSummary);
  });

  it("renders an empty report without a filter", () => {
    expect(renderHumanReport(report([], 8, 0, 0))).toBe(GOLDEN_EMPTY_NO_FILTER);
  });

  it("renders an empty report with the changed-only filter", () => {
    expect(renderHumanReport(report([], 8, 0, 0, CHANGE_FILTER))).toBe(
      GOLDEN_EMPTY_FILTER,
    );
  });

  it("renders an empty report with a fractional summary threshold", () => {
    expect(renderHumanReport(report([], 8.5, 0, 0))).toBe(
      GOLDEN_EMPTY_THRESHOLD_DECIMAL,
    );
  });

  it("renders a single non-breaching row", () => {
    expect(renderHumanReport(report([row()], 8, 1, 0))).toBe(GOLDEN_SINGLE_NO_BREACH);
  });

  it("renders a single breaching row with the ! marker", () => {
    expect(
      renderHumanReport(
        report([row({ displayName: "bad", complexity: 4, coverage: 0, crap: 20 })], 8, 20, 1),
      ),
    ).toBe(GOLDEN_SINGLE_BREACH);
  });

  it("grows the Function column for wide names and shortens deep paths", () => {
    expect(
      renderHumanReport(
        report(
          [
            row({ displayName: "longFunctionName" }),
            row({ displayName: "x", filePath: "/a/very/deep/nested/path/file.ts" }),
          ],
          8,
          1,
          0,
        ),
      ),
    ).toBe(GOLDEN_WIDE_NAME);
  });

  it("shortens file paths longer than three segments to the last three", () => {
    expect(
      renderHumanReport(
        report([row({ filePath: "/home/user/projects/demo/src/lib/deep/module.ts" })], 8, 1, 0),
      ),
    ).toBe(GOLDEN_SHORTENED_PATH);
  });

  it("keeps exactly three path segments un-shortened", () => {
    expect(renderHumanReport(report([row({ filePath: "/a/b/c.ts" })], 8, 1, 0))).toBe(
      GOLDEN_THREE_SEGMENT_PATH,
    );
  });

  it("keeps two path segments un-shortened", () => {
    expect(renderHumanReport(report([row({ filePath: "a/b.ts" })], 8, 1, 0))).toBe(
      GOLDEN_TWO_SEGMENT_PATH,
    );
  });

  it("combines the changed-only filter with a breaching table", () => {
    expect(
      renderHumanReport(
        report([row({ displayName: "bad", complexity: 4, coverage: 0, crap: 20 })], 8, 20, 1, CHANGE_FILTER),
      ),
    ).toBe(GOLDEN_BREACH_FILTER);
  });

  it("formats fractional coverage, threshold, and CRAP with toFixed(1)", () => {
    expect(
      renderHumanReport(
        report(
          [
            row({ displayName: "a", complexity: 3, coverage: 0.333, crap: 7.66 }),
            row({ displayName: "b", complexity: 2, coverage: 0.5, crap: 8.5, threshold: 8 }),
          ],
          8,
          8.5,
          1,
        ),
      ),
    ).toBe(GOLDEN_DECIMAL_NUMBERS);
  });

  it("preserves row order and marks only strictly-breaching rows", () => {
    expect(
      renderHumanReport(
        report(
          [
            row({ displayName: "ok-one", complexity: 2, coverage: 1, crap: 2, startLine: 10 }),
            row({ displayName: "boom", complexity: 5, coverage: 0.1, crap: 135.05, startLine: 20, threshold: 12 }),
            row({ displayName: "edge", complexity: 3, coverage: 1, crap: 3, startLine: 30, threshold: 3 }),
          ],
          12,
          135.05,
          1,
        ),
      ),
    ).toBe(GOLDEN_MIXED_ROWS);
  });

  it("pads large line numbers and scores", () => {
    expect(
      renderHumanReport(
        report(
          [
            row({
              displayName: "big",
              startLine: 123456,
              complexity: 123,
              coverage: 0.005,
              crap: 15187.6,
              threshold: 8,
            }),
          ],
          8,
          15187.6,
          1,
        ),
      ),
    ).toBe(GOLDEN_BIG_NUMBERS);
  });
});

describe("renderHumanReport extracted helper behaviors", () => {
  it("marks breach strictly: crap > threshold, never crap === threshold", () => {
    const breach = renderHumanReport(report([row({ crap: 9, threshold: 8 })], 8, 9, 1));
    const equal = renderHumanReport(report([row({ crap: 8, threshold: 8 })], 8, 8, 0));
    const under = renderHumanReport(report([row({ crap: 7.9, threshold: 8 })], 8, 7.9, 0));
    expect(breach).toContain("!fn");
    expect(equal).toContain(" fn");
    expect(equal).not.toContain("!fn");
    expect(under).toContain(" fn");
    expect(under).not.toContain("!fn");
  });

  it("keeps the empty-report summary YES/no breached spelling", () => {
    expect(renderHumanReport(report([], 8, 0, 1))).toContain("Breached: YES");
    expect(renderHumanReport(report([], 8, 0, 0))).toContain("Breached: no");
  });

  it("passes the gate without the exceeded note and fails it with the note", () => {
    const pass = renderHumanReport(report([row()], 8, 1, 0));
    expect(pass).toContain("Gate:          PASS");
    expect(pass).not.toContain("CRAP threshold exceeded");
    const fail = renderHumanReport(
      report([row({ displayName: "bad", complexity: 4, coverage: 0, crap: 20 })], 8, 20, 1),
    );
    expect(fail).toContain("Gate:          FAIL");
    expect(fail).toContain("CRAP threshold exceeded; see applicable row thresholds above.");
  });

  it("keeps the dashed underline exactly as long as the header", () => {
    const lines = renderHumanReport(report([row()], 8, 1, 0)).split("\n");
    const headerIndex = lines.findIndex((line) => line.startsWith("Function"));
    expect(headerIndex).toBeGreaterThan(0);
    const header = lines[headerIndex];
    expect(lines[headerIndex + 1]).toBe("-".repeat(header.length));
  });

  it("distinguishes the empty unfiltered message from the changed-only one", () => {
    const unfiltered = renderHumanReport(report([], 8, 0, 0));
    const filtered = renderHumanReport(report([], 8, 0, 0, CHANGE_FILTER));
    expect(unfiltered).toContain("No functions found.");
    expect(unfiltered).not.toContain("No eligible changed functions found.");
    expect(filtered).toContain("No eligible changed functions found.");
    expect(filtered).not.toContain("No functions found.");
  });

  it("renders deterministically with no shared state across reports", () => {
    const first = report([row({ displayName: "one" })], 8, 1, 0);
    const second = report([row({ displayName: "two" })], 8, 1, 0);
    const firstOnce = renderHumanReport(first);
    const secondOnce = renderHumanReport(second);
    const firstAgain = renderHumanReport(first);
    expect(firstOnce).toBe(firstAgain);
    expect(firstOnce).not.toBe(secondOnce);
  });
});
