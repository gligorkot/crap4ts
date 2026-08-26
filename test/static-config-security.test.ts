import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";

const tempDirs: string[] = [];
const SENTINEL = "crap4ts-must-not-execute";

function sentinelPaths(): string[] {
  return process.argv.filter((arg) => arg.includes(SENTINEL));
}

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-static-config-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("static declarative config loading (security)", () => {
  it("accepts the documented declarative TS/ESM/CJS shapes without executing them", () => {
    const project = tempProject();

    // TS with an import declaration that must never be resolved or executed.
    fs.writeFileSync(path.join(project, "a.config.ts"), [
      'import { defineConfig } from "@gligor/crap4ts";',
      "",
      "export default defineConfig({ version: 1, src: 'src', threshold: 7 });",
      "",
    ].join("\n"));
    expect(loadConfig(project, "a.config.ts")?.config.threshold).toBe(7);

    fs.writeFileSync(path.join(project, "b.config.mjs"), "export default { version: 1, threshold: 6 };\n");
    expect(loadConfig(project, "b.config.mjs")?.config.threshold).toBe(6);

    fs.writeFileSync(path.join(project, "c.config.cjs"), "module.exports = { version: 1, threshold: 5 };\n");
    expect(loadConfig(project, "c.config.cjs")?.config.threshold).toBe(5);

    fs.writeFileSync(path.join(project, "d.config.js"), "module.exports = { version: 1, threshold: 4 };\n");
    expect(loadConfig(project, "d.config.js")?.config.threshold).toBe(4);
  });

  it("evaluates string, template, nested-object, and array literals statically", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "scalars.config.mjs"), [
      "export default {",
      "  version: 1,",
      "  src: 'src',",
      "  exclude: [`gen`],",
      "  thresholds: [{ glob: 'src/**/*.ts', threshold: 2 }],",
      "};",
      "",
    ].join("\n"));
    const loaded = loadConfig(project, "scalars.config.mjs")?.config;
    expect(loaded?.exclude).toEqual(["gen"]);
    expect(loaded?.thresholds).toEqual([{ glob: "src/**/*.ts", threshold: 2 }]);
  });

  it("evaluates a negative numeric literal before rejecting it at validation", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "neg.config.mjs"), "export default { version: 1, threshold: -3 };\n");
    // The literal evaluator accepts -3; strict validation rejects the value.
    expect(() => loadConfig(project, "neg.config.mjs")).toThrow(/must be a finite non-negative number/);
  });

  it("rejects an export default of undefined as unsupported non-literal syntax", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "undef.config.mjs"), "export default undefined;\n");
    expect(() => loadConfig(project, "undef.config.mjs")).toThrow(/unsupported non-literal syntax/);
  });

  it("rejects malicious TypeScript config content without executing side effects", () => {
    const project = tempProject();
    const malicious = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync("${SENTINEL}-ts", "pwned");`,
      `process.argv.push("${SENTINEL}");`,
      ``,
      `function evil() { require("node:child_process").execSync("touch ${SENTINEL}"); }`,
      `evil();`,
      ``,
      `export default defineConfig({ version: 1, src: 'src' });`,
    ].join("\n");
    fs.writeFileSync(path.join(project, "evil.config.ts"), malicious);

    expect(() => loadConfig(project, "evil.config.ts")).toThrow(/invalid config .*evil\.config\.ts/);
    expect(sentinelPaths()).toEqual([]);
    expect(fs.existsSync(path.join(project, `${SENTINEL}-ts`))).toBe(false);
    expect(fs.existsSync(path.join(project, SENTINEL))).toBe(false);
  });

  it("rejects malicious ESM config content without executing side effects", () => {
    const project = tempProject();
    fs.writeFileSync(
      path.join(project, "evil.config.mjs"),
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync("${SENTINEL}-mjs", "pwned");`,
        `(await import("node:child_process")).execSync("true");`,
        `export default { version: 1 };`,
      ].join("\n"),
    );

    expect(() => loadConfig(project, "evil.config.mjs")).toThrow(/invalid config .*evil\.config\.mjs/);
    expect(fs.existsSync(path.join(project, `${SENTINEL}-mjs`))).toBe(false);
  });

  it("rejects malicious CommonJS config content without executing side effects", () => {
    const project = tempProject();
    fs.writeFileSync(
      path.join(project, "evil.config.cjs"),
      [
        `const { writeFileSync } = require("node:fs");`,
        `writeFileSync("${SENTINEL}-cjs", "pwned");`,
        `require("node:child_process").execSync("true");`,
        `console.log("side effect");`,
        `module.exports = { version: 1 };`,
      ].join("\n"),
    );

    expect(() => loadConfig(project, "evil.config.cjs")).toThrow(/invalid config .*evil\.config\.cjs/);
    expect(fs.existsSync(path.join(project, `${SENTINEL}-cjs`))).toBe(false);
  });

  it("rejects executable expressions, references, spreads, computed keys, and non-defineConfig calls", () => {
    const project = tempProject();
    const cases: Array<[string, string]> = [
      ["variable reference", "const t = 8;\nexport default { version: 1, threshold: t };\n"],
      ["arbitrary call in value", "export default { version: 1, threshold: Number('8') };\n"],
      ["template literal with expression", "export default { version: 1, changedSince: `${1}` };\n"],
      ["spread in object", "const base = {};\nexport default { ...base, version: 1 };\n"],
      ["computed key", "export default { ['version']: 1 };\n"],
      ["non-literal array element", "export default { version: 1, exclude: [String('src')] };\n"],
      ["top-level function call export", "export default getConfig({ version: 1 });\n"],
      ["method shorthand", "export default { version: 1, fn() { return 1; } };\n"],
      ["top-level statement before export", "console.log('hi');\nexport default { version: 1 };\n"],
      ["CJS function call", "module.exports = make({ version: 1 });\n"],
      ["named export only", "export const config = { version: 1 };\n"],
      ["binary expression value", "export default { version: 1, threshold: 4 + 4 };\n"],
    ];
    for (const [name, source] of cases) {
      for (const extension of [".ts", ".mjs", ".cjs"]) {
        const file = `case.config${extension}`;
        const body = name === "CJS function call" || source.includes("module.exports")
          ? source
          : extension === ".cjs"
            ? source.replace("export default ", "module.exports = ").replace(/^export .*;\n/m, "")
            : source;
        fs.writeFileSync(path.join(project, file), body);
        let threw = false;
        try {
          loadConfig(project, file);
        } catch {
          threw = true;
        }
        if (!threw) {
          throw new Error(`expected ${extension} ${name} to be rejected`);
        }
      }
    }
  });

  it("rejects a --config path that escapes the project root", () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({ version: 1 }));

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-outside-escape-"));
    tempDirs.push(outsideDir);
    const escapees = ["../elsewhere.json", "/etc/hostname"];
    fs.writeFileSync(path.join(outsideDir, "elsewhere.json"), JSON.stringify({ version: 1 }));

    for (const escapee of escapees) {
      let message = "";
      try {
        loadConfig(project, escapee);
      } catch (error) {
        message = (error as Error).message;
      }
      if (!/config path must resolve within the project root|cannot be read|not a file/.test(message)) {
        throw new Error(`expected ${escapee} to be rejected, got: ${message}`);
      }
    }
    expect(() => loadConfig(project, ".crap4tsrc.json")).not.toThrow();
  });

  it("rejects a symlinked config file that resolves outside the project root", () => {
    const project = tempProject();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-outside-symlink-"));
    tempDirs.push(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "linked.json"), JSON.stringify({ version: 1 }));
    fs.symlinkSync(path.join(outsideDir, "linked.json"), path.join(project, "linked.json"));

    expect(() => loadConfig(project, "linked.json"))
      .toThrow("config path must resolve within the project root");
    expect(() => loadConfig(project, "missing.json")).toThrow("config file cannot be read");
  });
});

describe("extension-specific static export grammar", () => {
  function write(project: string, name: string, body: string): void {
    fs.writeFileSync(path.join(project, name), body);
  }

  it("accepts exactly one ESM default export in .ts and .mjs files", () => {
    const project = tempProject();
    write(project, "ok.config.ts", "export default { version: 1, threshold: 2 };\n");
    expect(loadConfig(project, "ok.config.ts")?.config.threshold).toBe(2);
    write(project, "ok.config.mjs", "export default defineConfig({ version: 1, threshold: 3 });\n");
    expect(loadConfig(project, "ok.config.mjs")?.config.threshold).toBe(3);
  });

  it("accepts module.exports in .cjs and either form in .js", () => {
    const project = tempProject();
    write(project, "ok.config.cjs", "module.exports = { version: 1, threshold: 4 };\n");
    expect(loadConfig(project, "ok.config.cjs")?.config.threshold).toBe(4);
    write(project, "esm.config.js", "export default { version: 1, threshold: 5 };\n");
    expect(loadConfig(project, "esm.config.js")?.config.threshold).toBe(5);
    write(project, "cjs.config.js", "module.exports = { version: 1, threshold: 6 };\n");
    expect(loadConfig(project, "cjs.config.js")?.config.threshold).toBe(6);
  });

  it("rejects ESM default exports in .cjs files", () => {
    const project = tempProject();
    write(project, "bad.config.cjs", "export default { version: 1 };\n");
    expect(() => loadConfig(project, "bad.config.cjs"))
      .toThrow(/export default syntax is not allowed/);
  });

  it("rejects CommonJS assignments in .ts and .mjs files", () => {
    const project = tempProject();
    for (const extension of [".ts", ".mjs"]) {
      const file = `bad.config${extension}`;
      write(project, file, "module.exports = { version: 1 };\n");
      expect(() => loadConfig(project, file))
        .toThrow(/module\.exports syntax is not allowed/);
    }
  });

  it("rejects a bare exports assignment in every extension", () => {
    const project = tempProject();
    for (const extension of [".ts", ".mjs", ".cjs", ".js"]) {
      const file = `bare.config${extension}`;
      write(project, file, "exports = { version: 1 };\n");
      expect(() => loadConfig(project, file)).toThrow(/bare `exports =` assignment/);
    }
  });

  it("rejects mixed ESM and CommonJS exports in .js files", () => {
    const project = tempProject();
    write(
      project,
      "mixed.config.js",
      [
        'import { defineConfig } from "@gligor/crap4ts";',
        "",
        "module.exports = { version: 1 };",
        "export default defineConfig({ version: 1 });",
        "",
      ].join("\n"),
    );
    expect(() => loadConfig(project, "mixed.config.js"))
      .toThrow(/config must contain exactly one export/);
  });

  it("rejects duplicate exports instead of silently accepting the last one", () => {
    const project = tempProject();
    write(
      project,
      "dup-esm.config.ts",
      [
        "export default { version: 1, threshold: 8 };",
        "export default { version: 1, threshold: 9 };",
        "",
      ].join("\n"),
    );
    // The last export must NOT win: the duplicate is rejected outright.
    expect(() => loadConfig(project, "dup-esm.config.ts"))
      .toThrow(/config must contain exactly one export/);

    write(
      project,
      "dup-cjs.config.cjs",
      [
        "module.exports = { version: 1, threshold: 8 };",
        "module.exports = { version: 1, threshold: 9 };",
        "",
      ].join("\n"),
    );
    expect(() => loadConfig(project, "dup-cjs.config.cjs"))
      .toThrow(/config must contain exactly one export/);
  });

  it("reports the extension-appropriate missing-export message", () => {
    const project = tempProject();
    write(project, "empty.config.ts", "");
    expect(() => loadConfig(project, "empty.config.ts")).toThrow(/via export default/);
    write(project, "empty.config.cjs", "");
    expect(() => loadConfig(project, "empty.config.cjs")).toThrow(/via module\.exports/);
  });
});
