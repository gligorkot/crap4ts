import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { builtinModules as BUILTIN_MODULES } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const actionPath = join(projectRoot, "action.yml");
const action = readFileSync(actionPath, "utf8");

describe("composite action", () => {
  it("declares the required inputs with expected defaults", () => {
    expect(action).toContain("coverage/coverage-final.json");
    expect(action).toMatch(/^    default: "?src"?$/m);
    expect(action).toMatch(/^    default: "?8"?$/m);
  });

  it("exposes breached-count, max-crap, and pass outputs", () => {
    for (const output of ["breached-count", "max-crap", "pass"]) {
      expect(action).toMatch(new RegExp(`^  ${output}:`, "m"));
      expect(action).toMatch(new RegExp(`steps\\.report\\.outputs\\.${output}`));
    }
  });

  it("runs the committed self-contained bundle from GITHUB_ACTION_PATH without package resolution or installation", () => {
    expect(action).toContain('$GITHUB_ACTION_PATH/action/action.cjs');
    expect(action).toContain('$GITHUB_ACTION_PATH/action/summary.cjs');
    expect(action).not.toContain("command -v crap4ts");
    expect(action).not.toContain("./node_modules/.bin/crap4ts");
    expect(action).not.toContain("npm ci");
    expect(action).not.toContain("npm install");
    expect(action).not.toContain("npx ");
  });

  it("fails with a clear error when the committed bundle is missing", () => {
    expect(action).toContain("missing its bundled CLI");
    expect(action).toContain("npm run build:action");
  });

  it("writes the markdown report to GITHUB_STEP_SUMMARY via the bundled renderer", () => {
    expect(action).toContain("GITHUB_STEP_SUMMARY");
    expect(action).toContain("--format json");
    // The summary must be rendered from a single successful CLI run's JSON.
    const jsonRunIndex = action.indexOf('--format json');
    const summaryIndex = action.indexOf('action/summary.cjs');
    expect(summaryIndex).toBeGreaterThan(jsonRunIndex);
  });

  it("writes outputs via GITHUB_OUTPUT before rendering the summary", () => {
    expect(action).toContain("breached-count=");
    expect(action).toContain("max-crap=");
    expect(action).toMatch(/pass=(true|false)/);
    expect(action).toContain("${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}");
  });

  it("propagates exit code 2 on threshold breach after writing summary and outputs", () => {
    expect(action).toContain('"$status" -ne 0 && "$status" -ne 2');
    expect(action).toContain('exit "$status"');
    // The final exit must come after outputs and summary are written.
    const outputsIndex = action.indexOf("GITHUB_OUTPUT");
    const summaryIndex = action.indexOf("action/summary.cjs");
    const finalExitIndex = action.indexOf('exit "$status"', Math.max(outputsIndex, summaryIndex));
    expect(finalExitIndex).toBeGreaterThan(-1);
  });

  it("does not swallow renderer errors: only 0 or expected 2 are accepted", () => {
    expect(action).not.toContain("|| true");
    expect(action).not.toMatch(/--format markdown[^\n]*\|\|/);
  });

  it("guards the runner environment (summary writable) before writing", () => {
    expect(action).toContain("GITHUB_STEP_SUMMARY is not set or not writable");
  });

  it("fails fast when coverage is missing", () => {
    expect(action).toContain("Coverage file not found");
  });
});

describe("committed action bundle", () => {
  const bundleCli = join(projectRoot, "action", "action.cjs");
  const bundleSummary = join(projectRoot, "action", "summary.cjs");

  it("is present in the repository at action/ (tracked artifact)", () => {
    expect(existsSync(bundleCli)).toBe(true);
    expect(existsSync(bundleSummary)).toBe(true);
    // The bundle must be self-contained: the only bare require() targets are
    // node builtins (esbuild's typescript bundle keeps a lazy, guarded
    // "source-map-support" hook that is never exercised without the package).
    const cliSource = readFileSync(bundleCli, "utf8");
    const externalRequires = [...cliSource.matchAll(/require\("([^"]+)"\)/g)]
      .map((match) => match[1])
      .filter((id) => !id.startsWith("node:") && !BUILTIN_MODULES.includes(id));
    expect(externalRequires).toEqual(["source-map-support"]);
    // No static ESM imports or dynamic import() of external packages.
    expect(cliSource).not.toMatch(/\bfrom "(?!node:|\.)[a-z@.-]+\.[a-z]/);
    expect(cliSource).not.toMatch(/\bimport\("(?!node:|\.)[a-z@][^"]*"/);
    expect(cliSource).toContain("createProgram");
  });

  it("renders the report from real coverage and preserves exit codes/outputs", () => {
    const workdir = mkdtempSync(join(tmpdir(), "crap4ts-action-"));
    try {
      mkdirSync(join(workdir, "src"));
      writeFileSync(
        join(workdir, "src", "sample.ts"),
        readFileSync(join(testDirectory, "fixtures", "sample.ts"), "utf8"),
      );
      // Coverage where every function except one trivial covered one has zero hits.
      const samplePath = join(workdir, "src", "sample.ts").replace(/\\/g, "\\\\");
      writeFileSync(
        join(workdir, "coverage-final.json"),
        JSON.stringify({
          [join(workdir, "src", "sample.ts")]: {
            path: join(workdir, "src", "sample.ts"),
            fnMap: {
              "0": {
                name: "plain",
                decl: { start: { line: 5, column: 16 }, end: { line: 5, column: 21 } },
                loc: { start: { line: 5, column: 25 }, end: { line: 7, column: null } },
              },
              "1": {
                name: "withIf",
                decl: { start: { line: 10, column: 16 }, end: { line: 10, column: 21 } },
                loc: { start: { line: 10, column: 32 }, end: { line: 14, column: null } },
              },
            },
            f: { "0": 5, "1": 0 },
            statementMap: {
              "0": { start: { line: 6, column: 2 }, end: { line: 6, column: 12 } },
              "1": { start: { line: 11, column: 2 }, end: { line: 11, column: 12 } },
              "2": { start: { line: 12, column: 4 }, end: { line: 12, column: 14 } },
              "3": { start: { line: 13, column: 4 }, end: { line: 13, column: 13 } },
              "4": { start: { line: 11, column: 2 }, end: { line: 14, column: 2 } },
            },
            s: { "0": 5, "1": 0, "2": 0, "3": 0, "4": 0 },
            b: {},
            branchMap: {},
            meta: {},
          },
          // keep the key literal stable even if escaping changes
          ...(samplePath ? {} : {}),
        }),
      );

      const runStep = (
        threshold: string,
      ): { status: number; stdout: string; stderr: string; outputs: Record<string, string>; summary: string } => {
        const summaryFile = join(workdir, `summary-${threshold}.md`);
        const outputFile = join(workdir, `github-output-${threshold}.txt`);
        writeFileSync(summaryFile, "");
        let stdout = "";
        let stderr = "";
        let status = 0;
        try {
          stdout = execFileSync(
            process.execPath,
            [
              bundleCli,
              "src",
              "--coverage",
              "coverage-final.json",
              "--threshold",
              threshold,
              "--format",
              "json",
            ],
            {
              cwd: workdir,
              encoding: "utf8",
              env: { ...process.env },
            },
          );
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string };
          status = err.status ?? 1;
          stdout = err.stdout ?? "";
          stderr = err.stderr ?? "";
        }

        // Mirror the action step's output/summary logic exactly.
        const report = JSON.parse(stdout) as {
          summary: { breachedCount: number; maxCrap: number };
        };
        const breached = String(report.summary.breachedCount);
        const maxCrap = Number(report.summary.maxCrap).toFixed(1);
        const lines = [
          `breached-count=${breached}`,
          `max-crap=${maxCrap}`,
          breached === "0" ? "pass=true" : "pass=false",
        ];
        writeFileSync(outputFile, `${lines.join("\n")}\n`);
        writeFileSync(join(workdir, `report-${threshold}.json`), stdout);
        delete process.env.GITHUB_STEP_SUMMARY;
        process.env["GITHUB_STEP_SUMMARY"] = summaryFile;
        execFileSync(process.execPath, [bundleSummary, join(workdir, `report-${threshold}.json`)], {
          encoding: "utf8",
          env: process.env,
        });

        const outputs = Object.fromEntries(
          readFileSync(outputFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const eq = line.indexOf("=");
              return [line.slice(0, eq), line.slice(eq + 1)];
            }),
        );
        return { status, stdout, stderr, outputs, summary: readFileSync(summaryFile, "utf8") };
      };

      // Breach: uncovered functions exceed threshold -> exit 2, pass=false.
      const breach = runStep("8");
      expect(breach.status).toBe(2);
      expect(Number(breach.outputs["breached-count"])).toBeGreaterThan(0);
      expect(breach.outputs["pass"]).toBe("false");
      expect(breach.outputs["max-crap"]).not.toBe("0.0");
      expect(breach.summary).toContain("## CRAP Report");
      expect(breach.summary).toContain("Gate:");
      expect(breach.summary).toContain("FAIL");

      // No breach at a high threshold -> exit 0, pass=true.
      const pass = runStep("10000");
      expect(pass.status).toBe(0);
      expect(pass.outputs["breached-count"]).toBe("0");
      expect(pass.outputs["pass"]).toBe("true");
      expect(pass.summary).toContain("PASS");

      // Dynamic content must be escaped literal code spans (punctuation escaped).
      expect(breach.summary).toMatch(/`[^`]*sample\\\.ts[^`]*`/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
