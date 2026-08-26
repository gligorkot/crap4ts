#!/usr/bin/env node
/**
 * Release-tarball smoke check for @gligor/crap4ts.
 *
 * Builds the real package, packs it into an npm tarball, then installs that
 * tarball (with lifecycle scripts disabled) into a genuinely fresh temporary
 * consumer project and exercises every public delivery surface:
 *
 *   1. the installed `crap4ts` CLI binary,
 *   2. an ESM `import` of `@gligor/crap4ts`,
 *   3. a CommonJS `require` of `@gligor/crap4ts`,
 *   4. a static TypeScript config using the installed package's
 *      `defineConfig`, consumed by the installed CLI.
 *
 * The only network access is npm resolving the tarball's own dependencies
 * during install — exactly like any consumer. All temporary files live in a
 * single mktemp directory removed on exit. Any failure exits non-zero with a
 * clear message and the consumer logs on stderr.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

/** @param {string} label @param {string} command @param {string[]} args @param {{cwd?: string, env?: Record<string,string>, input?: string}} [options] */
function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    shell: false,
    input: options.input ?? undefined,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  if (result.status !== 0 || result.error) {
    process.stderr.write(`[release-smoke] FAILED: ${label}\n`);
    if (result.stdout) process.stderr.write(`--- stdout ---\n${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`--- stderr ---\n${result.stderr}\n`);
    process.exit(result.status && Number.isInteger(result.status) ? result.status : 1);
  }
  return result.stdout ?? "";
}

const workspace = mkdtempSync(join(tmpdir(), "crap4ts-release-smoke-"));
let failed = false;
try {
  // 1. Build and pack the actual release tarball from this checkout.
  run("npm run build", "npm", ["run", "build"]);
  const tarballName = run("npm pack --dry-run=false", "npm", [
    "pack",
    "--pack-destination",
    workspace,
    "--ignore-scripts",
  ]).trim().split("\n").pop();
  if (!tarballName || !tarballName.endsWith(".tgz")) {
    throw new Error(`npm pack did not produce a tarball (got: ${tarballName})`);
  }
  const tarballPath = join(workspace, tarballName);

  // 2. Create a fresh temporary consumer project with no shared state.
  const consumer = join(workspace, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "crap4ts-release-smoke-consumer", version: "1.0.0", private: true }, null, 2),
  );

  // Install ONLY the local tarball. --ignore-scripts disables lifecycle
  // scripts; --no-audit/--no-fund keep noise down. npm resolves the
  // tarball's declared dependencies from the registry as any consumer would.
  run("npm install local tarball in fresh consumer", "npm", [
    "install",
    tarballPath,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], { cwd: consumer });

  // 3. Exercise the installed CLI directly (public bin surface).
  const sampleDir = join(consumer, "src");
  mkdirSync(sampleDir);
  writeFileSync(
    join(sampleDir, "sample.ts"),
    [
      "export function covered(): number {",
      "  return 1;",
      "}",
    ].join("\n"),
  );
  const coverageFile = join(consumer, "coverage-final.json");
  const coverageKey = `${sampleDir}/sample.ts`;
  writeFileSync(
    coverageFile,
    JSON.stringify({
      [coverageKey]: {
        path: coverageKey,
        fnMap: {
          "0": { name: "covered", decl: { start: { line: 1, column: 16 }, end: { line: 1, column: 23 } }, loc: { start: { line: 1, column: 33 }, end: { line: 2, column: null } } },
        },
        f: { "0": 1 },
        statementMap: {
          "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 11 } },
        },
        s: { "0": 1 },
      },
    }),
  );

  const cli = join(consumer, "node_modules", ".bin", "crap4ts");
  run("installed CLI analyzes source via installed coverage", cli, [
    "src",
    "--coverage",
    "coverage-final.json",
    "--threshold",
    "8",
  ], { cwd: consumer });

  // 4. Exercise ESM import + CommonJS require + defineConfig from the
  // installed package. The TS config is parsed statically by the CLI; it is
  // never executed by crap4ts itself.
  writeFileSync(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { computeCrap, DEFAULT_THRESHOLD, defineConfig, CONFIG_VERSION } from "${pkg.name}";

assert.equal(DEFAULT_THRESHOLD, 8);
assert.equal(CONFIG_VERSION, 1);
const crap = computeCrap(1, 1);
assert.equal(crap.crap, 1);

const config = defineConfig({
  version: CONFIG_VERSION,
  src: ["src"],
  threshold: 8,
});
assert.equal(config.threshold, 8);
console.log("ESM OK");
`,
  );
  run("ESM import of installed package", "node", ["smoke.mjs"], { cwd: consumer });

  writeFileSync(
    join(consumer, "smoke.cjs"),
    `
const assert = require("node:assert/strict");
const pkg = require("${pkg.name}");
assert.equal(typeof pkg.computeCrap, "function");
assert.equal(pkg.DEFAULT_THRESHOLD, 8);
assert.equal(pkg.defineConfig({ version: pkg.CONFIG_VERSION, src: "src" }).src, "src");
console.log("CommonJS OK");
`,
  );
  run("CommonJS require of installed package", "node", ["smoke.cjs"], { cwd: consumer });

  writeFileSync(
    join(consumer, "crap4ts.config.ts"),
    `
import { defineConfig } from "${pkg.name}";

export default defineConfig({
  version: 1,
  src: ["src"],
  threshold: 8,
});
`,
  );
  const cliConfigOutput = run(
    "installed CLI consumes valid static TS config using installed defineConfig",
    cli,
    ["--config", "crap4ts.config.ts", "--coverage", "coverage-final.json"],
    { cwd: consumer },
  );
  if (!cliConfigOutput.includes("sample.ts")) {
    throw new Error(`CLI config run output missing expected row:\n${cliConfigOutput}`);
  }

  console.log("[release-smoke] OK: tarball install, CLI, ESM import, CommonJS require, and static TS defineConfig all verified.");
} catch (error) {
  process.stderr.write(`[release-smoke] FAILED: ${error?.message ?? error}\n`);
  try {
    process.stderr.write(`--- consumer dir contents ---\n${readdirSync(join(workspace, "consumer")).join("\n")}\n`);
  } catch {
    /* best-effort diagnostics only */
  }
  failed = true;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) process.exit(1);
