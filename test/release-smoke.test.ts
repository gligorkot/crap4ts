import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const publishWorkflow = readFileSync(
  resolve(projectRoot, ".github/workflows/publish.yml"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
  version: string;
  scripts: Record<string, string>;
};
const smokeScript = readFileSync(resolve(projectRoot, "scripts/release-smoke.ts"), "utf8");
const changelog = readFileSync(resolve(projectRoot, "CHANGELOG.md"), "utf8");

describe("release smoke wiring", () => {
  it("exposes the smoke check as an npm script", () => {
    expect(packageJson.scripts["release-smoke"]).toBe("tsx scripts/release-smoke.ts");
  });

  it("runs the smoke check in the publish workflow before npm publish, only when publishing", () => {
    const smokeStep = publishWorkflow.indexOf("Release tarball smoke check");
    const publishStep = publishWorkflow.indexOf("run: npm publish");
    expect(smokeStep).toBeGreaterThan(-1);
    expect(publishStep).toBeGreaterThan(smokeStep);
    const stepBlock = publishWorkflow.slice(smokeStep, publishStep);
    expect(stepBlock).toContain("npm run release-smoke");
    expect(stepBlock).toContain("if: steps.version.outputs.published == 'false'");
    expect(publishWorkflow.indexOf("run: npm publish")).toBeGreaterThan(smokeStep);
  });

  it("packs and installs the real tarball into a fresh temp consumer without lifecycle scripts", () => {
    expect(smokeScript).toContain('"pack"');
    expect(smokeScript).toContain("--ignore-scripts");
    expect(smokeScript).toContain("mkdtempSync");
    expect(smokeScript).toContain('rmSync(workspace');
  });

  it("exercises every public delivery surface of the installed package", () => {
    expect(smokeScript).toContain(".bin");
    expect(smokeScript).toContain('import { computeCrap');
    expect(smokeScript).toContain("require(");
    expect(smokeScript).toContain("defineConfig({");
    expect(smokeScript).toContain("crap4ts.config.ts");
  });

  it("cleans up its temporary directory even on failure", () => {
    expect(smokeScript).toMatch(/finally\s*\{\s*rmSync\(workspace/);
  });
});

describe("release metadata", () => {
  it("is version 1.0.0", () => {
    expect(packageJson.version).toBe("1.0.0");
    const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe("1.0.0");
    expect(lock.packages[""]?.version).toBe("1.0.0");
  });

  it("documents the static-config breaking change for consumers", () => {
    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain("## 1.0.0");
    expect(changelog).toContain("static declarative");
    expect(changelog).toContain("never executes configuration files");
    expect(changelog).toContain("defineConfig({ ... })");
    expect(changelog).toContain("Migrating to 1.0.0");
  });
});
