import { describe, it, expect } from "vitest";
import { buildReport, buildReportRows, sortRows, renderHumanReport, renderJsonReport } from "../src/report.js";
import type { FunctionCoverage } from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";

function makeFn(
  name: string,
  complexity: number,
  startLine: number,
  endLine: number,
  coverage: number,
  matched = true,
  count = coverage > 0 ? 1 : 0,
): FunctionCoverage {
  const fi: FunctionInfo = {
    name,
    displayName: name,
    startLine,
    endLine,
    startOffset: 0,
    endOffset: 100,
    complexity,
    filePath: `/src/${name}.ts`,
  };
  return { functionInfo: fi, coverage, matched, count };
}

describe("buildReportRows", () => {
  it("computes CRAP per function from complexity and coverage", () => {
    const rows = buildReportRows([
      makeFn("a", 1, 1, 1, 1), // cc1, cov1 -> 1
      makeFn("b", 4, 1, 1, 0), // cc4, cov0 -> 20
    ]);
    expect(rows[0]?.crap).toBe(1);
    expect(rows[1]?.crap).toBe(20);
  });
});

describe("sortRows", () => {
  it("sorts by CRAP descending", () => {
    const rows = buildReportRows([
      makeFn("low", 1, 1, 1, 1),
      makeFn("high", 4, 1, 1, 0),
      makeFn("mid", 2, 1, 1, 0.5),
    ]);
    const sorted = sortRows(rows);
    expect(sorted[0]?.name).toBe("high");
    expect(sorted[2]?.name).toBe("low");
  });

  it("breaks ties by complexity descending then name", () => {
    const rows = buildReportRows([
      makeFn("alpha", 2, 1, 1, 1), // crap=2
      makeFn("beta", 2, 1, 1, 1), // crap=2, same
    ]);
    const sorted = sortRows(rows);
    expect(sorted[0]?.name).toBe("alpha");
    expect(sorted[1]?.name).toBe("beta");
  });
});

describe("buildReport", () => {
  it("produces summary with correct breach detection", () => {
    const report = buildReport(
      [makeFn("ok", 1, 1, 1, 1), makeFn("bad", 4, 1, 1, 0)],
      8,
    );
    expect(report.summary.totalFunctions).toBe(2);
    expect(report.summary.maxCrap).toBe(20);
    expect(report.summary.breachedCount).toBe(1);
    expect(report.summary.breached).toBe(true);
  });

  it("reports not breached when all under threshold", () => {
    const report = buildReport([makeFn("ok", 1, 1, 1, 1)], 8);
    expect(report.summary.breached).toBe(false);
    expect(report.summary.breachedCount).toBe(0);
  });

  it("handles empty input", () => {
    const report = buildReport([], 8);
    expect(report.summary.totalFunctions).toBe(0);
    expect(report.summary.breached).toBe(false);
    expect(report.rows).toEqual([]);
  });
});

describe("renderHumanReport", () => {
  it("renders a readable table with header and summary", () => {
    const report = buildReport(
      [makeFn("ok", 1, 1, 1, 1), makeFn("bad", 4, 1, 1, 0)],
      8,
    );
    const text = renderHumanReport(report);
    expect(text).toContain("CRAP Report");
    expect(text).toContain("Function");
    expect(text).toContain("CRAP");
    expect(text).toContain("bad");
    expect(text).toContain("ok");
    expect(text).toContain("Threshold:");
    expect(text).toContain("FAIL");
    expect(text).toContain("CRAP threshold exceeded");
  });

  it("marks breached rows with !", () => {
    const report = buildReport([makeFn("bad", 4, 1, 1, 0)], 8);
    const text = renderHumanReport(report);
    expect(text).toContain("!bad");
  });

  it("handles empty report gracefully", () => {
    const report = buildReport([], 8);
    const text = renderHumanReport(report);
    expect(text).toContain("No functions found.");
  });
});

describe("renderJsonReport", () => {
  it("renders valid JSON with rows and summary", () => {
    const report = buildReport([makeFn("fn", 2, 1, 1, 0.5)], 8);
    const json = renderJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].name).toBe("fn");
    expect(parsed.summary.totalFunctions).toBe(1);
    expect(parsed.summary.threshold).toBe(8);
  });
});
