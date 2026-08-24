import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeSource } from "../src/complexity.js";
import {
  GitInputError,
  assertNoDirtyTypeScriptFiles,
  changedFunctionFilter,
  collectChangedFiles,
  resolveChangedRef,
  type GitRunner,
} from "../src/changed.js";

const NUL = "\u0000";

function gitResponses(responses: ReadonlyMap<string, string>): GitRunner {
  return (args) => {
    const response = responses.get(args.join(NUL));
    if (response === undefined) throw new Error(`unexpected git arguments: ${args.join(" ")}`);
    return response;
  };
}

describe("collectChangedFiles", () => {
  it("uses the merge-base of the ref and HEAD, parses NUL paths, and records added lines", () => {
    const cwd = "/project";
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "origin/main^{commit}"].join(NUL), "base-ref\n"],
      [["merge-base", "base-ref", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `M${NUL}src/has space.ts${NUL}A${NUL}src/new.ts${NUL}D${NUL}src/removed.ts${NUL}R100${NUL}src/old.ts${NUL}src/renamed.ts${NUL}`],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/has space.ts"].join(NUL), "@@ -3 +3,2 @@\n"],
    ]));

    const result = collectChangedFiles("origin/main", cwd, runner);

    expect(result.mergeBase).toBe("merge-base");
    expect(result.files.get(path.join(cwd, "src/has space.ts"))).toEqual({ kind: "ranges", ranges: [{ start: 3, end: 4 }] });
    expect(result.files.get(path.join(cwd, "src/new.ts"))).toEqual({ kind: "all" });
    expect(result.files.has(path.join(cwd, "src/removed.ts"))).toBe(false);
    expect(result.files.get(path.join(cwd, "src/renamed.ts"))).toEqual({ kind: "ranges", ranges: [] });
  });

  it("treats zero-length new hunks as deterministic changed-line boundaries", () => {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `M${NUL}src/a.ts${NUL}`],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/a.ts"].join(NUL), "@@ -4 +4,0 @@\n"],
    ]));
    const result = collectChangedFiles("main", "/project", runner);
    expect(result.files.get("/project/src/a.ts")).toEqual({ kind: "ranges", ranges: [{ start: 4, end: 4 }] });
  });

  it("reports unavailable refs and merge bases as actionable input errors", () => {
    const refFailure: GitRunner = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/project\n";
      throw new Error("fatal: Needed a single revision");
    };
    expect(() => collectChangedFiles("missing", "/project", refFailure)).toThrow(GitInputError);
    expect(() => collectChangedFiles("missing", "/project", refFailure)).toThrow(/cannot resolve git ref/);

    const noBase: GitRunner = (args) => {
      if (args[0] === "rev-parse") return "sha\n";
      throw new Error("fatal: no merge base");
    };
    expect(() => collectChangedFiles("main", "/project", noBase)).toThrow(/cannot find a merge base/);
  });
});

describe("changedFunctionFilter", () => {
  it("selects only functions whose inclusive line range intersects changed lines, including nested and same-line boundaries", () => {
    const file = "/project/src/a.ts";
    const functions = analyzeSource(file, [
      "export function outer() {",
      "  const nested = () => 1;",
      "  return nested();",
      "}",
      "export const same = () => 2; export const other = () => 3;",
    ].join("\n"));
    const files = new Map([[file, { kind: "ranges" as const, ranges: [{ start: 2, end: 2 }, { start: 5, end: 5 }] }]]);

    expect(changedFunctionFilter(functions, files).map((fn) => fn.displayName)).toEqual(["outer", "nested", "same", "other"]);
  });

  it("does not select functions from unchanged files and selects every function in added files", () => {
    const changed = analyzeSource("/project/src/new.ts", "export function added() { return 1; }");
    const unchanged = analyzeSource("/project/src/old.ts", "export function old() { return 1; }");
    const files = new Map([["/project/src/new.ts", { kind: "all" as const }]]);
    expect(changedFunctionFilter([...changed, ...unchanged], files).map((fn) => fn.displayName)).toEqual(["added"]);
  });
});

describe("resolveChangedRef (extraction)", () => {
  it("resolves the repository root, ref commit, and merge base without running diff", () => {
    const calls: Array<readonly string[]> = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return args[0] === "rev-parse" && args[1] === "--show-toplevel" ? "/project\n" : "base\n";
    };
    expect(resolveChangedRef(runner, "origin/main", "/workdir")).toEqual({ projectRoot: "/project", mergeBase: "base" });
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "origin/main^{commit}"],
      ["merge-base", "base", "HEAD"],
    ]);
  });

  it("surfaces every git failure and empty output as an actionable GitInputError", () => {
    const failing: GitRunner = () => {
      throw new Error("fatal: boom");
    };
    expect(() => resolveChangedRef(failing, "main", "/project")).toThrow(GitInputError);
    expect(() => resolveChangedRef(failing, "main", "/project")).toThrow(/cannot determine the Git repository root: fatal: boom/);

    const emptyRoot: GitRunner = () => " \n";
    expect(() => resolveChangedRef(emptyRoot, "main", "/project")).toThrow("cannot determine the Git repository root; git returned no path");

    const emptyRef: GitRunner = (args) =>
      args[0] === "rev-parse" && args[1] === "--verify" ? " \n" : args[0] === "rev-parse" ? "/project\n" : " \n";
    expect(() => resolveChangedRef(emptyRef, "main", "/project")).toThrow(/cannot resolve git ref "main"; git returned no commit/);

    const emptyBase: GitRunner = (args) =>
      args[0] === "merge-base" ? " \n" : args[0] === "rev-parse" && args[1] === "--verify" ? "sha\n" : "/project\n";
    expect(() => resolveChangedRef(emptyBase, "main", "/project")).toThrow("cannot find a merge base between \"main\" and HEAD");
  });
});

describe("collectChangedFiles status dispatch (extraction)", () => {
  it("treats copied files like edits: ranges from a destination-path diff, deletions are skipped", () => {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `C100${NUL}src/src.ts${NUL}src/copied.ts${NUL}D${NUL}src/gone.ts${NUL}`],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/copied.ts"].join(NUL), "@@ -1 +2 @@\n"],
    ]));
    const result = collectChangedFiles("main", "/project", runner);
    expect(result.files.get("/project/src/copied.ts")).toEqual({ kind: "ranges", ranges: [{ start: 2, end: 2 }] });
    expect(result.files.has("/project/src/gone.ts")).toBe(false);
  });

  it("treats type-changed files like edits: ranges from a destination-path diff", () => {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `T${NUL}src/type.ts${NUL}`],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/type.ts"].join(NUL), "@@ -1,2 +3 @@\n"],
    ]));
    const result = collectChangedFiles("main", "/project", runner);
    expect(result.files.get("/project/src/type.ts")).toEqual({ kind: "ranges", ranges: [{ start: 3, end: 3 }] });
  });

  it("skips paths that escape the repository root instead of following them", () => {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `M${NUL}../escape.ts${NUL}M${NUL}./inside.ts${NUL}`],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "./inside.ts"].join(NUL), "@@ -1 +1 @@\n"],
    ]));
    const result = collectChangedFiles("main", "/project", runner);
    expect([...result.files.keys()]).toEqual(["/project/inside.ts"]);
  });

  it("selects every function of an edited (R<100) rename destination", () => {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `R092${NUL}src/old.ts${NUL}src/edited.ts${NUL}`],
    ]));
    const result = collectChangedFiles("main", "/project", runner);
    expect(result.files.get("/project/src/edited.ts")).toEqual({ kind: "all" });
  });

  it("rejects unsupported status tokens with an actionable parse error", () => {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `X${NUL}src/x.ts${NUL}`],
    ]));
    expect(() => collectChangedFiles("main", "/project", runner)).toThrow('cannot parse git changed-file status "X"');
  });

  it("rejects a missing or out-of-range rename score as an actionable error", () => {
    const makeRunner = (status: string): GitRunner => gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `${status}${NUL}src/old.ts${NUL}src/new.ts${NUL}`],
    ]));
    expect(() => collectChangedFiles("main", "/project", makeRunner("R101"))).toThrow('cannot parse git rename score "R101"');
    expect(() => collectChangedFiles("main", "/project", makeRunner("R"))).toThrow('cannot parse git rename score "R"');
  });
});

describe("assertNoDirtyTypeScriptFiles (direct)", () => {
  let project: string;
  let originalCwd: string;

  function git(args: string[]): void {
    execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  }

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-changed-dirty-"));
    originalCwd = process.cwd();
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("rejects tracked and uncommitted TypeScript changes, but not other files or a clean tree", () => {
    expect(() => assertNoDirtyTypeScriptFiles(project)).not.toThrow();

    fs.writeFileSync(path.join(project, "src.ts"), "export const a = 1;\n");
    expect(() => assertNoDirtyTypeScriptFiles(project)).toThrow(GitInputError);
    expect(() => assertNoDirtyTypeScriptFiles(project)).toThrow("clean TypeScript worktree");

    git(["add", "src.ts"]);
    git(["commit", "-m", "base"]);
    expect(() => assertNoDirtyTypeScriptFiles(project)).not.toThrow();

    fs.writeFileSync(path.join(project, "src.ts"), "export const a = 2;\n");
    expect(() => assertNoDirtyTypeScriptFiles(project)).toThrow(/clean TypeScript worktree/);
    git(["checkout", "--", "src.ts"]);
    expect(() => assertNoDirtyTypeScriptFiles(project)).not.toThrow();

    fs.writeFileSync(path.join(project, "notes.md"), "not TypeScript\n");
    expect(() => assertNoDirtyTypeScriptFiles(project)).not.toThrow();

    fs.writeFileSync(path.join(project, "comp.tsx"), "export const b = 1;\n");
    expect(() => assertNoDirtyTypeScriptFiles(project)).toThrow(/clean TypeScript worktree/);
  });
});

describe("parseNewLineRanges semantics (direct, through collectChangedFiles)", () => {
  function rangesFor(patch: string): ReadonlyArray<{ readonly start: number; readonly end: number }> {
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join(NUL), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join(NUL), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join(NUL), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join(NUL), `M${NUL}src/a.ts${NUL}`],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/a.ts"].join(NUL), patch],
    ]));
    const entry = collectChangedFiles("main", "/project", runner).files.get("/project/src/a.ts");
    if (entry === undefined || entry.kind !== "ranges") throw new Error("expected a ranges entry");
    return entry.ranges;
  }

  it("parses every hunk in order, defaulting a missing count to one line", () => {
    expect(rangesFor("@@ -1 +1,2 @@\n@@ -5 +6,0 @@\n@@ -9 +11 @@\n")).toEqual([
      { start: 1, end: 2 },
      { start: 6, end: 6 },
      { start: 11, end: 11 },
    ]);
  });

  it("ignores non-hunk lines and keeps only the new-side positions", () => {
    expect(rangesFor("diff --git a/src/a.ts b/src/a.ts\nindex 000..111\n@@ -2,3 +4,2 @@ context\n")).toEqual([{ start: 4, end: 5 }]);
  });

  it("treats an empty patch as no changed lines", () => {
    expect(rangesFor("")).toEqual([]);
  });

  it("rejects a hunk with a zero new-side start as an actionable error", () => {
    // The new-side start (group 1) is `0`, which fails the start >= 1 guard.
    expect(() => rangesFor("@@ -1 +0,3 @@\n")).toThrow("cannot parse git changed-line range");
  });
});
