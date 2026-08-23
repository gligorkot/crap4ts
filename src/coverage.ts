/**
 * Coverage reading and function-to-coverage mapping.
 *
 * Reads Istanbul-format coverage JSON (the `coverage-final.json` emitted by
 * Vitest's V8 provider, which converts V8 raw coverage to Istanbul) and maps
 * each analyzed function to a coverage decimal in [0, 1].
 *
 * v1 coverage semantics — **executed / not-executed function hit coverage**:
 * Each function is matched to an Istanbul `fnMap` entry by containment: the
 * function's [startLine, endLine] range must be fully within the entry's `loc`
 * line range, and exactly one entry must contain it (ambiguous matches are
 * rejected). Coverage is then boolean: `count > 0` => covered (1), else
 * uncovered (0). Functions with no unambiguous matching entry report coverage
 * 0 (matched: false). This is **not** statement or branch coverage — it only
 * records whether a function was entered at least once.
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
 * Matching tries, in order: exact normalized match, then unambiguous suffix
 * match on path segments (handles absolute-vs-relative mismatches common in
 * coverage reports). A suffix match is only accepted when exactly one coverage
 * entry shares that suffix — if two or more entries match the same suffix,
 * the match is ambiguous and rejected (returns null).
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
  // Suffix match on segments — only accept an unambiguous match.
  const targetSegs = target.split(path.sep).filter((s) => s.length > 0);
  const candidates: IstanbulFileEntry[] = [];
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
      candidates.length = 0;
      candidates.push(entry);
    } else if (score === bestScore && score > 0) {
      candidates.push(entry);
    }
  }
  // Only accept the suffix match when exactly one candidate has the best score.
  if (candidates.length === 1 && bestScore > 0) {
    return candidates[0]!;
  }
  return null;
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
 * Map a single function to its coverage entry using containment-only matching.
 *
 * The function's [startLine, endLine] range must be **fully contained** within
 * a coverage entry's `loc` line range (loc.start.line <= fn.startLine AND
 * loc.end.line >= fn.endLine). Partial overlaps are NOT sufficient, because a
 * partial overlap cannot determine whether the coverage entry describes this
 * function or a neighbouring one.
 *
 * When exactly one entry contains the function, that entry is used. When zero
 * entries contain the function, returns coverage 0 with `matched: false`. When
 * two or more entries contain the function (ambiguous), returns `matched:
 * false` — we cannot safely determine which entry applies, so we report
 * "not executed" rather than guessing.
 */
export function mapFunctionCoverage(
  fileEntry: IstanbulFileEntry,
  fn: FunctionInfo,
): FunctionCoverage {
  let bestKey: string | null = null;
  let bestCount = 0;
  let matchCount = 0;

  for (const key of Object.keys(fileEntry.fnMap)) {
    const entry = fileEntry.fnMap[key];
    if (entry === undefined) {
      continue;
    }
    const count = fileEntry.f[key];
    if (count === undefined) {
      continue;
    }
    // Containment check: the function's line range must be fully within the
    // coverage loc's line range.
    if (
      entry.loc.start.line <= fn.startLine &&
      entry.loc.end.line >= fn.endLine
    ) {
      matchCount++;
      bestKey = key;
      bestCount = count;
    }
  }

  // Ambiguous: two or more entries contain this function's range. We cannot
  // safely determine which coverage entry applies, so report unmatched.
  if (matchCount !== 1) {
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
