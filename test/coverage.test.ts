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
): FunctionInfo {
  return {
    name,
    displayName: name,
    startLine,
    endLine,
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

describe("mapFunctionCoverage", () => {
  const fileEntry = readCoverage(COVERAGE_FIXTURE)["/abs/path/sample.ts"];

  it("maps a function to an executed coverage entry (coverage 1)", () => {
    const fn = makeFunction("plain", 3, 4);
    const result = mapFunctionCoverage(fileEntry, fn);
    expect(result.coverage).toBe(1);
    expect(result.matched).toBe(true);
    expect(result.count).toBe(5);
  });

  it("maps a function to a coverage entry with count 0 (coverage 0)", () => {
    const fn = makeFunction("withIf", 6, 9);
    const result = mapFunctionCoverage(fileEntry, fn);
    expect(result.coverage).toBe(0);
    expect(result.matched).toBe(true);
    expect(result.count).toBe(0);
  });

  it("reports coverage 0 and matched=false for a function with no coverage entry", () => {
    const fn = makeFunction("neverCalled", 100, 101);
    const result = mapFunctionCoverage(fileEntry, fn);
    expect(result.coverage).toBe(0);
    expect(result.matched).toBe(false);
    expect(result.count).toBe(0);
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
      expect(r.count).toBe(0);
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
