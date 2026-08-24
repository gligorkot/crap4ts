import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

  it("runs only the locally installed CLI without PATH/global resolution, npx, install, or fetch", () => {
    expect(action).toContain("$GITHUB_WORKSPACE/node_modules/.bin/crap4ts");
    expect(action).not.toContain("command -v crap4ts");
    expect(action).not.toContain("npx ");
    // npm install may only appear inside the error-message string, never as
    // an executed command (line-initial).
    expect(action).not.toMatch(/^(\s*)(npm install|npm ci|npm exec)/m);
    expect(action).not.toMatch(/curl|wget|fetch /);
    // No committed bundle architecture.
    expect(action).not.toContain("action/action.cjs");
    expect(action).not.toContain("action/summary.cjs");
  });

  it("loads the renderer from the installed scoped package, never from the action checkout", () => {
    expect(action).toContain("$GITHUB_WORKSPACE/node_modules/@gligorkot/crap4ts/dist/cjs/report.js");
    expect(action).not.toContain("GITHUB_ACTION_PATH");
    expect(action).toContain("Renderer not found");
  });

  it("fails with a clear error when the installed CLI is absent", () => {
    expect(action).toContain("crap4ts CLI not found at");
    expect(action).toContain("npm install --save-dev @gligorkot/crap4ts");
  });

  it("writes the markdown report to GITHUB_STEP_SUMMARY from a single CLI run's JSON", () => {
    expect(action).toContain("GITHUB_STEP_SUMMARY");
    expect(action).toContain("--format json");
    const jsonRunIndex = action.indexOf("--format json");
    const summaryIndex = action.indexOf("renderMarkdownReport");
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
    const outputsIndex = action.indexOf("GITHUB_OUTPUT");
    const summaryIndex = action.indexOf("renderMarkdownReport");
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

describe("action step semantics (controlled local CLI fixture)", () => {
  // A tiny fake CLI standing in for the real crap4ts bin. It reproduces the
  // CLI's JSON contract and exit codes so the action step's shell logic
  // (outputs, summary rendering, exit-code propagation) is exercised for
  // real — without shipping or requiring a committed bundle.
  const fixtureCli = join(testDirectory, "fixtures", "fake-crap4ts.cjs");

  const runStep = (threshold: string): { status: number; outputs: Record<string, string>; summary: string } => {
    const workdir = mkdtempSync(join(tmpdir(), "crap4ts-action-step-"));
    try {
      const binDir = join(workdir, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, "crap4ts");
      // The fixture already carries a node shebang; make it executable.
      copyFileSync(fixtureCli, bin);
      chmodSync(bin, 0o755);

      // Simulate the installed scoped package: an action checkout does not
      // ship dist/, so the renderer must be resolved from the consumer's
      // node_modules, exactly as npm lays it out.
      const rendererSourceDir = join(projectRoot, "dist", "cjs");
      expect(existsSync(join(rendererSourceDir, "report.js"))).toBe(true); // produced by `npm run build` before tests
      const rendererTargetDir = join(workdir, "node_modules", "@gligorkot", "crap4ts", "dist", "cjs");
      mkdirSync(rendererTargetDir, { recursive: true });
      for (const file of readdirSync(rendererSourceDir)) {
        if (file.endsWith(".js")) copyFileSync(join(rendererSourceDir, file), join(rendererTargetDir, file));
      }

      const summaryFile = join(workdir, "summary.md");
      const outputFile = join(workdir, "github-output.txt");
      writeFileSync(summaryFile, "");
      writeFileSync(join(workdir, "coverage-final.json"), "{}");

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITHUB_WORKSPACE: workdir,
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_OUTPUT: outputFile,
        COVERAGE_FILE: "coverage-final.json",
        SOURCE_PATH: "src",
        CRAP_THRESHOLD: threshold,
        // No GITHUB_ACTION_PATH: the action must not depend on the checkout.
      };

      // Extract the action's run: script and execute it verbatim
      // (through the final `exit "$status"`).
      const runMatch = action.match(/run: \|\n([\s\S]*?)\n\s*$/);
      expect(runMatch).not.toBeNull();
      const script = runMatch![1]
        .split("\n")
        .map((line) => line.replace(/^        /, ""))
        .join("\n");
      writeFileSync(join(workdir, "step.sh"), script);

      let status = 0;
      try {
        execFileSync("bash", [join(workdir, "step.sh")], { cwd: workdir, env, encoding: "utf8" });
      } catch (error) {
        status = (error as { status?: number }).status ?? 1;
      }

      const outputs = Object.fromEntries(
        readFileSync(outputFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const eq = line.indexOf("=");
            return [line.slice(0, eq), line.slice(eq + 1)];
          }),
      );
      return { status, outputs, summary: readFileSync(summaryFile, "utf8") };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  };

  beforeAll(() => {
    // The Action resolves the renderer from an installed package's `dist/cjs`.
    // Build it here so `npm test` also works from a clean checkout.
    execFileSync("npm", ["run", "build"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(existsSync(join(projectRoot, "dist", "cjs", "report.js"))).toBe(true);
  });

  it("breach: exit 2, pass=false, outputs written, FAIL rendered in summary", () => {
    const result = runStep("8");
    expect(result.status).toBe(2);
    expect(Number(result.outputs["breached-count"])).toBeGreaterThan(0);
    expect(result.outputs["pass"]).toBe("false");
    expect(result.outputs["max-crap"]).not.toBe("0.0");
    expect(result.summary).toContain("## CRAP Report");
    expect(result.summary).toContain("FAIL");
  });

  it("pass: exit 0, pass=true, PASS rendered in summary", () => {
    const result = runStep("10000");
    expect(result.status).toBe(0);
    expect(result.outputs["breached-count"]).toBe("0");
    expect(result.outputs["pass"]).toBe("true");
    expect(result.summary).toContain("PASS");
  });

  it("renders dynamic file names as escaped literal code spans", () => {
    const result = runStep("8");
    expect(result.summary).toMatch(/`[^`]*sample\\.ts[^`]*`/);
  });
});
