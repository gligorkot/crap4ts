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
import * as path from "node:path";
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
    if (node !== functionNode && FUNCTION_KINDS.has(node.kind)) {
      // Do not descend into nested functions; they get their own entries.
      return;
    }
    if (COMPLEXITY_KINDS.has(node.kind)) {
      complexity += 1;
    } else if (node.kind === ts.SyntaxKind.BinaryExpression) {
      const binary = node as ts.BinaryExpression;
      if (SHORT_CIRCUIT_TOKENS.has(binary.operatorToken.kind)) {
        complexity += 1;
      }
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

function getFunctionBody(node: ts.Node): ts.Node | null {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor: {
      const decl = node as
        | ts.FunctionDeclaration
        | ts.FunctionExpression
        | ts.MethodDeclaration
        | ts.ConstructorDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration;
      return decl.body ?? null;
    }
    case ts.SyntaxKind.ArrowFunction: {
      const arrow = node as ts.ArrowFunction;
      return arrow.body;
    }
    default:
      return null;
  }
}

function isFunctionLike(node: ts.Node): boolean {
  return FUNCTION_KINDS.has(node.kind);
}

/**
 * Derive a readable name for a function-like node.
 *
 * - Named function/method declarations use their declared name.
 * - Constructors use the enclosing class name + `#ctor`.
 * - Anonymous arrow/function expressions assigned to a variable use the
 *   variable name (inferred from the parent `VariableDeclaration`).
 * - Otherwise `<anonymous>`.
 */
function functionName(node: ts.Node): { name: string; displayName: string } {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression: {
      const decl = node as ts.FunctionDeclaration | ts.FunctionExpression;
      return { name: decl.name?.text ?? "<anonymous>", displayName: decl.name?.text ?? "<anonymous>" };
    }
    case ts.SyntaxKind.MethodDeclaration: {
      const decl = node as ts.MethodDeclaration;
      const name = decl.name?.getText() ?? "<anonymous>";
      return { name, displayName: name };
    }
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor: {
      const decl = node as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
      const name = decl.name?.getText() ?? "<anonymous>";
      return { name: name, displayName: name };
    }
    case ts.SyntaxKind.Constructor: {
      const parent = node.parent;
      const className =
        parent && ts.isClassDeclaration(parent) && parent.name
          ? parent.name.text
          : "<anonymous>";
      return { name: "constructor", displayName: `${className}#ctor` };
    }
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression: {
      // handled in default path below via parent
      break;
    }
    default:
      break;
  }
  // Infer from parent VariableDeclaration or PropertyAssignment.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.name) {
    if (ts.isIdentifier(parent.name)) {
      return { name: parent.name.text, displayName: parent.name.text };
    }
  }
  if (parent && ts.isPropertyAssignment(parent) && parent.name) {
    const name = parent.name.getText();
    return { name, displayName: name };
  }
  return { name: "<anonymous>", displayName: "<anonymous>" };
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
  const resolvedKind =
    scriptKind ??
    (filePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : filePath.endsWith(".ts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.TS);
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
      const name = functionName(node);
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
      const complexity = cyclomaticComplexity(node);
      functions.push({
        name: name.name,
        displayName: name.displayName,
        startLine,
        endLine,
        startOffset: start,
        endOffset: end,
        complexity,
        filePath,
      });
      // Still descend to find nested functions (which are their own entries).
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
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
  const parts = filePath.split(path.sep);
  for (const part of parts) {
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
export function discoverSourceFiles(roots: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const absRoot = path.resolve(root);
    if (!fs.existsSync(absRoot)) {
      continue;
    }
    const stat = fs.statSync(absRoot);
    if (stat.isFile()) {
      const norm = path.resolve(absRoot);
      if (!seen.has(norm) && isSourceFile(norm) && !shouldExclude(norm)) {
        seen.add(norm);
        results.push(norm);
      }
      continue;
    }
    walkDir(absRoot, results, seen);
  }
  return results.sort();
}

function walkDir(dir: string, results: string[], seen: Set<string>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) {
        continue;
      }
      walkDir(full, results, seen);
    } else if (entry.isFile() && isSourceFile(full) && !shouldExclude(full)) {
      const norm = path.resolve(full);
      if (!seen.has(norm)) {
        seen.add(norm);
        results.push(norm);
      }
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
    const abs = path.resolve(file);
    try {
      const source = fs.readFileSync(abs, "utf8");
      const funcs = analyzeSource(abs, source);
      all.push(...funcs);
    } catch {
      // Skip unreadable files; CLI layer surfaces errors explicitly.
    }
  }
  return all;
}
