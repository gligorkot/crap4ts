/**
 * Coverage reading and function-to-coverage mapping.
 *
 * Reads Istanbul-format coverage JSON (the `coverage-final.json` emitted by
 * Vitest's V8 provider, which converts V8 raw coverage to Istanbul) and maps
 * each analyzed function to a coverage decimal in [0, 1].
 *
 * v1 coverage semantics — **per-function statement coverage fraction**:
 *
 * Each function is matched to an Istanbul file entry by an unambiguous
 * project-relative path match (exact normalized, or anchored suffix — never
 * basename-only). Within the matched file, the function is associated to the
 * fnMap entry whose `loc` is contained within the function's line+column
 * range and is the most specific (smallest containing loc). This is used
 * only for identity association; coverage is NOT derived from the fnMap
 * boolean hit (`f[id] > 0`).
 *
 * Coverage is derived from Istanbul `statementMap` / `s` data: the fraction
 * of statements whose ranges fall within the function's line+column source
 * range that were executed at least once. This mirrors the core invariant of
 * the reference implementations:
 * - Java/JaCoCo: covered instructions / total instructions per method
 * - Go: covered coverage statements / total statements in the function range
 * - Clojure: covered forms / total forms in the function range
 *
 * Partial execution produces 0 < coverage < 1. An uncovered function (all
 * statements have count 0) reports coverage 0. A function with no matching
 * statements (e.g. unmatched, or only declarations) reports coverage 0 with
 * `matched: false`. A function fully executed reports coverage 1.
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
  /** True when coverage data was matched and statements found; false when defaulted to 0. */
  readonly matched: boolean;
  /** Total statements in the function's source range (0 when unmatched). */
  readonly totalStatements: number;
  /** Covered statements in the function's source range (0 when unmatched). */
  readonly coveredStatements: number;
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

/** Minimal subset of an Istanbul statementMap entry. */
interface IstanbulStatementMapEntry {
  readonly start: Position;
  readonly end: Position;
}

/** Minimal subset of an Istanbul file coverage entry. */
interface IstanbulFileEntry {
  readonly path: string;
  readonly fnMap: Record<string, IstanbulFnMapEntry>;
  readonly f: Record<string, number>;
  readonly statementMap?: Record<string, IstanbulStatementMapEntry>;
  readonly s?: Record<string, number>;
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
 * `..`/`.` segments. Forward-slash normalization for cross-platform matching.
 * Does NOT touch the filesystem.
 */
function normalizeFilePath(p: string): string {
  return path.resolve(p).split(path.sep).join("/");
}

/**
 * Split a normalized path into its segment components, filtering empties.
 */
function pathSegments(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/**
 * Count the number of trailing path segments shared by `a` and `b`
 * (common suffix). Returns 0 when the last segment differs.
 */
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
 * Find the Istanbul file entry whose `path` matches `sourcePath`.
 *
 * Matching tries, in order:
 * 1. Exact normalized match (source path resolves to the same absolute path
 *    as a coverage entry's `path` or top-level key).
 * 2. Anchored project-relative suffix match — the coverage entry's path ends
 *    with the same segments as the source path, AND the match is unambiguous
 *    (exactly one entry shares that suffix). This handles absolute-vs-relative
 *    path mismatches common in coverage reports.
 *
 * Basename-only matches (a single shared filename segment) are NOT accepted
 * when the source path has more segments — the match must include at least
 * the source's full relative path. If two or more entries share the best
 * suffix, the match is ambiguous and rejected (returns null).
 */
function findFileEntry(
  coverage: IstanbulCoverage,
  sourcePath: string,
): IstanbulFileEntry | null {
  const target = normalizeFilePath(sourcePath);
  const keys = Object.keys(coverage);

  // Exact match on resolved path or top-level key.
  for (const key of keys) {
    const entry = coverage[key];
    if (entry === undefined) {
      continue;
    }
    if (normalizeFilePath(entry.path) === target) {
      return entry;
    }
    if (normalizeFilePath(key) === target) {
      return entry;
    }
  }

  // Anchored suffix match on path segments — only accept an unambiguous match.
  const targetSegs = pathSegments(target);
  // Require at least 2 segments (directory + filename) to reject basename-only.
  if (targetSegs.length < 2) {
    return null;
  }
  const candidates: IstanbulFileEntry[] = [];
  let bestScore = 0;
  for (const key of keys) {
    const entry = coverage[key];
    if (entry === undefined) {
      continue;
    }
    const candSegs = pathSegments(normalizeFilePath(entry.path));
    const score = commonSuffixSegments(targetSegs, candSegs);
    if (score > bestScore) {
      bestScore = score;
      candidates.length = 0;
      candidates.push(entry);
    } else if (score === bestScore && score > 0) {
      candidates.push(entry);
    }
  }
  // Only accept when exactly one candidate has the best score, and the suffix
  // covers the full target relative path (bestScore === targetSegs.length),
  // ensuring an anchored project-relative match, not a basename-only match.
  if (candidates.length === 1 && bestScore >= targetSegs.length) {
    return candidates[0]!;
  }
  return null;
}

/**
 * Compare a source function range to a coverage loc range using line+column
 * for precise containment checking.
 *
 * Returns:
 * -  1  if `loc` is fully contained within `fn` (fn.start <= loc.start AND
 *        fn.end >= loc.end, using line then column for tie-breaking)
 * -  0  if ranges are identical
 * - -1  if `loc` is NOT contained within `fn`
 */
function locContainedInFn(
  fn: FunctionInfo,
  locStart: Position,
  locEnd: Position,
): boolean {
  // Start check: fn.start must be <= loc.start (line, then column)
  const startLineOk = fn.startLine < locStart.line ||
    (fn.startLine === locStart.line &&
      fn.startColumn <= (locStart.column ?? 0));
  // End check: fn.end must be >= loc.end (line, then column)
  const endLineOk = fn.endLine > locEnd.line ||
    (fn.endLine === locEnd.line &&
      fn.endColumn >= (locEnd.column ?? 0));
  return startLineOk && endLineOk;
}

/**
 * Check whether a statement range is contained within the function's
 * line+column source range.
 */
function statementContainedInFn(
  fn: FunctionInfo,
  stmtStart: Position,
  stmtEnd: Position,
): boolean {
  return locContainedInFn(fn, stmtStart, stmtEnd);
}

/**
 * Map a single function to its coverage using:
 * 1. Identity association via fnMap containment (most-specific matching loc).
 * 2. Coverage fraction from statementMap/s counts within the function's range.
 *
 * The fnMap is used only to confirm the function has a coverage identity
 * (matched: true/false). Coverage value is always derived from statement
 * counts — never from the boolean `f[id] > 0` hit.
 *
 * If the file entry has no statementMap/s data, falls back to 0 coverage
 * with matched=true when a fnMap identity was found (but no statements to
 * measure), or matched=false when no identity was found.
 */
export function mapFunctionCoverage(
  fileEntry: IstanbulFileEntry,
  fn: FunctionInfo,
): FunctionCoverage {
  // --- Identity association via fnMap ---
  // Find the most specific (smallest) loc contained within the function.
  // This is the function's own loc, not a parent's or child's.
  let identityMatched = false;
  let bestKey: string | null = null;
  let bestSize = Infinity; // smallest containing loc = most specific

  for (const key of Object.keys(fileEntry.fnMap)) {
    const entry = fileEntry.fnMap[key];
    if (entry === undefined) {
      continue;
    }
    const locStart = entry.loc.start;
    const locEnd = entry.loc.end;
    if (locContainedInFn(fn, locStart, locEnd)) {
      identityMatched = true;
      const size =
        (locEnd.line - locStart.line) * 100000 +
        ((locEnd.column ?? 0) - (locStart.column ?? 0));
      // Most specific = smallest containing loc.
      if (size < bestSize) {
        bestSize = size;
        bestKey = key;
      }
      // Ties are acceptable here — both identify the same function equally;
      // we only need identity confirmation, not a unique entry.
    }
  }

  // --- Coverage fraction from statementMap/s ---
  const statementMap = fileEntry.statementMap;
  const s = fileEntry.s;
  if (
    statementMap === undefined ||
    s === undefined ||
    statementMap === null ||
    s === null
  ) {
    // No statement-level data available. Report 0 coverage.
    // matched=true only when a fnMap identity was found.
    return {
      functionInfo: fn,
      coverage: 0,
      matched: identityMatched,
      totalStatements: 0,
      coveredStatements: 0,
    };
  }

  let totalStatements = 0;
  let coveredStatements = 0;

  for (const key of Object.keys(statementMap)) {
    const stmt = statementMap[key];
    if (stmt === undefined) {
      continue;
    }
    if (statementContainedInFn(fn, stmt.start, stmt.end)) {
      totalStatements += 1;
      const count = s[key];
      if (count !== undefined && count > 0) {
        coveredStatements += 1;
      }
    }
  }

  // No statements in the function's range: coverage 0.
  // matched reflects whether we found the function in coverage at all.
  const matched = identityMatched || totalStatements > 0;
  if (totalStatements === 0) {
    return {
      functionInfo: fn,
      coverage: 0,
      matched,
      totalStatements: 0,
      coveredStatements: 0,
    };
  }

  const coverage = coveredStatements / totalStatements;
  return {
    functionInfo: fn,
    coverage,
    matched,
    totalStatements,
    coveredStatements,
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
  const results: FunctionCoverage[] = [];
  for (const fn of functions) {
    const fileEntry = findFileEntry(coverage, fn.filePath);
    if (fileEntry === null) {
      results.push({
        functionInfo: fn,
        coverage: 0,
        matched: false,
        totalStatements: 0,
        coveredStatements: 0,
      });
      continue;
    }
    results.push(mapFunctionCoverage(fileEntry, fn));
  }
  return results;
}
