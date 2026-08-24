/**
 * Coverage reading and function-to-coverage mapping.
 *
 * Reads Istanbul-format coverage JSON (the `coverage-final.json` emitted by
 * Vitest's V8 provider, which converts V8 raw coverage to Istanbul) and maps
 * each analyzed function to a coverage decimal in [0, 1].
 *
 * v1 coverage semantics — **per-function statement coverage fraction**, with
 * safe per-file ownership:
 *
 * Assignment is performed per file over ALL source functions and ALL Istanbul
 * fnMap entries before any fraction is computed, so every fnMap entry and
 * every statement is owned by **at most one** source function. This mirrors the
 * invariant of the reference implementations, where coverage units belong to
 * exactly one method/function:
 * - Java/JaCoCo: covered instructions / total instructions per *method*; a
 *   lambda's instructions are reported against the lambda, not the enclosing
 *   method.
 * - Go: covered coverage statements / total statements in the function's
 *   range; each coverage segment maps to the function whose source range
 *   contains it.
 * - Clojure: covered forms / total forms for the function's line span, keyed
 *   by the `defn` name boundary.
 *
 * The algorithm, per file:
 *
 * 1. **fnMap → source function.** Each fnMap entry is assigned to AT MOST ONE
 *    source function: the uniquely most-specific containing function, using
 *    line+column ranges (smallest source range that contains the entry's
 *    `loc`). Tied/equally-specific candidates are ambiguous and the entry is
 *    assigned to none. A source function with at least one assigned fnMap
 *    entry has a valid coverage identity (`matched: true`).
 *
 * 2. **Statements → owning source function, then matched filter.** Each
 *    Istanbul statement is owned by AT MOST ONE source function: the uniquely
 *    most-specific containing function determined across ALL source
 *    functions first (not just matched ones), using exact range containment
 *    ordering. If that owner is matched, the statement is credited to it. If
 *    the owner is unmatched (or ownership is ambiguous), the statement is
 *    excluded entirely — it does NOT fall through to a matched parent. A
 *    statement belonging to an inner unmatched function never contributes to
 *    the outer function's numerator or denominator. This preserves one-to-one
 *    ownership and partial coverage.
 *
 * 3. **Fraction.** Within the correctly owned statements, coverage = covered
 *    statement count / total owned statement count. An uncovered function
 *    (all owned statements have count 0) reports coverage 0. A function with
 *    a valid identity but no owned statements reports coverage 0 with
 *    `matched: true` and zero statements. An unmatched function reports
 *    coverage 0 with `matched: false` and zero statements.
 *
 * Same-line `first` / `second` cases use real distinct columns: a surviving
 * fnMap entry maps only to its exact column-matching source function; ties
 * reject coverage.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FunctionInfo } from "./complexity.js";
import { canonicalPath } from "./path-identity.js";

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
 * Normalize a file path for matching: canonicalize an existing absolute path
 * (resolving filesystem aliases such as macOS `/var` → `/private/var`) and
 * forward-slash-normalize it. Missing paths remain resolved but non-canonical
 * so coverage reports from another machine can still use suffix matching.
 */
function normalizeFilePath(p: string): string {
  return canonicalPath(p).split(path.sep).join("/");
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
 * Find an Istanbul file entry by exact normalized path: the first entry whose
 * `path` (or the top-level key) resolves to the same absolute path as the
 * target.
 *
 * This is the unambiguous, highest-priority matching rule. Returns null when
 * no entry path matches exactly.
 */
function exactFileEntryMatch(
  coverage: IstanbulCoverage,
  target: string,
): IstanbulFileEntry | null {
  const keys = Object.keys(coverage);
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
  return null;
}

/**
 * Collect the anchored project-relative suffix candidates for a target path.
 *
 * Each candidate is an entry whose normalized `path` shares a trailing
 * segment suffix with the target; `bestScore` is the maximum shared suffix
 * length. Only entries sharing the best score are kept. Returns empty
 * candidates when no candidate shares any segment with the target.
 */
function anchorSuffixCandidate(
  coverage: IstanbulCoverage,
  target: string,
): { candidates: IstanbulFileEntry[]; bestScore: number } {
  const targetSegs = pathSegments(target);
  // Require at least 2 segments (directory + filename) to reject basename-only.
  if (targetSegs.length < 2) {
    return { candidates: [], bestScore: 0 };
  }
  const candidates: IstanbulFileEntry[] = [];
  let bestScore = 0;
  const keys = Object.keys(coverage);
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
  return { candidates, bestScore };
}

/**
 * Decide whether the suffix candidates form an unambiguous anchored match:
 * exactly one candidate, and the shared suffix covers the full target
 * relative path (bestScore >= target segment count). This is the
 * fail-closed gate for suffix matching: ties or partial suffixes return
 * null.
 */
function acceptUnambiguousSuffix(
  candidates: readonly IstanbulFileEntry[],
  bestScore: number,
  target: string,
): IstanbulFileEntry | null {
  // Only accept when exactly one candidate has the best score, and the suffix
  // covers the full target relative path (bestScore === targetSegs.length),
  // ensuring an anchored project-relative match, not a basename-only match.
  if (candidates.length === 1 && bestScore >= pathSegments(target).length) {
    return candidates[0]!;
  }
  return null;
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
  const exact = exactFileEntryMatch(coverage, target);
  if (exact !== null) {
    return exact;
  }
  const { candidates, bestScore } = anchorSuffixCandidate(coverage, target);
  return acceptUnambiguousSuffix(candidates, bestScore, target);
}

/**
 * Compare positions by line then column. Columns default to 0 when null,
 * matching Istanbul's convention for end-of-line positions.
 */
function comparePositions(
  aLine: number,
  aColumn: number | null,
  bLine: number,
  bColumn: number | null,
): number {
  if (aLine !== bLine) {
    return aLine - bLine;
  }
  return (aColumn ?? 0) - (bColumn ?? 0);
}

/**
 * Test whether `loc` (an Istanbul range) is fully contained within the
 * source function `fn`'s line+column range.
 */
function locContainedInFn(
  fn: FunctionInfo,
  locStart: Position,
  locEnd: Position,
): boolean {
  const startOk =
    comparePositions(fn.startLine, fn.startColumn, locStart.line, locStart.column) <= 0;
  const endOk =
    comparePositions(fn.endLine, fn.endColumn, locEnd.line, locEnd.column) >= 0;
  return startOk && endOk;
}

/**
 * Test whether the range `[innerStart, innerEnd]` is strictly contained within
 * the range `[outerStart, outerEnd]`. Both ranges use 0-based columns.
 *
 * "Strictly contained" means the inner range is a subset of the outer range
 * AND is not equal to it (at least one boundary differs). This is the exact
 * ordering primitive for "most specific" comparisons: a strictly-contained
 * range is more specific (smaller) than its container.
 *
 * Comparison is lexicographic on (line, column) — line dominates, column
 * breaks ties — so columns of any magnitude are handled correctly without
 * numeric scaling heuristics.
 */
function rangeStrictlyContainsRange(
  outerStartLine: number,
  outerStartColumn: number,
  outerEndLine: number,
  outerEndColumn: number,
  innerStartLine: number,
  innerStartColumn: number,
  innerEndLine: number,
  innerEndColumn: number,
): boolean {
  // inner.start >= outer.start (lexicographically)
  const startCmp = comparePositions(
    innerStartLine,
    innerStartColumn,
    outerStartLine,
    outerStartColumn,
  );
  // inner.end <= outer.end (lexicographically)
  const endCmp = comparePositions(
    innerEndLine,
    innerEndColumn,
    outerEndLine,
    outerEndColumn,
  );
  // Contained: start >= outer.start AND end <= outer.end.
  // Strict: contained AND not equal (start > outer.start OR end < outer.end).
  return startCmp >= 0 && endCmp <= 0 && (startCmp > 0 || endCmp < 0);
}

/**
 * Test whether the source range of function `inner` is strictly contained
 * within the source range of function `outer` (the "more specific"
 * relationship for two source functions).
 */
function isFnRangeStrictlyContainedIn(
  inner: FunctionInfo,
  outer: FunctionInfo,
): boolean {
  return rangeStrictlyContainsRange(
    outer.startLine,
    outer.startColumn,
    outer.endLine,
    outer.endColumn,
    inner.startLine,
    inner.startColumn,
    inner.endLine,
    inner.endColumn,
  );
}

/**
 * Collect the indexes of all source functions whose line+column range
 * contains the given loc.
 */
function containerCandidateIndexes(
  fns: FunctionInfo[],
  locStart: Position,
  locEnd: Position,
): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    if (fn === undefined) {
      continue;
    }
    if (locContainedInFn(fn, locStart, locEnd)) {
      candidates.push(i);
    }
  }
  return candidates;
}

/**
 * Reduce a list of container candidate indexes to the minimal ones: those
 * candidates that no other candidate is strictly contained within (no other
 * candidate has a strictly smaller range).
 *
 * A single minimal candidate is the most-specific container. Multiple
 * minimals — identical ranges, or incomparable ranges that both contain the
 * loc — mean the containment is ambiguous.
 */
function minimalContainerIndexes(
  fns: FunctionInfo[],
  candidates: readonly number[],
  containsFnRange: (outerIndex: number, innerIndex: number) => boolean,
): number[] {
  const minimal: number[] = [];
  for (const i of candidates) {
    let isMinimal = true;
    for (const j of candidates) {
      if (j === i) {
        continue;
      }
      // Is fnJ strictly contained within fnI? If so, fnI is not minimal.
      if (containsFnRange(i, j)) {
        isMinimal = false;
        break;
      }
    }
    if (isMinimal) {
      minimal.push(i);
    }
  }
  return minimal;
}

/**
 * Find the uniquely most-specific source function that contains `loc`.
 *
 * "Most specific" = the function whose line+column source range is the unique
 * minimum under the containment partial order: no other candidate's range is
 * strictly contained within it. Equivalently, the smallest containing range.
 *
 * Ties are rejected conservatively:
 * - Two candidates with identical ranges → both minimal → tie → null.
 * - Two candidates with incomparable ranges (neither contains the other, both
 *   contain the loc) → both minimal → tie → null.
 *
 * This uses exact lexicographic (line, column) comparison rather than a
 * numeric size heuristic, so columns of any magnitude are ordered correctly.
 */
function mostSpecificContainer(
  fns: FunctionInfo[],
  locStart: Position,
  locEnd: Position,
): number | null {
  const candidates = containerCandidateIndexes(fns, locStart, locEnd);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  // Find minimal candidates: those where no other candidate is strictly
  // contained within them (no other candidate has a strictly smaller range).
  const minimal = minimalContainerIndexes(fns, candidates, (i, j) =>
    isFnRangeStrictlyContainedIn(fns[j]!, fns[i]!),
  );
  // Unique minimal → the most-specific container.
  // Zero or multiple minimals → ambiguous/tie → assign to none.
  if (minimal.length === 1) {
    return minimal[0]!;
  }
  return null;
}

/**
 * Find the owning source function for a statement, applying the matched-only
 * filter as an exclusion — never a fall-through.
 *
 * The statement's uniquely most-specific owning function is determined across
 * ALL source functions first (using {@link mostSpecificContainer}). If that
 * owner is matched (has a valid coverage identity), the statement is credited
 * to it. If the owner is unmatched, the statement is excluded entirely — it
 * does NOT fall through to a matched parent. If ownership is ambiguous (tie),
 * the statement is also excluded.
 *
 * This preserves one-to-one ownership: every statement is owned by at most
 * one function, and a statement whose most-specific owner is unmatched
 * contributes to no function's numerator or denominator.
 */
function mostSpecificMatchedContainer(
  fns: FunctionInfo[],
  matchedFlags: readonly boolean[],
  stmtStart: Position,
  stmtEnd: Position,
): number | null {
  const ownerIdx = mostSpecificContainer(fns, stmtStart, stmtEnd);
  if (ownerIdx === null) {
    return null;
  }
  if (!matchedFlags[ownerIdx]) {
    // The most-specific owner is unmatched → exclude, do not fall through.
    return null;
  }
  return ownerIdx;
}

/**
 * Assign each fnMap entry to at most one source function and record which
 * source functions received an identity (the `matched` flags).
 *
 * Each entry's `loc` is assigned to the uniquely most-specific containing
 * source function; ties are rejected conservatively (assigned to none).
 */
function markMatchedFunctionFlags(
  fileEntry: IstanbulFileEntry,
  fns: FunctionInfo[],
): boolean[] {
  const matchedFlags = new Array<boolean>(fns.length).fill(false);
  for (const key of Object.keys(fileEntry.fnMap)) {
    const entry = fileEntry.fnMap[key];
    if (entry === undefined) {
      continue;
    }
    const idx = mostSpecificContainer(fns, entry.loc.start, entry.loc.end);
    if (idx !== null) {
      matchedFlags[idx] = true;
    }
  }
  return matchedFlags;
}

/**
 * Assign each Istanbul statement to at most one matched source function and
 * accumulate total/covered counts per function.
 *
 * Statements whose most-specific owner is unmatched (or whose ownership is
 * ambiguous) are excluded entirely — they never fall through to a matched
 * parent.
 */
function assignStatementsToOwners(
  fileEntry: IstanbulFileEntry,
  fns: FunctionInfo[],
  matchedFlags: readonly boolean[],
): { totalStatements: number[]; coveredStatements: number[] } {
  const totalStatements = new Array<number>(fns.length).fill(0);
  const coveredStatements = new Array<number>(fns.length).fill(0);
  const statementMap = fileEntry.statementMap;
  const s = fileEntry.s;
  if (statementMap === undefined || s === undefined) {
    return { totalStatements, coveredStatements };
  }
  for (const key of Object.keys(statementMap)) {
    const stmt = statementMap[key];
    if (stmt === undefined) {
      continue;
    }
    const ownerIdx = mostSpecificMatchedContainer(
      fns,
      matchedFlags,
      stmt.start,
      stmt.end,
    );
    if (ownerIdx !== null) {
      totalStatements[ownerIdx]! += 1;
      const count = s[key];
      if (count !== undefined && count > 0) {
        coveredStatements[ownerIdx]! += 1;
      }
    }
  }
  return { totalStatements, coveredStatements };
}

/**
 * Build the per-function {@link FunctionCoverage} results for one file from
 * the matched flags and owned statement counts.
 *
 * Unmatched functions report coverage 0, `matched: false`, zero statements.
 * Matched functions report covered/total over their owned statements
 * (0 when they own no statements). Input order is preserved.
 */
function buildFileFunctionCoverage(
  fns: FunctionInfo[],
  matchedFlags: readonly boolean[],
  totalStatements: readonly number[],
  coveredStatements: readonly number[],
): FunctionCoverage[] {
  const results: FunctionCoverage[] = [];
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i]!;
    const matched = matchedFlags[i]!;
    if (!matched) {
      // Unmatched: identity false. A statement alone never marks a function
      // matched. Coverage 0, zero statements.
      results.push({
        functionInfo: fn,
        coverage: 0,
        matched: false,
        totalStatements: 0,
        coveredStatements: 0,
      });
      continue;
    }
    const total = totalStatements[i]!;
    const covered = coveredStatements[i]!;
    const coverage = total > 0 ? covered / total : 0;
    results.push({
      functionInfo: fn,
      coverage,
      matched: true,
      totalStatements: total,
      coveredStatements: covered,
    });
  }
  return results;
}

/**
 * Map coverage for ALL functions in a single source file against a single
 * Istanbul file entry, performing the per-file ownership assignment.
 *
 * This is the core algorithm:
 * 1. Assign each fnMap entry to at most one source function (uniquely
 *    most-specific container). A function with >=1 assigned entry is matched.
 * 2. Assign each statement to at most one matched function (uniquely
 *    most-specific matched container). Statements owned by an inner matched
 *    function do not contribute to an outer matched parent.
 * 3. Compute coverage fraction per function over its owned statements.
 *
 * @returns coverage per function, preserving input order.
 */
export function mapFileCoverage(
  fileEntry: IstanbulFileEntry,
  fns: FunctionInfo[],
): FunctionCoverage[] {
  // Step 1: assign fnMap entries to source functions.
  const matchedFlags = markMatchedFunctionFlags(fileEntry, fns);
  // Step 2: assign statements to matched functions.
  const { totalStatements, coveredStatements } = assignStatementsToOwners(
    fileEntry,
    fns,
    matchedFlags,
  );
  // Step 3: build results.
  return buildFileFunctionCoverage(
    fns,
    matchedFlags,
    totalStatements,
    coveredStatements,
  );
}

/**
 * Map a single function to its coverage.
 *
 * This is a convenience wrapper around {@link mapFileCoverage} for the
 * single-function case. Callers that map many functions in the same file
 * should use {@link mapFileCoverage} (via {@link mapAllCoverage}) so that
 * per-file ownership is computed once over all functions together.
 */
export function mapFunctionCoverage(
  fileEntry: IstanbulFileEntry,
  fn: FunctionInfo,
): FunctionCoverage {
  return mapFileCoverage(fileEntry, [fn])[0]!;
}

/**
 * Map all functions to their coverage, grouped by file.
 *
 * Functions are grouped by their source file, and each group is mapped with
 * {@link mapFileCoverage} so that per-file ownership assignment is computed
 * over all functions in that file together. Functions whose source file has
 * no coverage entry report coverage 0 (matched: false). Functions are never
 * dropped from the result.
 *
 * @param functions  - all discovered functions (from complexity analysis)
 * @param coverage  - parsed Istanbul coverage-final.json
 * @returns coverage per function, preserving input order
 */
export function mapAllCoverage(
  functions: FunctionInfo[],
  coverage: IstanbulCoverage,
): FunctionCoverage[] {
  // Group function indices by file path for per-file ownership assignment.
  const byFile = new Map<string, { fn: FunctionInfo; index: number }[]>();
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i]!;
    let group = byFile.get(fn.filePath);
    if (group === undefined) {
      group = [];
      byFile.set(fn.filePath, group);
    }
    group.push({ fn, index: i });
  }

  const results: (FunctionCoverage | undefined)[] = new Array(functions.length).fill(
    undefined,
  );

  for (const [filePath, group] of byFile) {
    const fileEntry = findFileEntry(coverage, filePath);
    if (fileEntry === null) {
      for (const { fn, index } of group) {
        results[index] = {
          functionInfo: fn,
          coverage: 0,
          matched: false,
          totalStatements: 0,
          coveredStatements: 0,
        };
      }
      continue;
    }
    const fns = group.map((g) => g.fn);
    const fileResults = mapFileCoverage(fileEntry, fns);
    for (let j = 0; j < group.length; j++) {
      const index = group[j]!.index;
      results[index] = fileResults[j];
    }
  }

  return results as FunctionCoverage[];
}
