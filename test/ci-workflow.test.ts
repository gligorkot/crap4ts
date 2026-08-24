import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
});
