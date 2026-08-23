import { describe, it, expect } from "vitest";
import {
  formatSelfScoreAudit,
  validateSelfScoreBreach,
  EXPECTED_BREACH_NAMES,
} from "../src/self-score-helpers.js";
import type { SelfScoreReport, SelfScoreRow } from "../src/self-score-helpers.js";

function makeRow(
  name: string,
  crap: number,
  coverage: number,
  matched = false,
): SelfScoreRow {
  return {
    name,
    displayName: name,
    filePath: `/src/${name}.ts`,
    startLine: 1,
    endLine: 10,
    complexity: 5,
    coverage,
    crap,
    coverageMatched: matched,
    totalStatements: coverage > 0 ? 1 : 0,
    coveredStatements: coverage > 0 ? 1 : 0,
    threshold: THRESHOLD,
  };
}

const THRESHOLD = 30;

describe("formatSelfScoreAudit", () => {
  it("prints the maximum score and only the expected breached rows with audit fields", () => {
    const report: SelfScoreReport = {
      rows: [
        makeRow("parseArgs", 50, 0),
        makeRow("main", 45, 0),
        makeRow("computeCrap", 5, 1),
      ],
      summary: {
        totalFunctions: 3,
        breachedCount: 2,
        maxCrap: 50,
        threshold: THRESHOLD,
        breached: true,
      },
    };

    expect(formatSelfScoreAudit(report)).toBe(
      [
        "Self-score audit evidence:",
        "Maximum CRAP score: 50.0.",
        "Expected breached rows:",
        "- parseArgs: CRAP 50.0, coverage 0.0%, threshold 30.0",
        "- main: CRAP 45.0, coverage 0.0%, threshold 30.0",
      ].join("\n"),
    );
  });
});

describe("validateSelfScoreBreach", () => {
  it("passes when parseArgs and main exist, are uncovered, and breach threshold", () => {
    const report: SelfScoreReport = {
      rows: [
        makeRow("parseArgs", 50, 0),
        makeRow("main", 45, 0),
        makeRow("computeCrap", 5, 1),
      ],
      summary: {
        totalFunctions: 3,
        breachedCount: 2,
        maxCrap: 50,
        threshold: THRESHOLD,
        breached: true,
      },
    };
    expect(validateSelfScoreBreach(report, THRESHOLD)).toBeNull();
  });

  it("fails when parseArgs row is missing", () => {
    const report: SelfScoreReport = {
      rows: [makeRow("main", 45, 0)],
      summary: {
        totalFunctions: 1,
        breachedCount: 1,
        maxCrap: 45,
        threshold: THRESHOLD,
        breached: true,
      },
    };
    const err = validateSelfScoreBreach(report, THRESHOLD);
    expect(err).toContain("parseArgs");
    expect(err).toContain("not found");
  });

  it("fails when main row is missing", () => {
    const report: SelfScoreReport = {
      rows: [makeRow("parseArgs", 50, 0)],
      summary: {
        totalFunctions: 1,
        breachedCount: 1,
        maxCrap: 50,
        threshold: THRESHOLD,
        breached: true,
      },
    };
    const err = validateSelfScoreBreach(report, THRESHOLD);
    expect(err).toContain("main");
    expect(err).toContain("not found");
  });

  it("fails when parseArgs does not breach threshold", () => {
    const report: SelfScoreReport = {
      rows: [makeRow("parseArgs", 20, 0), makeRow("main", 45, 0)],
      summary: {
        totalFunctions: 2,
        breachedCount: 1,
        maxCrap: 45,
        threshold: THRESHOLD,
        breached: true,
      },
    };
    const err = validateSelfScoreBreach(report, THRESHOLD);
    expect(err).toContain("parseArgs");
    expect(err).toContain("breach threshold");
  });

  it("fails when parseArgs has coverage > 0 (should be uncovered)", () => {
    const report: SelfScoreReport = {
      rows: [makeRow("parseArgs", 50, 0.5, true), makeRow("main", 45, 0)],
      summary: {
        totalFunctions: 2,
        breachedCount: 2,
        maxCrap: 50,
        threshold: THRESHOLD,
        breached: true,
      },
    };
    const err = validateSelfScoreBreach(report, THRESHOLD);
    expect(err).toContain("parseArgs");
    expect(err).toContain("uncovered");
  });

  it("fails when an unexpected function breaches the threshold", () => {
    const report: SelfScoreReport = {
      rows: [
        makeRow("parseArgs", 50, 0),
        makeRow("main", 45, 0),
        makeRow("mysteryFn", 40, 0),
      ],
      summary: {
        totalFunctions: 3,
        breachedCount: 3,
        maxCrap: 50,
        threshold: THRESHOLD,
        breached: true,
      },
    };
    const err = validateSelfScoreBreach(report, THRESHOLD);
    expect(err).toContain("Unexpected threshold breach");
    expect(err).toContain("mysteryFn");
  });

  it("fails when expected functions exist but don't breach (high threshold)", () => {
    const report: SelfScoreReport = {
      rows: [makeRow("parseArgs", 10, 0), makeRow("main", 10, 0)],
      summary: {
        totalFunctions: 2,
        breachedCount: 0,
        maxCrap: 10,
        threshold: 100,
        breached: false,
      },
    };
    const err = validateSelfScoreBreach(report, 100);
    expect(err).not.toBeNull();
    expect(err).toContain("breach threshold");
  });

  it("EXPECTED_BREACH_NAMES contains parseArgs and main", () => {
    expect(EXPECTED_BREACH_NAMES).toContain("parseArgs");
    expect(EXPECTED_BREACH_NAMES).toContain("main");
  });
});
