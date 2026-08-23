/**
 * Coverage reading and function-to-coverage mapping.
 *
 * Reads Istanbul-format coverage JSON (the `coverage-final.json` emitted by
 * Vitest's V8 provider, which converts V8 raw coverage to Istanbul) and maps
 * each analyzed function to a coverage decimal in [0, 1].
 *
 * Mapping strategy: each Istanbul `fnMap` entry carries a `decl` (declaration
 * name span) and `loc` (body span) with 1-based line/column coordinates. For
 * every {@link FunctionInfo} we find the coverage entry whose `loc` line
 * range best overlaps the function's line range. Functions with no matching
 * coverage entry report coverage 0 (they never disappear), per the v1 spec.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FunctionInfo } from "./complexity.js";

/**
 * Coverage for a single function after mapping.
 */
export interface FunctionCoverage {
  readonly functionInfo: FunctionInfo;
  /** Coverage decimal in [0, 1]. 0 when the function was never executed. */
  readonly coverage: number;
  /** True when a coverage entry was matched; false when defaulted to 0. */
  readonly matched: boolean;
  /** Execution count from the coverage report (0 when unmatched). */
  readonly count: number;
}

/** A position in a source file: 1-based line, 0-based column. */
export interface Position {
  readonly line: number;
  readonly column: number | null;
}

/** A line/column range in a source file. */
export interface LocationRange {
  readonly start: Position;
  readonly end: Position;
}

/** Minimal subset of an Istanbul fnMap entry. */
interface IstanbulFnMapEntry {
  readonly name: string;
  readonly decl: LocationRange;
  readonly loc: LocationRange;
}

/** Minimal subset of an Istanbul file coverage entry. */
interface IstanbulFileEntry {
  readonly path: string;
  readonly fnMap: Record<string, IstanbulFnMapEntry>;
  readonly f: Record<string, number>;
}

/** Minimal subset of the Istanbul coverage-final.json top-level object. */
type IstanbulCoverage = Record<string, IstanbulFileEntry>;

/**
 * Read and parse an Istanbul coverage-final.json file.
 *
 * @throws {Error} when the file cannot be read or is not valid JSON with the
 *   expected shape.
 */
export function readCoverage(filePath: string): IstanbulCoverage {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Coverage file ${abs} is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Coverage file ${abs} must be a JSON object`);
  }
  return parsed as IstanbulCoverage;
}

/**
 * Normalize a file path for matching: resolve to absolute and collapse
 * `..`/`.` segments. Does NOT touch the filesystem.
 */
function normalizeFilePath(p: string): string {
  return path.resolve(p);
}

/**
 * Find the Istanbul file entry whose `path` matches `sourcePath`.
 *
 * Matching tries, in order: exact normalized match, then suffix match on path
 * segments (handles absolute-vs-relative mismatches common in coverage reports).
 */
function findFileEntry(
  coverage: IstanbulCoverage,
  sourcePath: string,
): IstanbulFileEntry | null {
  const target = normalizeFilePath(sourcePath);
  const keys = Object.keys(coverage);
  // Exact match.
  for (const key of keys) {
    const entry = coverage[key];
    if (entry === undefined) {
      continue;
    }
    if (normalizeFilePath(entry.path) === target) {
      return entry;
    }
    if (key === target) {
      return entry;
    }
  }
  // Suffix match on segments.
  const targetSegs = target.split(path.sep).filter((s) => s.length > 0);
  let best: IstanbulFileEntry | null = null;
  let bestScore = 0;
  for (const key of keys) {
    const entry = coverage[key];
    if (entry === undefined) {
      continue;
    }
    const candidate = normalizeFilePath(entry.path);
    const candSegs = candidate.split(path.sep).filter((s) => s.length > 0);
    const score = commonSuffixSegments(targetSegs, candSegs);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore > 0 ? best : null;
}

function commonSuffixSegments(a: string[], b: string[]): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let count = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    count++;
    i--;
    j--;
  }
  return count;
}

/**
 * Compute the line overlap between a function's range and a coverage entry's
 * `loc` range. Returns the number of overlapping lines (0 = no overlap).
 */
function lineOverlap(
  fnStart: number,
  fnEnd: number,
  locStart: number,
  locEnd: number,
): number {
  const overlapStart = Math.max(fnStart, locStart);
  const overlapEnd = Math.min(fnEnd, locEnd);
  if (overlapEnd < overlapStart) {
    return 0;
  }
  return overlapEnd - overlapStart + 1;
}

/**
 * Map a single function to its coverage entry.
 *
 * Finds the coverage entry in `fileEntry` whose `loc` line range best overlaps
 * the function's [startLine, endLine] range. When no entry overlaps, returns
 * coverage 0 with `matched: false`.
 */
export function mapFunctionCoverage(
  fileEntry: IstanbulFileEntry,
  fn: FunctionInfo,
): FunctionCoverage {
  let bestKey: string | null = null;
  let bestOverlap = 0;
  let bestCount = 0;

  for (const key of Object.keys(fileEntry.fnMap)) {
    const entry = fileEntry.fnMap[key];
    if (entry === undefined) {
      continue;
    }
    const overlap = lineOverlap(
      fn.startLine,
      fn.endLine,
      entry.loc.start.line,
      entry.loc.end.line,
    );
    const count = fileEntry.f[key];
    if (count === undefined) {
      continue;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestKey = key;
      bestCount = count;
    }
  }

  if (bestKey === null) {
    return {
      functionInfo: fn,
      coverage: 0,
      matched: false,
      count: 0,
    };
  }

  // Coverage: 1 if executed at least once, 0 otherwise.
  // (V8 function coverage is boolean-ish: count > 0 => covered.)
  const coverage = bestCount > 0 ? 1 : 0;
  return {
    functionInfo: fn,
    coverage,
    matched: true,
    count: bestCount,
  };
}

/**
 * Map all functions to their coverage, grouped by file.
 *
 * Functions whose source file has no coverage entry report coverage 0
 * (matched: false). Functions are never dropped from the result.
 *
 * @param functions  - all discovered functions (from complexity analysis)
 * @param coverage  - parsed Istanbul coverage-final.json
 * @returns coverage per function, preserving input order
 */
export function mapAllCoverage(
  functions: FunctionInfo[],
  coverage: IstanbulCoverage,
): FunctionCoverage[] {
  // Group functions by normalized file path for efficient lookup.
  const byFile = new Map<string, FunctionInfo[]>();
  for (const fn of functions) {
    const norm = normalizeFilePath(fn.filePath);
    let bucket = byFile.get(norm);
    if (bucket === undefined) {
      bucket = [];
      byFile.set(norm, bucket);
    }
    bucket.push(fn);
  }

  const results: FunctionCoverage[] = [];
  for (const fn of functions) {
    const fileEntry = findFileEntry(coverage, fn.filePath);
    if (fileEntry === null) {
      results.push({
        functionInfo: fn,
        coverage: 0,
        matched: false,
        count: 0,
      });
      continue;
    }
    results.push(mapFunctionCoverage(fileEntry, fn));
  }
  return results;
}
