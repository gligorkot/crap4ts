/** Git-backed changed-function selection for changed-only CRAP gates. */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { FunctionInfo } from "./complexity.js";
import { canonicalPath } from "./path-identity.js";

export interface ChangedLineRange {
  readonly start: number;
  readonly end: number;
}

export type ChangedFile =
  | { readonly kind: "all" }
  | { readonly kind: "ranges"; readonly ranges: readonly ChangedLineRange[] };

export interface ChangedFiles {
  readonly mergeBase: string;
  readonly files: ReadonlyMap<string, ChangedFile>;
}

export type GitRunner = (args: readonly string[], cwd: string) => string;

/** An actionable git input error that the CLI maps to exit code 1. */
export class GitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInputError";
  }
}

const runGit: GitRunner = (args, cwd) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

/**
 * The resolved inputs needed to collect changes since a ref: the repository
 * root (where every git invocation must run) and the merge base of the
 * ref's commit and HEAD (the diff anchor).
 */
export interface ResolvedChangedRef {
  readonly projectRoot: string;
  readonly mergeBase: string;
}

/**
 * Resolve a ref and the merge base between its commit and HEAD.
 *
 * Git is always invoked with argument arrays; the ref value never enters a
 * shell. The repository root is resolved first because all subsequent git
 * invocations run from it, so git path output is repository-root-relative
 * rather than relative to `cwd`.
 */
export function resolveChangedRef(runner: GitRunner, ref: string, cwd: string): ResolvedChangedRef {
  const projectRoot = runRequiredGit(
    runner,
    ["rev-parse", "--show-toplevel"],
    cwd,
    "cannot determine the Git repository root",
  ).trim();
  if (projectRoot.length === 0) throw new GitInputError("cannot determine the Git repository root; git returned no path");
  const resolvedRef = runRequiredGit(
    runner,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    projectRoot,
    `cannot resolve git ref "${ref}"; use a commit, branch, tag, or remote-tracking ref available locally`,
  ).trim();
  if (resolvedRef.length === 0) throw new GitInputError(`cannot resolve git ref "${ref}"; git returned no commit`);
  const mergeBase = runRequiredGit(
    runner,
    ["merge-base", resolvedRef, "HEAD"],
    projectRoot,
    `cannot find a merge base between "${ref}" and HEAD; fetch the base ref or use a related ref`,
  ).trim();
  if (mergeBase.length === 0) throw new GitInputError(`cannot find a merge base between "${ref}" and HEAD`);
  return { projectRoot, mergeBase };
}

/**
 * Resolve a ref and collect committed HEAD changes since its merge base.
 *
 * Git is always invoked with argument arrays; ref and path values never enter a
 * shell. Git path output is repository-root-relative, so the resulting paths
 * are absolute paths rooted under the repository top-level rather than `cwd`.
 */
export function collectChangedFiles(ref: string, cwd: string, runner: GitRunner = runGit): ChangedFiles {
  const { projectRoot, mergeBase } = resolveChangedRef(runner, ref, cwd);
  const status = runRequiredGit(
    runner,
    ["diff", "--name-status", "-z", "--find-renames", mergeBase, "HEAD"],
    projectRoot,
    "cannot determine changed files from git",
  );
  const files = new Map<string, ChangedFile>();
  for (const change of parseNameStatus(status)) {
    if (change.status === "D") continue;
    const absolute = toProjectPath(projectRoot, change.path);
    if (absolute === null) continue;
    files.set(absolute, changedFileForStatus(change, projectRoot, mergeBase, runner));
  }
  return { mergeBase, files };
}

export function assertNoDirtyTypeScriptFiles(cwd: string): void {
  const status = runRequiredGit(
    runGit,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    "cannot inspect git worktree status",
  );
  const paths = status.split("\0").map((entry) => entry.length >= 4 ? entry.slice(3) : entry);
  if (paths.some((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"))) {
    throw new GitInputError("changed-only analysis requires a clean TypeScript worktree; commit, stash, or discard TypeScript changes first");
  }
}

/** Select functions in changed files whose inclusive source lines intersect changed line ranges. */
export function changedFunctionFilter(
  functions: readonly FunctionInfo[],
  files: ReadonlyMap<string, ChangedFile>,
): FunctionInfo[] {
  return functions.filter((fn) => {
    const changed = files.get(canonicalPath(fn.filePath));
    if (changed === undefined) return false;
    if (changed.kind === "all") return true;
    return changed.ranges.some((range) => fn.startLine <= range.end && range.start <= fn.endLine);
  });
}

function runRequiredGit(runner: GitRunner, args: readonly string[], cwd: string, message: string): string {
  try {
    return runner(args, cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : String(error);
    throw new GitInputError(`${message}${detail.length === 0 ? "" : `: ${detail}`}`);
  }
}

interface NameStatus {
  readonly status: "A" | "M" | "R" | "D" | "C" | "T";
  readonly score?: number;
  readonly path: string;
}

function isSupportedStatus(status: string): status is NameStatus["status"] {
  return status === "A" || status === "M" || status === "R" || status === "D" || status === "C" || status === "T";
}

function parseNameStatus(output: string): NameStatus[] {
  const parts = output.split("\0");
  const changes: NameStatus[] = [];
  let index = 0;
  while (index < parts.length - 1) {
    const record = parseNameStatusRecord(parts, index);
    if (record !== undefined) changes.push(record.change);
    index += record === undefined ? 1 : record.consumed;
  }
  return changes;
}

interface NameStatusRecord {
  readonly change: NameStatus;
  /** Number of NUL entries consumed by this record (status + path(s)). */
  readonly consumed: number;
}

/**
 * Parse one NUL-separated name-status record at `index`. R/C records consume
 * the status, the old path, and the destination path; simple records consume
 * the status and one path. An empty entry yields `undefined` so the caller
 * skips it. A record whose declared paths run past the end of the input is
 * malformed and rejected.
 */
function parseNameStatusRecord(parts: string[], index: number): NameStatusRecord | undefined {
  const rawStatus = parts[index]!;
  if (rawStatus.length === 0) return undefined;
  const status = rawStatus.charAt(0);
  if (!isSupportedStatus(status)) {
    throw new GitInputError(`cannot parse git changed-file status "${rawStatus}"`);
  }
  if (status === "R" || status === "C") {
    const newPath = parts[index + 2];
    if (newPath === undefined) throw new GitInputError("cannot parse renamed git path");
    return { change: { status, score: parseRenameScore(rawStatus), path: newPath }, consumed: 3 };
  }
  return { change: { status, path: parts[index + 1]! }, consumed: 2 };
}

function parseRenameScore(rawStatus: string): number {
  const scoreText = rawStatus.slice(1);
  if (!/^\d+$/.test(scoreText)) throw new GitInputError(`cannot parse git rename score "${rawStatus}"`);
  const score = Number(scoreText);
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) {
    throw new GitInputError(`cannot parse git rename score "${rawStatus}"`);
  }
  return score;
}

function toProjectPath(cwd: string, relativePath: string): string | null {
  const root = canonicalPath(cwd);
  const absolute = canonicalPath(path.resolve(root, relativePath));
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return absolute;
}

/**
 * The ChangedFile entry for one non-deleted name-status record:
 * - A: the whole file is new, so every function is changed;
 * - R100: only Git's R100 status guarantees that the destination has no
 *   changed source lines, so the destination gets an empty range list rather
 *   than a full-file selection; an edited rename (R<100) is conservative and
 *   selects every destination function, avoiding silently dropping a change
 *   if a patch cannot be attributed to a function range;
 * - M, C, T: changed lines are attributed from a diff of the destination
 *   (new) path, matching the historical behavior.
 */
function changedFileForStatus(
  change: NameStatus,
  projectRoot: string,
  mergeBase: string,
  runner: GitRunner,
): ChangedFile {
  if (change.status === "A") {
    return { kind: "all" };
  }
  if (change.status === "R") {
    if (change.score === 100) {
      return { kind: "ranges", ranges: [] };
    }
    return { kind: "all" };
  }
  const patch = runRequiredGit(
    runner,
    ["diff", "--no-ext-diff", "--no-color", "--unified=0", mergeBase, "HEAD", "--", change.path],
    projectRoot,
    `cannot determine changed lines for ${change.path}`,
  );
  return { kind: "ranges", ranges: parseNewLineRanges(patch) };
}

function parseNewLineRanges(patch: string): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = [];
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  for (let match = hunk.exec(patch); match !== null; match = hunk.exec(patch)) {
    ranges.push(parseHunkRange(match));
  }
  return ranges;
}

/**
 * The new-file line range of one hunk header. A missing count defaults to
 * one line; a zero-count (deletion) hunk has no new source line, but its
 * insertion boundary is still a deterministic source location and catches
 * functions modified by deletion.
 */
function parseHunkRange(match: RegExpExecArray): ChangedLineRange {
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 0) {
    throw new GitInputError("cannot parse git changed-line range");
  }
  return { start, end: count === 0 ? start : start + count - 1 };
}
