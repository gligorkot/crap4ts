import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const FIXTURE = path.resolve(__dirname, "fixtures/sample.ts");
const COVERAGE = path.resolve(__dirname, "fixtures/coverage-sample.json");

/**
 * Run the CLI from source TypeScript via tsx, so tests do not depend on a
 * pre-existing dist/ build artefact.
 *
 * We invoke `npx tsx src/cli.ts` so a freshly cloned checkout with `npm ci`
 * can run the full suite without `npm run build`.
 */
function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const src = path.resolve(__dirname, "../src/cli.ts");
  try {
    const stdout = execFileSync("npx", ["tsx", src, ...args], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: err.status ?? 1,
    };
  }
}

describe("CLI integration", () => {
  it("produces a human report and exits 2 on threshold breach", () => {
    const result = runCli([FIXTURE, "--coverage", COVERAGE, "--threshold", "8"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("CRAP Report");
    expect(result.stdout).toContain("Gate:          FAIL");
    expect(result.stderr).toContain("CRAP threshold exceeded");
  });

  it("produces JSON output with --json", () => {
    const result = runCli([FIXTURE, "--coverage", COVERAGE, "--json", "--threshold", "100"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.rows).toBeInstanceOf(Array);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.summary.threshold).toBe(100);
    expect(parsed.summary.breached).toBe(false);
  });

  it("exits 0 when all scores are at or below threshold", () => {
    const result = runCli([FIXTURE, "--coverage", COVERAGE, "--threshold", "100"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Gate:          PASS");
  });

  it("exits 1 with no stack trace for missing --coverage", () => {
    const result = runCli([FIXTURE]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--coverage is required");
    expect(result.stderr).not.toContain("at ");
  });

  it("exits 1 for invalid threshold value", () => {
    const result = runCli([FIXTURE, "--coverage", COVERAGE, "--threshold", "abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("non-negative number");
    expect(result.stderr).not.toContain("at ");
  });

  it("exits 1 for unknown options", () => {
    const result = runCli([FIXTURE, "--coverage", COVERAGE, "--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown option");
  });

  it("exits 1 for nonexistent coverage file", () => {
    const result = runCli([FIXTURE, "--coverage", "/no/such/file.json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error:");
    expect(result.stderr).not.toContain("at ");
  });

  it("exits 0 with --help", () => {
    const result = runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("exits 1 when a source path does not exist", () => {
    const result = runCli(["/nonexistent/path", "--coverage", COVERAGE, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error:");
    expect(result.stderr).not.toContain("at ");
  });
});
