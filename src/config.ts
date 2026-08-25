/**
 * Strict, versioned project configuration loading and path rule matching.
 *
 * Configuration files are parsed statically and never executed. TypeScript,
 * ESM, and CommonJS config files are read as text and interpreted through a
 * restrictive declarative subset; arbitrary code in them is rejected.
 */
import * as fs from "node:fs";
import * as path from "node:path";
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
  readonly changedSince?: string;
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
export function loadConfig(
  projectRoot: string,
  explicitPath?: string,
): LoadedConfig | undefined {
  const root = fs.realpathSync(path.resolve(projectRoot));
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

  // The selected or discovered config (including through symlinks) must resolve
  // inside the supplied project root.
  const resolvedConfigPath = fs.realpathSync(configPath);
  if (!isContainedPath(root, resolvedConfigPath)) {
    throw new Error(`config path must resolve within the project root: ${configPath}`);
  }
  const config = readConfig(resolvedConfigPath);
  return { config, configPath: resolvedConfigPath, projectRoot: root };
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
  const winner = findMatchingThresholdRule(config.thresholds ?? [], filePath, projectRoot);
  return winner?.threshold ?? config.threshold ?? DEFAULT_THRESHOLD;
}

/** Return true when a user config exclusion glob matches this source file. */
export function isConfigExcluded(filePath: string, projectRoot: string, config: Crap4tsConfig | undefined): boolean {
  const patterns = config?.exclude === undefined
    ? []
    : typeof config.exclude === "string" ? [config.exclude] : config.exclude;
  return patterns.some((pattern) => matchesConfigPattern(filePath, projectRoot, pattern));
}

/** Find the most specific matching threshold rule; earlier rules win exact specificity ties. */
function findMatchingThresholdRule(
  rules: readonly PathThresholdRule[],
  filePath: string,
  projectRoot: string,
): PathThresholdRule | undefined {
  let winner: PathThresholdRule | undefined;
  let winnerSpecificity: PatternSpecificity | undefined;
  for (const rule of rules) {
    if (!matchesConfigPattern(filePath, projectRoot, rule.glob)) continue;
    const specificity = patternSpecificity(rule.glob);
    if (winnerSpecificity === undefined || isMoreSpecific(specificity, winnerSpecificity)) {
      winner = rule;
      winnerSpecificity = specificity;
    }
  }
  return winner;
}

function validateConfig(value: unknown, configRoot?: string): Crap4tsConfig {
  if (!isPlainObject(value)) throw new Error("config must export an object");
  const allowed = new Set(["version", "src", "exclude", "threshold", "thresholds", "changedSince"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`config has unknown property "${key}"`);
  }
  if (value["version"] !== CONFIG_VERSION) {
    throw new Error(`config.version must be ${CONFIG_VERSION}`);
  }
  return buildFrozenConfig({
    src: validateSourcePaths(value["src"], configRoot),
    exclude: validateStringList(value["exclude"], "exclude"),
    threshold: validateThreshold(value["threshold"], "threshold"),
    thresholds: validateThresholds(value["thresholds"]),
    changedSince: validateChangedSince(value["changedSince"]),
  });
}

/** Assemble the frozen Crap4tsConfig, omitting keys that are not present. */
function buildFrozenConfig(parts: {
  readonly src?: string | readonly string[] | undefined;
  readonly exclude?: string | readonly string[] | undefined;
  readonly threshold?: number | undefined;
  readonly thresholds?: readonly PathThresholdRule[] | undefined;
  readonly changedSince?: string | undefined;
}): Crap4tsConfig {
  return Object.freeze({
    version: CONFIG_VERSION,
    ...(parts.src === undefined ? {} : { src: parts.src }),
    ...(parts.exclude === undefined ? {} : { exclude: parts.exclude }),
    ...(parts.threshold === undefined ? {} : { threshold: parts.threshold }),
    ...(parts.thresholds === undefined ? {} : { thresholds: Object.freeze(parts.thresholds) }),
    ...(parts.changedSince === undefined ? {} : { changedSince: parts.changedSince }),
  });
}

function validateThresholds(value: unknown): readonly PathThresholdRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("config.thresholds must be an array");
  return value.map((rule, index) => validateThresholdRule(rule, index));
}

function validateThresholdRule(rule: unknown, index: number): PathThresholdRule {
  if (!isPlainObject(rule)) throw new Error(`config.thresholds[${index}] must be an object`);
  const glob = rule["glob"];
  if (Object.keys(rule).some((key) => key !== "glob" && key !== "threshold") || typeof glob !== "string") {
    throw new Error(`config.thresholds[${index}] must contain only glob and threshold`);
  }
  if (glob.length === 0) throw new Error(`config.thresholds[${index}].glob must not be empty`);
  const ruleThreshold = validateThreshold(rule["threshold"], `thresholds[${index}].threshold`);
  if (ruleThreshold === undefined) throw new Error(`config.thresholds[${index}].threshold is required`);
  return Object.freeze({ glob, threshold: ruleThreshold });
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
    assertRelativeSourceEntry(entry, configRoot);
  }
  return src;
}

function assertRelativeSourceEntry(entry: string, configRoot?: string): void {
  const normalized = path.posix.normalize(toPosix(entry));
  if (
    path.isAbsolute(entry) ||
    path.win32.isAbsolute(entry) ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`config.src must contain project-relative paths, got "${entry}"`);
  }
  if (configRoot !== undefined) assertSourceEntryWithinProject(configRoot, entry);
}

function assertSourceEntryWithinProject(configRoot: string, entry: string): void {
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

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateChangedSince(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("config.changedSince must be a non-empty string");
  }
  return value;
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

function readConfig(configPath: string): Crap4tsConfig {
  try {
    if (configPath.endsWith(".json")) {
      return validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), path.dirname(configPath));
    }
    return validateConfig(parseStaticModuleExport(fs.readFileSync(configPath, "utf8"), configPath), path.dirname(configPath));
  } catch (error) {
    throw new Error(`invalid config ${configPath}: ${(error as Error).message}`);
  }
}

/**
 * Statically parse a TS/JS/MJS/CJS config file and return the exported config
 * value. The file is never executed: only a restrictive declarative subset is
 * accepted — `export default { ... }`, `export default defineConfig({ ... })`,
 * or `module.exports = { ... }` — with literal values only. Import
 * declarations are tolerated syntactically but never resolved or run.
 */
function parseStaticModuleExport(source: string, configPath: string): unknown {
  const sf = ts.createSourceFile(configPath, source, ts.ScriptTarget.ES2022, true, scriptKindFor(configPath));
  const diagnostics = sourceFileParseDiagnostics(sf);
  if (diagnostics.length > 0) {
    throw new Error(formatParseDiagnostics(diagnostics, sf));
  }

  let exported: ts.Expression | undefined;
  let sawStatement = false;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue; // allowed but never resolved/executed
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exported = requireLiteralExpression(statement.expression, "export default", sf);
      sawStatement = true;
      continue;
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      // `export const config = { ... }` style exports are not part of the
      // documented shapes.
      throw new Error("unsupported export declaration; use export default");
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExportsTarget(statement.expression.left)
    ) {
      exported = requireLiteralExpression(statement.expression.right, "module.exports", sf);
      sawStatement = true;
      continue;
    }
    throw new Error(`unsupported config statement at line ${statement.getStart(sf) === 0 ? 1 : sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1}; configs are declarative and may not contain executable code`);
  }
  if (!sawStatement || exported === undefined) {
    throw new Error("config must export an object via export default or module.exports");
  }
  return evaluateLiteralNode(exported, sf);
}

/** Restrict an export expression to the exact documented declarative forms. */
function requireLiteralExpression(expression: ts.Expression, form: string, sf: ts.SourceFile): ts.Expression {
  if (ts.isCallExpression(expression) && isDefineConfigIdentifier(expression.expression)) {
    if (expression.arguments.length !== 1) {
      throw new Error(`${form} defineConfig(...) must be called with exactly one object argument`);
    }
    return expression.arguments[0]!;
  }
  return expression;
}

function isDefineConfigIdentifier(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === "defineConfig";
}

function isModuleExportsTarget(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === "exports"
    || ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === "module"
      && ts.isIdentifier(expression.name)
      && expression.name.text === "exports";
}

/** Interpret an AST node as a plain literal value; reject everything else. */
function evaluateLiteralNode(node: ts.Expression, sf: ts.SourceFile): unknown {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isObjectLiteralExpression(node)) return evaluateLiteralObject(node, sf);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => evaluateLiteralElement(element, sf));
  throw new Error(describeRejectedNode(node, sf));
}

function evaluateLiteralElement(element: ts.Expression, sf: ts.SourceFile): unknown {
  if (ts.isSpreadElement(element)) {
    throw new Error("array/object spreads are not supported in declarative configs");
  }
  return evaluateLiteralNode(element, sf);
}

function evaluateLiteralObject(node: ts.ObjectLiteralExpression, sf: ts.SourceFile): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("declarative configs only support plain key/value properties (no spreads, methods, computed keys, getters, or shorthand assignments)");
    }
    const name = property.name;
    if (ts.isComputedPropertyName(name)) {
      throw new Error("computed property names are not supported in declarative configs");
    }
    const key = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : describeRejectedNode(name, sf);
    result[key] = evaluateLiteralNode(property.initializer, sf);
  }
  return result;
}

/** Render a clear error naming the rejected syntax. */
function describeRejectedNode(node: ts.Node, sf: ts.SourceFile): string {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return `unsupported non-literal syntax ("${node.getText(sf).slice(0, 60)}") at line ${line}; configs are static data and may not reference variables, call functions, or compute values`;
}

/** Choose the TypeScript script kind so TS, ESM, and CommonJS all parse correctly. */
function scriptKindFor(configPath: string): ts.ScriptKind {
  return configPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/** Access the internal parse-diagnostics list on a parsed source file. */
function sourceFileParseDiagnostics(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  const internal = sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] };
  return internal.parseDiagnostics ?? [];
}

function formatParseDiagnostics(diagnostics: readonly ts.Diagnostic[], sf: ts.SourceFile): string {
  return diagnostics.map((diagnostic) => {
    const line = diagnostic.start === undefined ? "?" : String(sf.getLineAndCharacterOfPosition(diagnostic.start).line + 1);
    return `line ${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  }).join("; ");
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
    const character = normalized.charAt(index);
    const next = normalized.charAt(index + 1);
    if (character === "*" && next === "*") {
      if (normalized.charAt(index + 2) === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index++;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += escapeGlobCharacter(character);
  }
  return new RegExp(`${expression}$`);
}

/** Escape regular expression metacharacters in a literal glob character. */
function escapeGlobCharacter(character: string): string {
  return character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}
