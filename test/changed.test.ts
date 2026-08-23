import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { analyzeSource } from "../src/complexity.js";
import {
  GitInputError,
  changedFunctionFilter,
  collectChangedFiles,
  type GitRunner,
} from "../src/changed.js";

function gitResponses(responses: ReadonlyMap<string, string>): GitRunner {
  return (args) => {
    const response = responses.get(args.join("\u0000"));
    if (response === undefined) throw new Error(`unexpected git arguments: ${args.join(" ")}`);
    return response;
  };
}

describe("collectChangedFiles", () => {
  it("uses the merge-base of the ref and HEAD, parses NUL paths, and records added lines", () => {
    const cwd = "/project";
    const runner = gitResponses(new Map([
      [["rev-parse", "--show-toplevel"].join("\u0000"), "/project\n"],
      [["rev-parse", "--verify", "origin/main^{commit}"].join("\u0000"), "base-ref\n"],
      [["merge-base", "base-ref", "HEAD"].join("\u0000"), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join("\u0000"), "M\0src/has space.ts\0A\0src/new.ts\0D\0src/removed.ts\0R100\0src/old.ts\0src/renamed.ts\0"],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/has space.ts"].join("\u0000"), "@@ -3 +3,2 @@\n"],
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
      [["rev-parse", "--show-toplevel"].join("\u0000"), "/project\n"],
      [["rev-parse", "--verify", "main^{commit}"].join("\u0000"), "main-sha\n"],
      [["merge-base", "main-sha", "HEAD"].join("\u0000"), "merge-base\n"],
      [["diff", "--name-status", "-z", "--find-renames", "merge-base", "HEAD"].join("\u0000"), "M\0src/a.ts\0"],
      [["diff", "--no-ext-diff", "--no-color", "--unified=0", "merge-base", "HEAD", "--", "src/a.ts"].join("\u0000"), "@@ -4 +4,0 @@\n"],
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
