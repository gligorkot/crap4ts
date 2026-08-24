import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const workflowPath = resolve(projectRoot, ".github/workflows/publish.yml");
const workflow = readFileSync(workflowPath, "utf8");
const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
  name: string;
  repository?: { type: string; url: string };
};
const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

describe("npm publish workflow", () => {
  it("serializes publish runs without cancelling in-flight publishes", () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: npm-publish\n {2}cancel-in-progress: false$/m);
  });

  it("installs an explicit compatible npm version rather than latest", () => {
    expect(workflow).toContain("npm install --global npm@11.5.1");
    expect(workflow).not.toContain("install -g npm@latest");
    expect(workflow).not.toContain("npm@latest");
  });

  it("verifies the installed npm meets the trusted-publishing minimum before publishing", () => {
    expect(workflow).toContain("11.5.1");
    const verifyStep = workflow.indexOf("Verify npm version supports trusted publishing");
    const publishStep = workflow.indexOf("run: npm publish");
    const installStep = workflow.indexOf("Install npm 11.5.1");
    expect(installStep).toBeGreaterThan(-1);
    expect(verifyStep).toBeGreaterThan(installStep);
    expect(publishStep).toBeGreaterThan(verifyStep);
  });
});

describe("package metadata", () => {
  it("declares the exact GitHub repository", () => {
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/gligorkot/crap4ts.git",
    });
  });

  it("publishes the scoped name", () => {
    expect(pkg.name).toBe("@gligor/crap4ts");
  });
});

describe("README publishing docs", () => {
  it("documents manual initial publish before trusted-publisher configuration", () => {
    const manualIndex = readme.indexOf("npm ci && npm publish --access public");
    const trustedIndex = readme.indexOf("**trusted publisher**");
    expect(manualIndex).toBeGreaterThan(-1);
    expect(trustedIndex).toBeGreaterThan(manualIndex);
  });

  it("documents the exact npm trusted-publisher fields", () => {
    expect(readme).toContain("Organization/user `gligor`");
    expect(readme).toContain("Repository\n   `crap4ts`");
    expect(readme).toContain("Workflow filename `publish.yml` (filename only)");
    expect(readme).toContain("Allowed\n   actions `npm publish`");
  });

  it("says to leave the optional environment blank because the workflow declares none", () => {
    expect(readme).toContain("Leave npm's optional \"Environment\" field blank");
  });
});

describe("README config/import examples", () => {
  it("imports defineConfig from the scoped package everywhere", () => {
    expect(readme).not.toMatch(/from "(?!@gligor\/)crap4ts"/);
    expect(readme.match(/from "@gligor\/crap4ts";/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("never references an unscoped crap4ts package import or install", () => {
    expect(readme).not.toContain('require("crap4ts")');
    expect(readme).not.toContain('from "crap4ts"');
    expect(readme).not.toContain("npm install --save-dev crap4ts");
  });
});
