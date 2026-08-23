/** Git-backed changed-function selection for changed-only CRAP gates. */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { FunctionInfo } from "./complexity.js";

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
 * Resolve a ref and collect committed HEAD changes since its merge base.
 *
 * Git is always invoked with argument arrays; ref and path values never enter a
 * shell. The resulting paths are absolute paths rooted under `cwd`.
 */
export function collectChangedFiles(ref: string, cwd: string, runner: GitRunner = runGit): ChangedFiles {
  const resolvedRef = runRequiredGit(
    runner,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    cwd,
    `cannot resolve git ref "${ref}"; use a commit, branch, tag, or remote-tracking ref available locally`,
  ).trim();
  if (resolvedRef.length === 0) throw new GitInputError(`cannot resolve git ref "${ref}"; git returned no commit`);
  const mergeBase = runRequiredGit(
    runner,
    ["merge-base", resolvedRef, "HEAD"],
    cwd,
    `cannot find a merge base between "${ref}" and HEAD; fetch the base ref or use a related ref`,
  ).trim();
  if (mergeBase.length === 0) throw new GitInputError(`cannot find a merge base between "${ref}" and HEAD`);

  const status = runRequiredGit(
    runner,
    ["diff", "--name-status", "-z", "--find-renames", mergeBase, "HEAD"],
    cwd,
    "cannot determine changed files from git",
  );
  const files = new Map<string, ChangedFile>();
  for (const change of parseNameStatus(status)) {
    if (change.status === "D") continue;
    const absolute = toProjectPath(cwd, change.path);
    if (absolute === null) continue;
    if (change.status === "A") {
      files.set(absolute, { kind: "all" });
      continue;
    }
    if (change.status === "R") {
      // A pure rename has no changed source lines. Do not broaden it to a full file.
      files.set(absolute, { kind: "ranges", ranges: [] });
      continue;
    }
    const patch = runRequiredGit(
      runner,
      ["diff", "--no-ext-diff", "--no-color", "--unified=0", mergeBase, "HEAD", "--", change.path],
      cwd,
      `cannot determine changed lines for ${change.path}`,
    );
    files.set(absolute, { kind: "ranges", ranges: parseNewLineRanges(patch) });
  }
  return { mergeBase, files };
}

/** Select functions in changed files whose inclusive source lines intersect changed line ranges. */
export function changedFunctionFilter(
  functions: readonly FunctionInfo[],
  files: ReadonlyMap<string, ChangedFile>,
): FunctionInfo[] {
  return functions.filter((fn) => {
    const changed = files.get(path.resolve(fn.filePath));
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
  readonly path: string;
}

function isSupportedStatus(status: string): status is NameStatus["status"] {
  return status === "A" || status === "M" || status === "R" || status === "D" || status === "C" || status === "T";
}

function parseNameStatus(output: string): NameStatus[] {
  const parts = output.split("\0");
  const changes: NameStatus[] = [];
  for (let index = 0; index < parts.length - 1;) {
    const rawStatus = parts[index++];
    if (rawStatus === undefined || rawStatus.length === 0) continue;
    const status = rawStatus[0];
    if (status === undefined || !isSupportedStatus(status)) {
      throw new GitInputError(`cannot parse git changed-file status "${rawStatus}"`);
    }
    if (status === "R" || status === "C") {
      index++; // old path
      const newPath = parts[index++];
      if (newPath === undefined) throw new GitInputError("cannot parse renamed git path");
      changes.push({ status, path: newPath });
    } else {
      const changedPath = parts[index++];
      if (changedPath === undefined) throw new GitInputError("cannot parse git changed-file path");
      changes.push({ status, path: changedPath });
    }
  }
  return changes;
}

function toProjectPath(cwd: string, relativePath: string): string | null {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return absolute;
}

function parseNewLineRanges(patch: string): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = [];
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  for (let match = hunk.exec(patch); match !== null; match = hunk.exec(patch)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 0) {
      throw new GitInputError("cannot parse git changed-line range");
    }
    // A deletion has no new source line. Its insertion boundary is still a
    // deterministic source location and catches functions modified by deletion.
    ranges.push({ start, end: count === 0 ? start : start + count - 1 });
  }
  return ranges;
}
