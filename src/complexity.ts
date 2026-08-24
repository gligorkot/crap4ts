/**
 * TypeScript source analysis: finds named and anonymous functions/methods
 * in .ts/.tsx source and computes per-function cyclomatic complexity.
 *
 * Uses the TypeScript compiler API (`ts.createSourceFile`) for parsing only
 * (no type-checker / program needed), so analysis is fast and dependency-free
 * beyond the `typescript` package.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { canonicalPath } from "./path-identity.js";
import ts from "typescript";

/**
 * A function/method discovered in a source file.
 */
export interface FunctionInfo {
  /** Human-readable name, or `"<anonymous>"` for unnamed functions. */
  readonly name: string;
  /** Display name including a container hint, e.g. `MyClass.#ctor`, `foo`. */
  readonly displayName: string;
  /** 1-based start line of the function (first token). */
  readonly startLine: number;
  /** 1-based end line of the function (closing brace / last token). */
  readonly endLine: number;
  /** 0-based start column within the start line. */
  readonly startColumn: number;
  /** 0-based end column within the end line (exclusive). */
  readonly endColumn: number;
  /** 0-based start offset within the source file. */
  readonly startOffset: number;
  /** 0-based end offset (exclusive) within the source file. */
  readonly endOffset: number;
  /** Cyclomatic complexity (integer >= 1). */
  readonly complexity: number;
  /** Absolute, normalized file path. */
  readonly filePath: string;
}

/**
 * v1 cyclomatic complexity counting rules.
 *
 * Complexity starts at 1 for every function body. Each of the following
 * decision/branch constructs adds 1 to the complexity:
 *
 * - `if` statement
 * - `for`, `for..in`, `for..of` loops
 * - `while`, `do..while` loops
 * - `catch` clause
 * - `case` clause (inside a `switch`); the `default` clause does not add
 * - Conditional (ternary) expression `cond ? a : b`
 * - Logical short-circuit operators `&&`, `||`, and nullish coalescing `??`
 *
 * Constructs deliberately NOT counted in v1:
 * - Boolean short-circuit via assignment (`a ||= b`) — treated as assignment
 * - Optional chaining (`a?.b`) — not a control-flow branch
 * - Assertion expressions (`x!`) — not a branch
 *
 * Anonymous/nested functions are counted as their own function entries; their
 * bodies contribute their own complexity but do not add to the enclosing
 * function's complexity (mirrors the crap4java `visitClass` short-circuit).
 */

const FUNCTION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/** SyntaxKinds that each add 1 to cyclomatic complexity. */
const COMPLEXITY_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ConditionalExpression,
]);

/** Binary operator tokens that represent short-circuit branches. */
const SHORT_CIRCUIT_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BarBarToken, // ||
  ts.SyntaxKind.AmpersandAmpersandToken, // &&
  ts.SyntaxKind.QuestionQuestionToken, // ??
]);

/**
 * Compute the cyclomatic complexity of a function body by scanning its AST.
 *
 * The scan starts at the function node's body and counts the
 * {@link COMPLEXITY_KINDS} and short-circuit binary operators, starting from
 * a base of 1. Nested function declarations are NOT descended into (they are
 * counted as their own entries), matching the crap4java `visitClass` rule.
 */
export function cyclomaticComplexity(functionNode: ts.Node): number {
  let complexity = 1;
  const visit = (node: ts.Node): void => {
    // Do not descend into nested functions; they get their own entries.
    if (node !== functionNode && isFunctionLike(node)) {
      return;
    }
    if (COMPLEXITY_KINDS.has(node.kind)) {
      complexity += 1;
    } else if (isShortCircuitBinary(node)) {
      complexity += 1;
    }
    ts.forEachChild(node, visit);
  };
  // Start scanning the body, not the function header itself.
  const body = getFunctionBody(functionNode);
  if (body === null) {
    return 1;
  }
  ts.forEachChild(body, visit);
  return complexity;
}

/**
 * True when `node` is a binary expression whose operator token is a counted
 * short-circuit branch (`&&`, `||`, `??`).
 */
function isShortCircuitBinary(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.BinaryExpression &&
    SHORT_CIRCUIT_TOKENS.has(
      (node as ts.BinaryExpression).operatorToken.kind,
    )
  );
}

/**
 * The body of a function-like node, or `null` when the node kind is not a
 * function or carries no body (abstract methods, overloads, ambient
 * declarations).
 *
 * For function/method declarations, constructors, and accessors the body may
 * be `null` (no body present); for arrow functions the body is always
 * defined (either a block or an expression body).
 */
function getFunctionBody(node: ts.Node): ts.Node | null {
  if (node.kind === ts.SyntaxKind.ArrowFunction) {
    const arrow = node as ts.ArrowFunction;
    return arrow.body;
  }
  if (!BODIED_FUNCTION_KINDS.has(node.kind)) {
    return null;
  }
  const decl = node as
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration;
  return decl.body ?? null;
}

/**
 * The function-like kinds that carry a (possibly absent) body block, as
 * opposed to arrow functions whose body is always defined.
 */
const BODIED_FUNCTION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function isFunctionLike(node: ts.Node): boolean {
  return FUNCTION_KINDS.has(node.kind);
}

/**
 * Declared-name resolvers keyed by the node kind they apply to. The
 * resolver receives the node already narrowed to that kind by the
 * dispatcher, and returns the `{name, displayName}` pair.
 */
interface DeclaredNameResolver {
  kinds: readonly ts.SyntaxKind[];
  resolve: (node: ts.Node) => { name: string; displayName: string };
}

const DECLARED_NAME_RESOLVERS: readonly DeclaredNameResolver[] = [
  {
    kinds: [ts.SyntaxKind.FunctionDeclaration],
    resolve: (node) => {
      const decl = node as ts.FunctionDeclaration;
      const name = decl.name?.text ?? "<anonymous>";
      return { name, displayName: name };
    },
  },
  {
    kinds: [
      ts.SyntaxKind.MethodDeclaration,
      ts.SyntaxKind.GetAccessor,
      ts.SyntaxKind.SetAccessor,
    ],
    resolve: (node) => {
      const decl = node as
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration;
      const name = decl.name?.getText() ?? "<anonymous>";
      return { name, displayName: name };
    },
  },
];

/**
 * Derive a readable name for a function-like node.
 *
 * - Named function/method declarations use their declared name.
 * - Constructors use the enclosing class name + `#ctor`.
 * - Anonymous arrow/function expressions assigned to a variable use the
 *   variable name (inferred from the parent `VariableDeclaration`).
 * - Anonymous function expressions used as object property values use the
 *   property name (inferred from the parent `PropertyAssignment` or
 *   `PropertyDeclaration`).
 * - Otherwise `<anonymous>`.
 */
function functionName(node: ts.Node): { name: string; displayName: string } {
  if (node.kind === ts.SyntaxKind.Constructor) {
    return constructorName(node);
  }
  if (
    node.kind === ts.SyntaxKind.ArrowFunction ||
    node.kind === ts.SyntaxKind.FunctionExpression
  ) {
    return inferredParentName(node);
  }
  const resolver = DECLARED_NAME_RESOLVERS.find((r) =>
    r.kinds.includes(node.kind),
  );
  if (resolver !== undefined) {
    return resolver.resolve(node);
  }
  return anonymousName();
}

/**
 * Constructor name: `constructor` / `<EnclosingClass>#ctor`, with the
 * class name read from the parent class declaration when present.
 */
function constructorName(node: ts.Node): {
  name: string;
  displayName: string;
} {
  const parent = node.parent;
  const className =
    parent && ts.isClassDeclaration(parent) && parent.name
      ? parent.name.text
      : "<anonymous>";
  return { name: "constructor", displayName: `${className}#ctor` };
}

/**
 * Resolves the name of a parent node when the parent is one of the
 * inference shapes (variable declaration, property assignment, property
 * declaration). Returns `null` when no rule applies, so the caller can
 * fall back to `<anonymous>`.
 */
function parentInferenceName(
  parent: ts.Node,
): { name: string; displayName: string } | null {
  // Infer from parent VariableDeclaration.
  if (ts.isVariableDeclaration(parent) && parent.name) {
    const text = variableDeclarationName(parent.name);
    if (text !== null) {
      return { name: text, displayName: text };
    }
  }
  // PropertyAssignment: `obj = { foo: function() {} }` — name is "foo".
  if (ts.isPropertyAssignment(parent) && parent.name) {
    const name = parent.name.getText();
    return { name, displayName: name };
  }
  // PropertyDeclaration: `class C { foo = () => {} }` — name is "foo".
  if (ts.isPropertyDeclaration(parent) && parent.name) {
    const name = parent.name.getText();
    return { name, displayName: name };
  }
  return null;
}

/**
 * Parent-based name inference for anonymous arrow functions and function
 * expressions: variable declaration, object property assignment, or class
 * property declaration — in that order, with `<anonymous>` as the final
 * fallback.
 */
function inferredParentName(node: ts.Node): {
  name: string;
  displayName: string;
} {
  const parent = node.parent;
  if (parent === undefined) {
    return anonymousName();
  }
  const name = parentInferenceName(parent);
  return name === null ? anonymousName() : name;
}

/**
 * Name of a variable declarator when it is a simple identifier, else `null`
 * (binding patterns such as destructuring are not named).
 */
function variableDeclarationName(
  name: ts.DeclarationName,
): string | null {
  return ts.isIdentifier(name) ? name.text : null;
}

function anonymousName(): { name: string; displayName: string } {
  return { name: "<anonymous>", displayName: "<anonymous>" };
}

/**
 * The script kind for `analyzeSource`: explicit override wins, otherwise the
 * `.tsx` extension selects TSX and everything else (`.ts` and unknown)
 * selects TS.
 */
function resolveScriptKind(
  filePath: string,
  scriptKind: ts.ScriptKind | undefined,
): ts.ScriptKind {
  if (scriptKind !== undefined) {
    return scriptKind;
  }
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Analyze a single source file string and return all function-like declarations
 * with their cyclomatic complexity and source ranges.
 *
 * @param filePath  - absolute file path used for reporting
 * @param source    - file contents
 * @param scriptKind - optional override; defaults to inferring .ts/.tsx/.js/.jsx
 */
export function analyzeSource(
  filePath: string,
  source: string,
  scriptKind?: ts.ScriptKind,
): FunctionInfo[] {
  const resolvedKind = resolveScriptKind(filePath, scriptKind);
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    resolvedKind,
  );

  const functions: FunctionInfo[] = [];

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const body = getFunctionBody(node);
      // Skip declarations without bodies (abstract methods, overloads, ambient).
      if (body === null || body === undefined) {
        return;
      }
      const info = buildFunctionInfo(node, sourceFile, filePath);
      if (info !== null) {
        functions.push(info);
      }
      // Still descend to find nested functions (which are their own entries).
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

/**
 * Build the {@link FunctionInfo} row for one function-like node with a body:
 * name, source range (via the owning source file), and cyclomatic
 * complexity. Returns `null` only when the node has no resolvable source
 * start (defensive; a parsed function always has one).
 */
function buildFunctionInfo(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): FunctionInfo | null {
  const name = functionName(node);
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  if (start === undefined || end === undefined) {
    return null;
  }
  const startPos = sourceFile.getLineAndCharacterOfPosition(start);
  const endPos = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    name: name.name,
    displayName: name.displayName,
    startLine: startPos.line + 1,
    endLine: endPos.line + 1,
    startColumn: startPos.character,
    endColumn: endPos.character,
    startOffset: start,
    endOffset: end,
    complexity: cyclomaticComplexity(node),
    filePath,
  };
}

/** Default file extensions analyzed by crap4ts. */
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Directory names excluded from source discovery by default. */
export const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
]);

/**
 * Returns true when `filePath` should be excluded from analysis.
 *
 * Excludes declaration files (`.d.ts`), and any path containing an excluded
 * directory segment (node_modules, dist, coverage, .git).
 */
export function shouldExclude(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return true;
  }
  return hasExcludedDirSegment(filePath);
}

/**
 * True when any path segment of `filePath` (split on the platform separator)
 * is a default-excluded directory name.
 */
function hasExcludedDirSegment(filePath: string): boolean {
  for (const part of filePath.split(path.sep)) {
    if (DEFAULT_EXCLUDE_DIRS.has(part)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively discover source files under the given directory roots.
 *
 * @param roots - directory paths to walk
 * @returns array of absolute file paths
 */
export function discoverSourceFiles(
  roots: string[],
  shouldExcludeAdditional?: (filePath: string) => boolean,
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    processRoot(root, results, seen, shouldExcludeAdditional);
  }
  return results.sort();
}

/**
 * Handle one discovery root: a file root is considered directly; a directory
 * root is walked. Nonexistent roots are skipped silently.
 */
function processRoot(
  root: string,
  results: string[],
  seen: Set<string>,
  shouldExcludeAdditional: ((filePath: string) => boolean) | undefined,
): void {
  const absRoot = canonicalPath(root);
  if (!fs.existsSync(absRoot)) {
    return;
  }
  const stat = fs.statSync(absRoot);
  if (stat.isFile()) {
    processFileRoot(absRoot, results, seen, shouldExcludeAdditional);
    return;
  }
  walkDir(absRoot, results, seen, shouldExcludeAdditional);
}

/**
 * Consider a single file root: canonicalised, deduplicated, extension- and
 * exclusion-filtered before being appended.
 */
function processFileRoot(
  absRoot: string,
  results: string[],
  seen: Set<string>,
  shouldExcludeAdditional: ((filePath: string) => boolean) | undefined,
): void {
  const norm = canonicalPath(absRoot);
  if (
    !seen.has(norm) &&
    isSourceFile(norm) &&
    !shouldExclude(norm) &&
    !shouldExcludeAdditional?.(norm)
  ) {
    seen.add(norm);
    results.push(norm);
  }
}

/**
 * Walk one directory of the discovery tree, recursing into non-excluded
 * subdirectories and collecting non-excluded source files.
 */
function walkDir(
  dir: string,
  results: string[],
  seen: Set<string>,
  shouldExcludeAdditional: ((filePath: string) => boolean) | undefined,
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    walkEntry(
      dir,
      entry,
      results,
      seen,
      shouldExcludeAdditional,
    );
  }
}

/**
 * Walk one directory entry: recurse into non-excluded directories, collect
 * qualifying source files (canonicalised and deduplicated), ignore the rest.
 */
function walkEntry(
  dir: string,
  entry: Dirent,
  results: string[],
  seen: Set<string>,
  shouldExcludeAdditional: ((filePath: string) => boolean) | undefined,
): void {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
    if (!DEFAULT_EXCLUDE_DIRS.has(entry.name)) {
      walkDir(full, results, seen, shouldExcludeAdditional);
    }
    return;
  }
  if (
    entry.isFile() &&
    isSourceFile(full) &&
    !shouldExclude(full) &&
    !shouldExcludeAdditional?.(full)
  ) {
    const norm = canonicalPath(full);
    if (!seen.has(norm)) {
      seen.add(norm);
      results.push(norm);
    }
  }
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

/**
 * Analyze all source files under the given roots and return their functions.
 *
 * Files that cannot be read are skipped (with the error swallowed) so a single
 * unreadable file does not abort an entire run; callers should pre-validate
 * readability when that matters.
 */
export function analyzeFiles(filePaths: string[]): FunctionInfo[] {
  const all: FunctionInfo[] = [];
  for (const file of filePaths) {
    all.push(...readFileFunctions(file));
  }
  return all;
}

/**
 * Read and analyze one file, returning its functions; unreadable or
 * unparseable files yield no entries (the error is swallowed so a single bad
 * file does not abort the run).
 */
function readFileFunctions(file: string): FunctionInfo[] {
  try {
    const abs = canonicalPath(file);
    const source = fs.readFileSync(abs, "utf8");
    return analyzeSource(abs, source);
  } catch {
    // Skip unreadable files; CLI layer surfaces errors explicitly.
    return [];
  }
}
