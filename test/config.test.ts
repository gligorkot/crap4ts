import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defineConfig,
  isConfigExcluded,
  loadConfig,
  matchesConfigPattern,
  thresholdForPath,
} from "../src/config.js";

const CLI_SOURCE = path.resolve(__dirname, "../src/cli.ts");
const CLI_DIST = path.resolve(__dirname, "../dist/cli.js");
const COVERAGE = path.resolve(__dirname, "fixtures/coverage-sample.json");
const SAMPLE = path.resolve(__dirname, "fixtures/sample.ts");
const tempDirs: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-config-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.copyFileSync(SAMPLE, path.join(dir, "src", "sample.ts"));
  fs.copyFileSync(COVERAGE, path.join(dir, "coverage.json"));
  return dir;
}

function runCli(
  cwd: string,
  args: string[],
  dist = false,
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(
      dist ? process.execPath : "npx",
      dist ? [CLI_DIST, ...args] : ["tsx", CLI_SOURCE, ...args],
      { cwd, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return { stdout, stderr: "", code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1 };
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("configuration", () => {
  it("validates defineConfig and applies deterministic path matching directly", async () => {
    const project = tempProject();
    const config = defineConfig({
      version: 1,
      src: "src",
      exclude: ["src/ignored.ts"],
      threshold: 8,
      thresholds: [
        { glob: "src/**/*.ts", threshold: 6 },
        { glob: "src/sample.ts", threshold: 4 },
      ],
    });
    const sample = path.join(project, "src", "sample.ts");
    expect(matchesConfigPattern(sample, project, "src/**/*.ts")).toBe(true);
    expect(thresholdForPath(sample, project, config, undefined)).toBe(4);
    expect(thresholdForPath(sample, project, config, 2)).toBe(2);
    expect(isConfigExcluded(path.join(project, "src", "ignored.ts"), project, config)).toBe(true);
    expect(() => defineConfig({ version: 1, src: "src", unknown: true } as never)).toThrow("unknown property");
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify(config));
    expect((await loadConfig(project))?.config.threshold).toBe(8);
  });

  it("discovers config files in TS, JS, then JSON precedence", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({ version: 1, src: "src", threshold: 100 }));
    fs.writeFileSync(path.join(project, "crap4ts.config.js"), "export default { version: 1, src: 'src', threshold: 50 };\n");
    fs.writeFileSync(path.join(project, "crap4ts.config.ts"), "export default { version: 1, src: 'src', threshold: 1 };\n");

    const result = runCli(project, ["--coverage", "coverage.json", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).summary.threshold).toBe(1);
  });

  it("uses exactly the explicit config path", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "crap4ts.config.ts"), "export default { version: 1, src: 'src', threshold: 20 };\n");
    fs.writeFileSync(path.join(project, "chosen.json"), JSON.stringify({ version: 1, src: "src", threshold: 100 }));

    const result = runCli(project, ["--config", "chosen.json", "--coverage", "coverage.json", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).summary.threshold).toBe(100);
  });

  it("rejects a missing or invalid discovered config as input errors", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "crap4ts.config.js"), "export default { version: 2, src: 'src' };\n");

    const result = runCli(project, ["--coverage", "coverage.json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("config");
    expect(runCli(project, ["--config", "missing.json", "--coverage", "coverage.json"]).code).toBe(1);
  });

  it("lets explicit CLI values override config values", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({ version: 1, src: "src", threshold: 1 }));

    const result = runCli(project, ["src", "--coverage", "coverage.json", "--threshold", "100", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).summary.threshold).toBe(100);
  });

  it("uses the most-specific matching threshold rule and first rule on ties", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({
      version: 1,
      src: "src",
      threshold: 100,
      thresholds: [
        { glob: "src/**/*.ts", threshold: 30 },
        { glob: "src/sample.ts", threshold: 1 },
        { glob: "src/sample.ts", threshold: 2 },
        { glob: "src/*.ts", threshold: 10 },
      ],
    }));

    const result = runCli(project, ["--coverage", "coverage.json", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).rows.every((row: { threshold: number }) => row.threshold === 1)).toBe(true);
  });

  it("renders applicable per-path thresholds in JSON and human reports", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({
      version: 1, src: "src", threshold: 100, thresholds: [{ glob: "src/**/*.ts", threshold: 10 }],
    }));

    const json = runCli(project, ["--coverage", "coverage.json", "--json"]);
    expect(JSON.parse(json.stdout).rows[0].threshold).toBe(10);
    const human = runCli(project, ["--coverage", "coverage.json"]);
    expect(human.stdout).toContain("Threshold");
    expect(human.stdout).toMatch(/\b10(?:\.0)?\b/);
  });

  it("applies config exclusion patterns without bypassing default exclusions", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "src", "ignored.ts"), "export function ignored() { return 1; }\n");
    fs.mkdirSync(path.join(project, "src", "node_modules"));
    fs.writeFileSync(path.join(project, "src", "node_modules", "also-ignored.ts"), "export function nope() { return 1; }\n");
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({ version: 1, src: "src", exclude: ["src/ignored.ts"], threshold: 100 }));

    const result = runCli(project, ["--coverage", "coverage.json", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).rows.map((row: { filePath: string }) => row.filePath)).not.toContainEqual(expect.stringContaining("ignored.ts"));
  });

  it("runs a TypeScript config through a clean built CLI without tsx", () => {
    execFileSync("npm", ["run", "build"], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const project = tempProject();
    fs.writeFileSync(path.join(project, "crap4ts.config.ts"), "export default { version: 1, src: 'src', threshold: 100 };\n");

    const result = runCli(project, ["--coverage", "coverage.json", "--json"], true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).summary.threshold).toBe(100);
  });
});
