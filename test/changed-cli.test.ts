import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectChangedFiles } from "../src/changed.js";
import { discoverSourceFiles } from "../src/complexity.js";

const CLI_SOURCE = path.resolve(__dirname, "../src/cli.ts");
const TSX_BIN = path.resolve(__dirname, "../node_modules/.bin/tsx");
const projects: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function projectWithBaseSource(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-changed-cli-"));
  projects.push(project);
  run("git", ["init", "--initial-branch=main"], project);
  run("git", ["config", "user.email", "test@example.invalid"], project);
  run("git", ["config", "user.name", "Test"], project);
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "has space.ts"), [
    "export function changed(value: boolean): number {",
    "  return value ? 1 : 0;",
    "}",
    "export function untouched(): number { return 2; }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, "coverage.json"), "{}");
  run("git", ["add", "."], project);
  run("git", ["commit", "-m", "base"], project);
  return project;
}

function projectWithChangedFunction(): string {
  const project = projectWithBaseSource();
  run("git", ["checkout", "-b", "feature"], project);
  fs.writeFileSync(path.join(project, "src", "has space.ts"), [
    "export function changed(value: boolean): number {",
    "  return value ? 2 : 0;",
    "}",
    "export function untouched(): number { return 2; }",
    "",
  ].join("\n"));
  run("git", ["add", "."], project);
  run("git", ["commit", "-m", "change"], project);
  return project;
}

function runCli(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    return { code: 0, stdout: run(TSX_BIN, [CLI_SOURCE, ...args], cwd), stderr: "" };
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

afterEach(() => {
  for (const project of projects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
});

describe("changed-only CLI", () => {
  it("reports changed-only JSON metadata and only changed functions", () => {
    const project = projectWithChangedFunction();
    const result = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "main", "--threshold", "100", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.filter).toMatchObject({ mode: "changed", changedSince: "main" });
    expect(report.rows.map((row: { name: string }) => row.name)).toEqual(["changed"]);
  });

  it("keeps an unchanged nested function's statements out of a changed outer function", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-changed-nested-"));
    projects.push(project);
    run("git", ["init", "--initial-branch=main"], project);
    run("git", ["config", "user.email", "test@example.invalid"], project);
    run("git", ["config", "user.name", "Test"], project);
    fs.mkdirSync(path.join(project, "src"));
    const sourcePath = path.join(project, "src", "nested.ts");
    const base = [
      "export function outer(): number {",
      "  const nested = (): number => {",
      "    return 7;",
      "  };",
      "  return nested() + 0;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(sourcePath, base);
    fs.writeFileSync(path.join(project, "coverage.json"), JSON.stringify({
      [sourcePath]: {
        path: sourcePath,
        fnMap: {
          "0": { name: "outer", decl: { start: { line: 1, column: 16 }, end: { line: 1, column: 21 } }, loc: { start: { line: 1, column: 0 }, end: { line: 6, column: 1 } } },
          "1": { name: "nested", decl: { start: { line: 2, column: 8 }, end: { line: 2, column: 14 } }, loc: { start: { line: 2, column: 17 }, end: { line: 4, column: 3 } } },
        },
        f: { "0": 1, "1": 0 },
        statementMap: {
          "0": { start: { line: 3, column: 4 }, end: { line: 3, column: 13 } },
          "1": { start: { line: 5, column: 2 }, end: { line: 5, column: 22 } },
        },
        s: { "0": 0, "1": 1 },
      },
    }));
    run("git", ["add", "."], project);
    run("git", ["commit", "-m", "base"], project);
    run("git", ["checkout", "-b", "feature"], project);
    fs.writeFileSync(sourcePath, base.replace("+ 0", "+ 1"));
    run("git", ["add", "."], project);
    run("git", ["commit", "-m", "change outer"], project);

    const result = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "main", "--threshold", "100", "--json"]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.filter).toMatchObject({ mode: "changed", changedSince: "main" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      name: "outer",
      totalStatements: 1,
      coveredStatements: 1,
      coverage: 1,
    });
  });

  it("does not select functions for an R100 pure rename", () => {
    const project = projectWithBaseSource();
    run("git", ["checkout", "-b", "feature"], project);
    run("git", ["mv", "src/has space.ts", "src/renamed.ts"], project);
    run("git", ["commit", "-am", "rename source"], project);

    const nameStatus = run("git", ["diff", "--name-status", "-z", "--find-renames", "main", "HEAD"], project);
    expect(nameStatus.split("\0")[0]).toBe("R100");

    const result = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "main", "--threshold", "100", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).rows).toEqual([]);
  });

  it("selects an edited function after an R<100 rename", () => {
    const project = projectWithBaseSource();
    run("git", ["checkout", "-b", "feature"], project);
    const source = path.join(project, "src", "has space.ts");
    run("git", ["mv", source, path.join(project, "src", "renamed.ts")], project);
    fs.writeFileSync(path.join(project, "src", "renamed.ts"), [
      "export function changed(value: boolean): number {",
      "  if (value) return 3;",
      "  return 0;",
      "}",
      "export function untouched(): number { return 2; }",
      "",
    ].join("\n"));
    run("git", ["add", "."], project);
    run("git", ["commit", "-m", "rename and edit source"], project);

    const nameStatus = run("git", ["diff", "--name-status", "-z", "--find-renames", "main", "HEAD"], project);
    const renameStatus = nameStatus.split("\0")[0] ?? "";
    expect(renameStatus).toMatch(/^R\d+$/);
    expect(Number(renameStatus.slice(1))).toBeLessThan(100);

    const result = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "main", "--threshold", "100", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).rows.map((row: { name: string }) => row.name)).toContain("changed");
  });

  it("resolves changed Git paths from the repository root when invoked from a nested directory", () => {
    const project = projectWithChangedFunction();
    const nested = path.join(project, "nested");
    fs.mkdirSync(nested);
    const changed = collectChangedFiles("main", nested);
    const sourcePath = fs.realpathSync.native(path.join(project, "src", "has space.ts"));
    expect([...changed.files.keys()]).toEqual([sourcePath]);
    expect(discoverSourceFiles([path.resolve(nested, "../src")]).filter((filePath) => changed.files.has(filePath))).toEqual([sourcePath]);

    const result = runCli(nested, ["../src", "--coverage", "../coverage.json", "--changed-since", "main", "--threshold", "100", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).rows.map((row: { name: string }) => row.name)).toEqual(["changed"]);
  });

  it("uses an explicit changed-since value over config and reports no eligible changed functions honestly", () => {
    const project = projectWithChangedFunction();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({
      version: 1, src: "src", changedSince: "HEAD", threshold: 100,
    }));
    const result = runCli(project, ["--coverage", "coverage.json", "--changed-since", "main"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Changed-only mode");

    const empty = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "HEAD", "--json"]);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ rows: [], filter: { mode: "changed", changedSince: "HEAD" } });
  });

  it("rejects uncommitted TypeScript worktree files instead of analyzing a moving target", () => {
    const project = projectWithChangedFunction();
    fs.writeFileSync(path.join(project, "src", "untracked.ts"), "export function untracked() { return 1; }\n");
    const result = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "main"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("clean TypeScript worktree");
  });

  it("returns exit 1 for an unavailable changed-since ref", () => {
    const project = projectWithChangedFunction();
    const result = runCli(project, ["src", "--coverage", "coverage.json", "--changed-since", "missing-ref"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot resolve git ref");
  });
});
