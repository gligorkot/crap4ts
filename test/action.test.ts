import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const actionPath = resolve(testDirectory, "../action.yml");
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
      expect(action).toMatch(new RegExp(`steps.report.outputs.${output}`));
    }
  });

  it("writes the markdown report to GITHUB_STEP_SUMMARY", () => {
    expect(action).toContain("--format markdown");
    expect(action).toContain(">> \"$GITHUB_STEP_SUMMARY\"");
  });

  it("does not install or fetch dependencies", () => {
    expect(action).not.toContain("npm ci");
    expect(action).not.toContain("npm install");
    expect(action).not.toContain("npx ");
    expect(action).toContain("./node_modules/.bin/crap4ts");
  });

  it("fails fast when coverage is missing", () => {
    expect(action).toContain("Coverage file not found");
  });

  it("treats exit code 2 (threshold breach) as a valid report run", () => {
    expect(action).toContain('"$status" -ne 0 && "$status" -ne 2');
  });
});
