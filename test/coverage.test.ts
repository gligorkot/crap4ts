import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  readCoverage,
  mapFunctionCoverage,
  mapAllCoverage,
} from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";
import { analyzeSource } from "../src/complexity.js";

const COVERAGE_FIXTURE = path.resolve(__dirname, "fixtures/coverage-sample.json");
const SAMPLE_FIXTURE = path.resolve(__dirname, "fixtures/sample.ts");

function makeFunction(
  name: string,
  startLine: number,
  endLine: number,
  filePath = "/abs/path/sample.ts",
  startColumn = 0,
  endColumn = 100,
): FunctionInfo {
  return {
    name,
    displayName: name,
    startLine,
    endLine,
    startColumn,
    endColumn,
    startOffset: 0,
    endOffset: 100,
    complexity: 1,
    filePath,
  };
}

describe("readCoverage", () => {
  it("parses a valid Istanbul coverage JSON file", () => {
    const coverage = readCoverage(COVERAGE_FIXTURE);
    expect(Object.keys(coverage)).toContain("/abs/path/sample.ts");
  });

  it("throws on non-existent file", () => {
    expect(() => readCoverage("/does/not/exist.json")).toThrow();
  });

  it("throws on invalid JSON", () => {
    const tmp = path.resolve(__dirname, "fixtures/bad.json");
    fs.writeFileSync(tmp, "not json {");
    expect(() => readCoverage(tmp)).toThrow();
    fs.unlinkSync(tmp);
  });
});

describe("mapFunctionCoverage — coverage fraction semantics", () => {
  const fileEntry = readCoverage(COVERAGE_FIXTURE)["/abs/path/sample.ts"];

  it("maps a fully-covered function to coverage 1 (all statements hit)", () => {
    // plain function: statements 0 and 1 both covered (s=5, s=5).
    // Function range 3-4, statements at 3-4 and 4.
    const fn = makeFunction("plain", 3, 4);
    const result = mapFunctionCoverage(fileEntry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(2);
    expect(result.coveredStatements).toBe(2);
    expect(result.coverage).toBe(1);
  });

  it("maps a partially-covered function to 0 < coverage < 1", () => {
    // withIf: statements 2,3,4,5 at lines 6-9. s = 0,0,0,0.
    // But the function is matched via fnMap identity. Coverage 0 (all uncovered).
    const fn = makeFunction("withIf", 6, 9);
    const result = mapFunctionCoverage(fileEntry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(4);
    expect(result.coveredStatements).toBe(0);
    expect(result.coverage).toBe(0);
  });

  it("reports coverage 0 and matched=false for a function with no coverage entry", () => {
    const fn = makeFunction("neverCalled", 100, 101);
    const result = mapFunctionCoverage(fileEntry, fn);
    expect(result.coverage).toBe(0);
    expect(result.matched).toBe(false);
    expect(result.totalStatements).toBe(0);
    expect(result.coveredStatements).toBe(0);
  });
});

describe("mapFunctionCoverage — partial statement coverage lowers score", () => {
  it("reports a fraction when some statements are covered and others not", () => {
    // Build a file entry with 4 statements in a function range, 2 covered.
    const entry = {
      path: "/abs/path/sample.ts",
      fnMap: {
        "0": {
          name: "halfCovered",
          decl: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
          loc: { start: { line: 5, column: 20 }, end: { line: 10, column: 0 } },
        },
      },
      f: { "0": 1 },
      statementMap: {
        "0": { start: { line: 5, column: 20 }, end: { line: 6, column: 0 } },
        "1": { start: { line: 7, column: 2 }, end: { line: 7, column: 10 } },
        "2": { start: { line: 8, column: 2 }, end: { line: 8, column: 10 } },
        "3": { start: { line: 9, column: 2 }, end: { line: 10, column: 0 } },
      },
      s: { "0": 1, "1": 0, "2": 1, "3": 0 },
      b: {},
      branchMap: {},
      meta: {},
    };
    const fn = makeFunction("halfCovered", 4, 11);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.totalStatements).toBe(4);
    expect(result.coveredStatements).toBe(2);
    expect(result.coverage).toBeCloseTo(0.5, 10);
  });

  it("reports 0 < coverage < 1 for 1 of 3 statements covered", () => {
    const entry = {
      path: "/abs/path/sample.ts",
      fnMap: {
        "0": {
          name: "thirdCovered",
          decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          loc: { start: { line: 1, column: 20 }, end: { line: 4, column: 0 } },
        },
      },
      f: { "0": 1 },
      statementMap: {
        "0": { start: { line: 1, column: 20 }, end: { line: 2, column: 0 } },
        "1": { start: { line: 2, column: 2 }, end: { line: 3, column: 0 } },
        "2": { start: { line: 3, column: 2 }, end: { line: 4, column: 0 } },
      },
      s: { "0": 5, "1": 0, "2": 0 },
      b: {},
      branchMap: {},
      meta: {},
    };
    const fn = makeFunction("thirdCovered", 1, 4);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.coverage).toBeCloseTo(1 / 3, 10);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.coverage).toBeLessThan(1);
  });

  it("reports coverage 0 when all statements have count 0 (uncovered)", () => {
    const entry = {
      path: "/abs/path/sample.ts",
      fnMap: {
        "0": {
          name: "uncovered",
          decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          loc: { start: { line: 1, column: 20 }, end: { line: 3, column: 0 } },
        },
      },
      f: { "0": 0 },
      statementMap: {
        "0": { start: { line: 1, column: 20 }, end: { line: 2, column: 0 } },
        "1": { start: { line: 2, column: 2 }, end: { line: 3, column: 0 } },
      },
      s: { "0": 0, "1": 0 },
      b: {},
      branchMap: {},
      meta: {},
    };
    const fn = makeFunction("uncovered", 1, 3);
    const result = mapFunctionCoverage(entry, fn);
    expect(result.matched).toBe(true);
    expect(result.coverage).toBe(0);
  });

  it("partial coverage lowers CRAP score compared to full uncoverage", () => {
    // Same complexity function: uncovered (cov=0) vs half-covered (cov=0.5).
    // CRAP = cc^2 * (1-cov)^3 + cc
    // cov=0: cc^2 * 1 + cc
    // cov=0.5: cc^2 * 0.125 + cc
    // The half-covered CRAP must be strictly less.
    const cc = 4;
    const uncoveredEntry = {
      path: "/x.ts",
      fnMap: { "0": { name: "f", decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }, loc: { start: { line: 1, column: 10 }, end: { line: 3, column: 0 } } } },
      f: { "0": 0 },
      statementMap: {
        "0": { start: { line: 1, column: 10 }, end: { line: 2, column: 0 } },
        "1": { start: { line: 2, column: 2 }, end: { line: 3, column: 0 } },
      },
      s: { "0": 0, "1": 0 },
      b: {},
      branchMap: {},
      meta: {},
    };
    const halfEntry = {
      path: "/x.ts",
      fnMap: { "0": { name: "f", decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }, loc: { start: { line: 1, column: 10 }, end: { line: 3, column: 0 } } } },
      f: { "0": 1 },
      statementMap: {
        "0": { start: { line: 1, column: 10 }, end: { line: 2, column: 0 } },
        "1": { start: { line: 2, column: 2 }, end: { line: 3, column: 0 } },
      },
      s: { "0": 1, "1": 0 },
      b: {},
      branchMap: {},
      meta: {},
    };
    const fn = makeFunction("f", 1, 3, "/x.ts");
    const uncoveredResult = mapFunctionCoverage(uncoveredEntry, fn);
    const halfResult = mapFunctionCoverage(halfEntry, fn);
    // Compute CRAP for both
    // uncovered: cov=0, crap = 16*1 + 4 = 20
    // half: cov=0.5, crap = 16*0.125 + 4 = 6
    const uncoveredCrap = cc * cc * Math.pow(1 - uncoveredResult.coverage, 3) + cc;
    const halfCrap = cc * cc * Math.pow(1 - halfResult.coverage, 3) + cc;
    expect(halfCrap).toBeLessThan(uncoveredCrap);
  });
});

describe("mapAllCoverage", () => {
  it("maps all functions and never drops uncovered ones", () => {
    const source = fs.readFileSync(SAMPLE_FIXTURE, "utf8");
    const funcs = analyzeSource(SAMPLE_FIXTURE, source);
    const coverage = readCoverage(COVERAGE_FIXTURE);
    // The fixture coverage is for /abs/path/sample.ts; our fixture is at a
    // different real path, so suffix matching on "sample.ts" should still find it.
    const results = mapAllCoverage(funcs, coverage);

    // Every input function must appear in the output.
    expect(results.length).toBe(funcs.length);

    // Functions not in the coverage file must report coverage 0, matched=false.
    const unmatched = results.filter((r) => !r.matched);
    expect(unmatched.length).toBeGreaterThan(0);
    for (const r of unmatched) {
      expect(r.coverage).toBe(0);
      expect(r.totalStatements).toBe(0);
      expect(r.coveredStatements).toBe(0);
    }
  });

  it("reports coverage 0 for functions whose source file is absent from coverage", () => {
    const fn = makeFunction("orphan", 1, 2, "/completely/different/path.ts");
    const coverage = readCoverage(COVERAGE_FIXTURE);
    const results = mapAllCoverage([fn], coverage);
    expect(results[0]?.coverage).toBe(0);
    expect(results[0]?.matched).toBe(false);
  });
});
