/**
 * Strict, versioned project configuration loading and path rule matching.
 *
 * JavaScript and TypeScript configuration files are executable local project
 * code. Callers must only run crap4ts in repositories they trust.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import ts from "typescript";
import { DEFAULT_THRESHOLD } from "./crap.js";

export const CONFIG_VERSION = 1 as const;
export const DISCOVERED_CONFIG_NAMES = [
  "crap4ts.config.ts",
  "crap4ts.config.mjs",
  "crap4ts.config.cjs",
  "crap4ts.config.js",
  ".crap4tsrc.json",
] as const;

export interface PathThresholdRule {
  readonly glob: string;
  readonly threshold: number;
}

export interface Crap4tsConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly src?: string | readonly string[];
  readonly exclude?: string | readonly string[];
  readonly threshold?: number;
  readonly thresholds?: readonly PathThresholdRule[];
}

export interface LoadedConfig {
  readonly config: Crap4tsConfig;
  readonly configPath: string;
  readonly projectRoot: string;
}

/** Validate and return a strict, versioned config for ergonomic JS/TS configs. */
export function defineConfig(config: Crap4tsConfig): Crap4tsConfig {
  return validateConfig(config);
}

/** Locate and load one config, respecting the documented discovery precedence. */
export async function loadConfig(
  projectRoot: string,
  explicitPath?: string,
): Promise<LoadedConfig | undefined> {
  const root = path.resolve(projectRoot);
  const configPath = explicitPath === undefined
    ? DISCOVERED_CONFIG_NAMES.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate))
    : path.resolve(root, explicitPath);

  if (configPath === undefined) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch (error) {
    throw new Error(`config file cannot be read: ${configPath}: ${(error as Error).message}`);
  }
  if (!stat.isFile()) throw new Error(`config path is not a file: ${configPath}`);

  const resolvedConfigPath = fs.realpathSync(configPath);
  const config = await readConfig(resolvedConfigPath);
  return { config, configPath: resolvedConfigPath, projectRoot: path.dirname(resolvedConfigPath) };
}

/** Match a file path against a config glob relative to the project root. */
export function matchesConfigPattern(filePath: string, projectRoot: string, pattern: string): boolean {
  const relative = toPosix(path.relative(projectRoot, filePath));
  if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  return globToRegExp(pattern).test(relative);
}

/** Return the configured threshold for a path; earlier rules win exact specificity ties. */
export function thresholdForPath(
  filePath: string,
  projectRoot: string,
  config: Crap4tsConfig | undefined,
  cliThreshold: number | undefined,
): number {
  if (cliThreshold !== undefined) return cliThreshold;
  if (config === undefined) return DEFAULT_THRESHOLD;
  let winner: PathThresholdRule | undefined;
  let winnerSpecificity: PatternSpecificity | undefined;
  for (const rule of config.thresholds ?? []) {
    if (!matchesConfigPattern(filePath, projectRoot, rule.glob)) continue;
    const specificity = patternSpecificity(rule.glob);
    if (winnerSpecificity === undefined || isMoreSpecific(specificity, winnerSpecificity)) {
      winner = rule;
      winnerSpecificity = specificity;
    }
  }
  return winner?.threshold ?? config.threshold ?? DEFAULT_THRESHOLD;
}

/** Return true when a user config exclusion glob matches this source file. */
export function isConfigExcluded(filePath: string, projectRoot: string, config: Crap4tsConfig | undefined): boolean {
  const patterns = config?.exclude === undefined
    ? []
    : typeof config.exclude === "string" ? [config.exclude] : config.exclude;
  return patterns.some((pattern) => matchesConfigPattern(filePath, projectRoot, pattern));
}

function validateConfig(value: unknown, configRoot?: string): Crap4tsConfig {
  if (!isPlainObject(value)) throw new Error("config must export an object");
  const allowed = new Set(["version", "src", "exclude", "threshold", "thresholds"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`config has unknown property "${key}"`);
  }
  if (value["version"] !== CONFIG_VERSION) {
    throw new Error(`config.version must be ${CONFIG_VERSION}`);
  }
  const src = validateSourcePaths(value["src"], configRoot);
  const exclude = validateStringList(value["exclude"], "exclude");
  const threshold = validateThreshold(value["threshold"], "threshold");
  let thresholds: readonly PathThresholdRule[] | undefined;
  if (value["thresholds"] !== undefined) {
    if (!Array.isArray(value["thresholds"])) throw new Error("config.thresholds must be an array");
    thresholds = value["thresholds"].map((rule, index) => {
      if (!isPlainObject(rule)) throw new Error(`config.thresholds[${index}] must be an object`);
      const keys = Object.keys(rule);
      if (keys.some((key) => key !== "glob" && key !== "threshold") || typeof rule["glob"] !== "string") {
        throw new Error(`config.thresholds[${index}] must contain only glob and threshold`);
      }
      if (rule["glob"].length === 0) throw new Error(`config.thresholds[${index}].glob must not be empty`);
      const ruleThreshold = validateThreshold(rule["threshold"], `thresholds[${index}].threshold`);
      if (ruleThreshold === undefined) throw new Error(`config.thresholds[${index}].threshold is required`);
      return Object.freeze({ glob: rule["glob"], threshold: ruleThreshold });
    });
  }
  return Object.freeze({
    version: CONFIG_VERSION,
    ...(src === undefined ? {} : { src }),
    ...(exclude === undefined ? {} : { exclude }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(thresholds === undefined ? {} : { thresholds: Object.freeze(thresholds) }),
  });
}

function validateStringList(value: unknown, name: string): string | readonly string[] | undefined {
  if (value === undefined) return undefined;
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`config.${name} must be a non-empty string or an array of non-empty strings`);
  }
  return typeof value === "string" ? value : Object.freeze([...entries]);
}

function validateSourcePaths(value: unknown, configRoot?: string): string | readonly string[] | undefined {
  const src = validateStringList(value, "src");
  if (src === undefined) return undefined;
  const entries = typeof src === "string" ? [src] : src;
  if (entries.length === 0) throw new Error("config.src must not be an empty array");
  for (const entry of entries) {
    const normalized = path.posix.normalize(toPosix(entry));
    if (path.isAbsolute(entry) || path.win32.isAbsolute(entry) || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`config.src must contain project-relative paths, got "${entry}"`);
    }
    if (configRoot !== undefined) {
      let sourceRoot: string;
      try {
        sourceRoot = fs.realpathSync(path.resolve(configRoot, entry));
      } catch (error) {
        throw new Error(`config.src cannot be resolved, got "${entry}": ${(error as Error).message}`);
      }
      if (!isContainedPath(configRoot, sourceRoot)) {
        throw new Error(`config.src must contain project-relative paths, got "${entry}"`);
      }
    }
  }
  return src;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateThreshold(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`config.${name} must be a finite non-negative number`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

async function readConfig(configPath: string): Promise<Crap4tsConfig> {
  try {
    if (configPath.endsWith(".json")) {
      return validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), path.dirname(configPath));
    }
    const module = configPath.endsWith(".ts")
      ? await importTranspiledTypeScript(configPath)
      : await import(pathToFileURL(configPath).href);
    return validateConfig(module.default, path.dirname(configPath));
  } catch (error) {
    throw new Error(`invalid config ${configPath}: ${(error as Error).message}`);
  }
}

async function importTranspiledTypeScript(configPath: string): Promise<Record<string, unknown>> {
  const source = fs.readFileSync(configPath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: configPath,
    reportDiagnostics: true,
  });
  const diagnostics = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }));
  }
  const module = { exports: {} as Record<string, unknown> };
  const execute = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${result.outputText}\n})`,
    { filename: configPath },
  ) as (
    exports: Record<string, unknown>,
    require: NodeJS.Require,
    module: { exports: Record<string, unknown> },
    filename: string,
    dirname: string,
  ) => void;
  execute(module.exports, createRequire(configPath), module, configPath, path.dirname(configPath));
  return module.exports;
}

interface PatternSpecificity {
  readonly literalCount: number;
  readonly wildcardCount: number;
}

function patternSpecificity(pattern: string): PatternSpecificity {
  let literalCount = 0;
  let wildcardCount = 0;
  for (const character of toPosix(pattern)) {
    if (character === "*" || character === "?") wildcardCount++;
    else literalCount++;
  }
  return { literalCount, wildcardCount };
}

function isMoreSpecific(candidate: PatternSpecificity, current: PatternSpecificity): boolean {
  if (candidate.literalCount !== current.literalCount) return candidate.literalCount > current.literalCount;
  return candidate.wildcardCount < current.wildcardCount;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern);
  let expression = "^";
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === undefined) continue;
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index++;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}
