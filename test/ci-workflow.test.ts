import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(testDirectory, "../.github/workflows/ci.yml");
const workflow = readFileSync(workflowPath, "utf8");

describe("CI CRAP report", () => {
  it("publishes the built CLI's Markdown report without masking unexpected errors", () => {
    expect(workflow).toContain("name: CRAP report (threshold 8; report-only)");
    expect(workflow).toContain(
      "node dist/cli.js src --coverage coverage/coverage-final.json --threshold 8 --format markdown",
    );
    // The CLI output is captured, not piped straight into the summary.
    expect(workflow).toContain('> "$report_output"');
    // Exit 2 (threshold breach) publishes the report; any other nonzero exit
    // fails the job and never appends the report to the summary.
    expect(workflow).toContain('if [[ "$status" -eq 0 || "$status" -eq 2 ]]; then');
    expect(workflow).not.toContain('>> "$GITHUB_STEP_SUMMARY" 2>&1');
  });

  it("appends only valid GitHub Markdown — no fenced text code block around the report", () => {
    const reportStepStart = workflow.indexOf("name: CRAP report (threshold 8; report-only)");
    const reportStepEnd = workflow.indexOf("- name:", reportStepStart);
    const reportStep = workflow.slice(reportStepStart, reportStepEnd);

    expect(reportStep).toContain("$GITHUB_STEP_SUMMARY");
    for (const fence of ["```text", "\n```"]) {
      expect(reportStep).not.toContain(fence);
    }
  });

  it("keeps unexpected errors out of the summary", () => {
    const reportStepStart = workflow.indexOf("name: CRAP report (threshold 8; report-only)");
    const reportStepEnd = workflow.indexOf("- name:", reportStepStart);
    const reportStep = workflow.slice(reportStepStart, reportStepEnd);

    // On unexpected failure, output goes to the job log via >&2, not the summary.
    expect(reportStep).toContain('cat "$report_output" >&2');
    expect(reportStep).toContain('exit "$status"');
  });

  it("keeps the strict self-score audit after the report", () => {
    const reportStep = workflow.indexOf("name: CRAP report (threshold 8; report-only)");
    const selfScoreStep = workflow.indexOf("name: Self-score (assert expected threshold breach)");

    expect(reportStep).toBeGreaterThan(-1);
    expect(selfScoreStep).toBeGreaterThan(reportStep);
    expect(workflow).toContain("temporary threshold of 30");
  });

  // Executable test: run the actual step script under bash with a fake CLI.
  // An unexpected exit (e.g. 1) must leave an initially populated summary
  // byte-for-byte unchanged, and captured output must go only to stderr.
  describe("workflow shell behaviour", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ci-workflow-"));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    function extractReportStepScript(): string {
      const start = workflow.indexOf("run: |\n", workflow.indexOf("name: CRAP report"));
      const scriptStart = workflow.indexOf("\n", start) + 1;
      const end = workflow.indexOf("\n      - name:", scriptStart);
      return workflow.slice(scriptStart, end).replace(/^ {10}/gm, "");
    }

    function writeSummaryFile(): string {
      const summaryPath = join(scratch, "summary.md");
      const initialSummary = "# Existing summary\n\nPre-existing content.\n";
      writeFileSync(summaryPath, initialSummary);
      return initialSummary;
    }

    function runScript(fakeCliExit: number): { stdout: string; stderr: string } {
      mkdirSync(join(scratch, "dist"), { recursive: true });
      writeFileSync(
        join(scratch, "dist", "cli.js"),
        `process.stderr.write("cli diagnostic\\n"); process.exit(${fakeCliExit});\n`,
      );
      writeSummaryFile();

      const env = { ...process.env, GITHUB_STEP_SUMMARY: join(scratch, "summary.md") };
      const result = spawnSync("bash", ["-c", extractReportStepScript()], {
        cwd: scratch,
        env,
        encoding: "utf8",
      });
      if (fakeCliExit === 0 || fakeCliExit === 2) {
        expect(result.status).toBe(0);
      } else {
        expect(result.status).toBe(fakeCliExit);
      }
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }

    it("unexpected CLI failure leaves an initially populated summary untouched and logs only to stderr", () => {
      const before = writeSummaryFile();
      const { stderr } = runScript(1);

      expect(readFileSync(join(scratch, "summary.md"), "utf8")).toBe(before);
      expect(stderr).toContain("failed unexpectedly with exit 1");
      expect(stderr).toContain("cli diagnostic");
    });

    it("expected exit 2 appends policy block, report, and note to the summary", () => {
      const before = writeSummaryFile();
      runScript(2);

      const after = readFileSync(join(scratch, "summary.md"), "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain("Temporary policy");
      expect(after).toContain("exited 2 as expected");
    });
  });
});
