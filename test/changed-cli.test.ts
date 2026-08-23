import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI_SOURCE = path.resolve(__dirname, "../src/cli.ts");
const projects: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function projectWithChangedFunction(): string {
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
    return { code: 0, stdout: run("npx", ["tsx", CLI_SOURCE, ...args], cwd), stderr: "" };
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
