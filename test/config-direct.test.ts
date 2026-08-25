import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_THRESHOLD } from "../src/crap.js";
import {
  CONFIG_VERSION,
  defineConfig,
  isConfigExcluded,
  loadConfig,
  matchesConfigPattern,
  thresholdForPath,
} from "../src/config.js";
import type { Crap4tsConfig } from "../src/config.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-config-direct-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("config direct validation", () => {
  it("rejects non-object configs, unknown properties, and wrong versions", () => {
    expect(() => defineConfig(undefined as never)).toThrow("config must export an object");
    expect(() => defineConfig("config" as never)).toThrow("config must export an object");
    expect(() => defineConfig([1] as never)).toThrow("config must export an object");
    expect(() => defineConfig({ version: 1, bogus: 1 } as never)).toThrow('config has unknown property "bogus"');
    expect(() => defineConfig({ version: 2 } as never)).toThrow(`config.version must be ${CONFIG_VERSION}`);
  });

  it("freezes complete configs and omits absent optional keys", () => {
    const minimal = defineConfig({ version: 1 });
    expect(Object.keys(minimal)).toEqual(["version"]);
    expect(Object.isFrozen(minimal)).toBe(true);

    const full = defineConfig({
      version: 1,
      src: ["src", "lib"],
      exclude: "gen",
      threshold: 5,
      thresholds: [{ glob: "src/*.ts", threshold: 3 }],
      changedSince: "HEAD~1",
    });
    expect(full.version).toBe(CONFIG_VERSION);
    expect(full.src).toEqual(["src", "lib"]);
    expect(Object.isFrozen(full.src)).toBe(true);
    expect(full.exclude).toBe("gen");
    expect(full.threshold).toBe(5);
    expect(full.thresholds).toEqual([{ glob: "src/*.ts", threshold: 3 }]);
    if (full.thresholds === undefined) throw new Error("expected thresholds to be defined");
    expect(Object.isFrozen(full.thresholds)).toBe(true);
    const rule = full.thresholds[0];
    if (rule === undefined) throw new Error("expected the first threshold rule");
    expect(rule).toEqual({ glob: "src/*.ts", threshold: 3 });
    expect(Object.isFrozen(rule)).toBe(true);
    expect(full.changedSince).toBe("HEAD~1");
    expect(Object.isFrozen(full)).toBe(true);

    expect(defineConfig({ version: 1, src: "src" }).src).toBe("src");
    expect(defineConfig({ version: 1, changedSince: "HEAD~2" }).changedSince).toBe("HEAD~2");
  });

  it("validates thresholds rules strictly", () => {
    expect(() => defineConfig({ version: 1, thresholds: "nope" } as never)).toThrow("config.thresholds must be an array");
    expect(() => defineConfig({ version: 1, thresholds: [42] } as never)).toThrow("config.thresholds[0] must be an object");
    expect(() => defineConfig({ version: 1, thresholds: [null] } as never)).toThrow("config.thresholds[0] must be an object");
    expect(() =>
      defineConfig({ version: 1, thresholds: [{ glob: "a", extra: 1 }] } as never),
    ).toThrow("config.thresholds[0] must contain only glob and threshold");
    expect(() => defineConfig({ version: 1, thresholds: [{ threshold: 3 }] } as never)).toThrow(
      "config.thresholds[0] must contain only glob and threshold",
    );
    expect(() => defineConfig({ version: 1, thresholds: [{ glob: 7, threshold: 3 }] } as never)).toThrow(
      "config.thresholds[0] must contain only glob and threshold",
    );
    expect(() => defineConfig({ version: 1, thresholds: [{ glob: "", threshold: 3 }] } as never)).toThrow(
      "config.thresholds[0].glob must not be empty",
    );
    expect(() => defineConfig({ version: 1, thresholds: [{ glob: "a" }] } as never)).toThrow(
      "config.thresholds[0].threshold is required",
    );
    expect(() =>
      defineConfig({ version: 1, thresholds: [{ glob: "a", threshold: NaN }] } as never),
    ).toThrow("config.thresholds[0].threshold must be a finite non-negative number");
    expect(() =>
      defineConfig({ version: 1, thresholds: [{ glob: "a", threshold: -1 }] } as never),
    ).toThrow("config.thresholds[0].threshold must be a finite non-negative number");
  });

  it("validates scalar config fields strictly", () => {
    expect(() => defineConfig({ version: 1, threshold: NaN } as never)).toThrow(
      "config.threshold must be a finite non-negative number",
    );
    expect(() => defineConfig({ version: 1, threshold: -1 } as never)).toThrow(
      "config.threshold must be a finite non-negative number",
    );
    expect(() => defineConfig({ version: 1, threshold: "8" } as never)).toThrow(
      "config.threshold must be a finite non-negative number",
    );
    expect(() => defineConfig({ version: 1, changedSince: 42 } as never)).toThrow(
      "config.changedSince must be a non-empty string",
    );
    expect(() => defineConfig({ version: 1, changedSince: "   " } as never)).toThrow(
      "config.changedSince must be a non-empty string",
    );
    expect(() => defineConfig({ version: 1, exclude: [42] } as never)).toThrow(
      "config.exclude must be a non-empty string or an array of non-empty strings",
    );
    expect(() => defineConfig({ version: 1, exclude: [""] } as never)).toThrow(
      "config.exclude must be a non-empty string or an array of non-empty strings",
    );
    expect(() => defineConfig({ version: 1, src: ["src", ""] } as never)).toThrow(
      "config.src must be a non-empty string or an array of non-empty strings",
    );
    expect(() => defineConfig({ version: 1, src: [] } as never)).toThrow("config.src must not be an empty array");
  });

  it("rejects absolute and project-escaping src entries", () => {
    for (const bad of ["/tmp", "C:\\abs", "../outside", "src/../../outside", ".."]) {
      expect(() => defineConfig({ version: 1, src: bad } as never)).toThrow(
        `config.src must contain project-relative paths, got "${bad}"`,
      );
    }
    expect(defineConfig({ version: 1, src: "src" }).src).toBe("src");
    expect(defineConfig({ version: 1, src: ["src", "./lib"] }).src).toEqual(["src", "./lib"]);
  });
});

describe("config path matching", () => {
  it("only matches paths inside the project root", () => {
    const project = tempProject();
    expect(matchesConfigPattern(project, project, "src/**/*.ts")).toBe(false);
    expect(matchesConfigPattern(path.join(path.dirname(project), "sibling.ts"), project, "**")).toBe(false);
    expect(matchesConfigPattern(path.join(project, "src", "a.ts"), project, "src/**/*.ts")).toBe(true);
  });

  it("interprets glob wildcards and escapes literal metacharacters", () => {
    const project = tempProject();
    const file = path.join(project, "src", "sub", "a.b.ts");
    expect(matchesConfigPattern(file, project, "**/a.b.ts")).toBe(true);
    expect(matchesConfigPattern(file, project, "src/**/a.b.ts")).toBe(true);
    expect(matchesConfigPattern(file, project, "a.b.ts")).toBe(false);
    expect(matchesConfigPattern(file, project, "src/sub/a?b.ts")).toBe(true);
    expect(matchesConfigPattern(file, project, "src/*/*.ts")).toBe(true);
    expect(matchesConfigPattern(file, project, "src/*.ts")).toBe(false);
    expect(matchesConfigPattern(path.join(project, "x"), project, "**")).toBe(true);
  });
});

describe("config threshold resolution", () => {
  it("falls back in order: CLI value, matching rule, config threshold, default", () => {
    const project = tempProject();
    const file = path.join(project, "src", "a.ts");
    const withThreshold: Crap4tsConfig = defineConfig({ version: 1, threshold: 5 });
    const withRules: Crap4tsConfig = defineConfig({ version: 1, threshold: 5, thresholds: [{ glob: "other/*.ts", threshold: 3 }] });
    const none: Crap4tsConfig = defineConfig({ version: 1 });
    expect(thresholdForPath(file, project, undefined, 2)).toBe(2);
    expect(thresholdForPath(file, project, undefined, undefined)).toBe(DEFAULT_THRESHOLD);
    expect(thresholdForPath(file, project, withThreshold, undefined)).toBe(5);
    expect(thresholdForPath(file, project, withRules, undefined)).toBe(5);
    expect(thresholdForPath(file, project, none, undefined)).toBe(DEFAULT_THRESHOLD);
  });

  it("picks the most specific matching rule and the earlier rule on exact ties", () => {
    const project = tempProject();
    const file = path.join(project, "src", "ab.ts");
    const config: Crap4tsConfig = defineConfig({
      version: 1,
      thresholds: [
        { glob: "src/*.ts", threshold: 11 },
        { glob: "src/ab.ts", threshold: 22 },
        { glob: "src/a?.ts", threshold: 33 },
      ],
    });
    expect(thresholdForPath(file, project, config, undefined)).toBe(22);
    const tie: Crap4tsConfig = defineConfig({
      version: 1,
      thresholds: [
        { glob: "src/a?.ts", threshold: 33 },
        { glob: "src/a*.ts", threshold: 44 },
      ],
    });
    expect(thresholdForPath(file, project, tie, undefined)).toBe(33);
  });
});

describe("config exclusions", () => {
  it("matches string and array exclusion globs", () => {
    const project = tempProject();
    const excluded = path.join(project, "src", "gen.ts");
    expect(isConfigExcluded(excluded, project, undefined)).toBe(false);
    expect(isConfigExcluded(excluded, project, defineConfig({ version: 1 }))).toBe(false);
    expect(isConfigExcluded(excluded, project, defineConfig({ version: 1, exclude: "src/gen.ts" }))).toBe(true);
    expect(isConfigExcluded(excluded, project, defineConfig({ version: 1, exclude: ["other/**", "src/*.ts"] }))).toBe(true);
    expect(isConfigExcluded(path.join(project, "src", "keep.ts"), project, defineConfig({ version: 1, exclude: ["src/gen.ts"] }))).toBe(false);
  });
});

describe("config file loading", () => {
  it("returns undefined when no discovered config exists", async () => {
    const project = tempProject();
    expect(await loadConfig(project)).toBeUndefined();
  });

  it("reads JSON, TypeScript, ESM, and CommonJS configs in-process", async () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "chosen.json"), JSON.stringify({ version: 1, src: "src", threshold: 7 }));
    const viaJson = await loadConfig(project, "chosen.json");
    expect(viaJson?.config.threshold).toBe(7);

    fs.writeFileSync(path.join(project, "ts.config.ts"), "export default { version: 1, src: 'src', threshold: 6 };\n");
    const viaTs = await loadConfig(project, "ts.config.ts");
    expect(viaTs?.config.threshold).toBe(6);
    expect(viaTs?.configPath).toBe(fs.realpathSync(path.join(project, "ts.config.ts")));
    expect(viaTs?.projectRoot).toBe(fs.realpathSync(project));

    fs.writeFileSync(path.join(project, "mjs.config.mjs"), "export default { version: 1, threshold: 5 };\n");
    expect((await loadConfig(project, "mjs.config.mjs"))?.config.threshold).toBe(5);

    fs.writeFileSync(path.join(project, "cjs.config.cjs"), "module.exports = { version: 1, threshold: 4 };\n");
    expect((await loadConfig(project, "cjs.config.cjs"))?.config.threshold).toBe(4);
  });

  it("discovers in-process configs in TS, MJS, CJS, then JSON precedence", async () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, ".crap4tsrc.json"), JSON.stringify({ version: 1, threshold: 100 }));
    expect((await loadConfig(project))?.config.threshold).toBe(100);
    fs.writeFileSync(path.join(project, "crap4ts.config.cjs"), "module.exports = { version: 1, threshold: 90 };\n");
    expect((await loadConfig(project))?.config.threshold).toBe(90);
    fs.writeFileSync(path.join(project, "crap4ts.config.mjs"), "export default { version: 1, threshold: 80 };\n");
    expect((await loadConfig(project))?.config.threshold).toBe(80);
    fs.writeFileSync(path.join(project, "crap4ts.config.ts"), "export default { version: 1, threshold: 70 };\n");
    expect((await loadConfig(project))?.config.threshold).toBe(70);
  });

  it("reports missing, unreadable, and non-file config paths", async () => {
    const project = tempProject();
    expect(() => loadConfig(project, "missing.json")).toThrow("config file cannot be read");
    expect(() => loadConfig(project, "src")).toThrow("config path is not a file");
  });

  it("wraps invalid config content in the config path", async () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "bad.json"), "{ not json");
    expect(() => loadConfig(project, "bad.json")).toThrow(/invalid config .*bad\.json/);
    fs.writeFileSync(path.join(project, "wrong-ts.ts"), "export default { version: 2 };\n");
    expect(() => loadConfig(project, "wrong-ts.ts")).toThrow(/config\.version must be/);
    fs.writeFileSync(path.join(project, "broken.ts"), "export default { version: 1, src:\n");
    expect(() => loadConfig(project, "broken.ts")).toThrow(/invalid config .*broken\.ts/);
    fs.writeFileSync(path.join(project, "not-object.ts"), "export default 42;\n");
    expect(() => loadConfig(project, "not-object.ts")).toThrow(/config must export an object/);
  });

  it("enforces project-path safety for config file src entries", async () => {
    const project = tempProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-config-outside-"));
    tempDirs.push(outside);

    fs.writeFileSync(path.join(project, "a.json"), JSON.stringify({ version: 1, src: "no-such-dir" }));
    expect(() => loadConfig(project, "a.json")).toThrow('config.src cannot be resolved, got "no-such-dir"');

    fs.writeFileSync(path.join(project, "b.json"), JSON.stringify({ version: 1, src: "../escape" }));
    expect(() => loadConfig(project, "b.json")).toThrow('config.src must contain project-relative paths, got "../escape"');

    fs.symlinkSync(outside, path.join(project, "linked"), "dir");
    fs.writeFileSync(path.join(project, "c.json"), JSON.stringify({ version: 1, src: "linked" }));
    expect(() => loadConfig(project, "c.json")).toThrow('config.src must contain project-relative paths, got "linked"');

    fs.writeFileSync(path.join(project, "d.json"), JSON.stringify({ version: 1, src: "src" }));
    expect((await loadConfig(project, "d.json"))?.config.src).toBe("src");
  });
});
