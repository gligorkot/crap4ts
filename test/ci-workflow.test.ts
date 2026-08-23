import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(testDirectory, "../.github/workflows/ci.yml");
const workflow = readFileSync(workflowPath, "utf8");

describe("CI CRAP report", () => {
  it("publishes the built CLI's threshold-8 report without masking unexpected errors", () => {
    expect(workflow).toContain("name: CRAP report (threshold 8; report-only)");
    expect(workflow).toContain(
      "node dist/cli.js src --coverage coverage/coverage-final.json --threshold 8",
    );
    expect(workflow).toContain('>> "$GITHUB_STEP_SUMMARY" 2>&1');
    expect(workflow).toContain('if [[ "$status" -ne 0 && "$status" -ne 2 ]]; then');
    expect(workflow).toContain('exit "$status"');
  });

  it("keeps the strict self-score audit after the report", () => {
    const reportStep = workflow.indexOf("name: CRAP report (threshold 8; report-only)");
    const selfScoreStep = workflow.indexOf("name: Self-score (assert expected threshold breach)");

    expect(reportStep).toBeGreaterThan(-1);
    expect(selfScoreStep).toBeGreaterThan(reportStep);
    expect(workflow).toContain("temporary threshold of 30");
  });
});
