import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  analyzeFiles,
  analyzeSource,
  cyclomaticComplexity,
  discoverSourceFiles,
  shouldExclude,
} from "../src/complexity.js";
import type { FunctionInfo } from "../src/complexity.js";
import ts from "typescript";

/**
 * Direct in-process tests for the complexity analysis helpers that were
 * extracted from the threshold-8-breaching functions (functionName,
 * discoverSourceFiles, getFunctionBody, walkDir, analyzeSource,
 * cyclomaticComplexity, shouldExclude, analyzeFiles) to cut their CRAP
 * scores while preserving every behavior:
 *
 * - discovery names / display names / source ranges / offsets are pinned by
 *   a full fixture snapshot (byte-identical to the pre-refactor baseline);
 * - naming edge cases the original switch only implicitly covered (string /
 *   numeric / computed property names, destructured bindings, missing
 *   parents, constructors on anonymous classes);
 * - script-kind resolution (explicit override wins, .tsx -> TSX, all else
 *   -> TS);
 * - complexity counting rules (ternary vs logical short-circuit, nested
 *   functions not descended, bodyless constructs);
 * - discovery root handling (file vs directory roots, nonexistent roots,
 *   cross-root dedup via canonicalPath, symlinked roots, and the
 *   additional-exclusion predicate receiving the walked path while results
 *   are stored canonicalised, with the original filter order preserved);
 * - shouldExclude segment semantics (file named "dist.ts" is NOT excluded,
 *   "dist/" segment IS, deep nested excluded segments, .d.ts).
 */

const FIXTURE = path.resolve(__dirname, "fixtures/sample.ts");

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crap4ts-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeFile(full: string, content: string): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Parse `source` and return the function-like node whose name matches. */
function findFunction(source: string, name: string): ts.Node {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true);
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found === null) {
    throw new Error(`Function ${name} not found`);
  }
  return found;
}

/** Parse `source` and return the first node matching the kind + predicate. */
function findNode(source: string, kind: ts.SyntaxKind, predicate: (node: ts.Node) => boolean): ts.Node {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true);
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (node.kind === kind && predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found === null) {
    throw new Error(`Node kind ${ts.SyntaxKind[kind]} matching predicate not found`);
  }
  return found;
}

interface Row {
  name: string;
  displayName: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
  complexity: number;
}

function row(f: FunctionInfo): Row {
  return {
    name: f.name,
    displayName: f.displayName,
    startLine: f.startLine,
    endLine: f.endLine,
    startColumn: f.startColumn,
    endColumn: f.endColumn,
    startOffset: f.startOffset,
    endOffset: f.endOffset,
    complexity: f.complexity,
  };
}

describe("analyzeSource — baseline snapshot (pre-refactor preservation)", () => {
  it("reproduces the full baseline fixture row-for-row in discovery order", () => {
    const source = fs.readFileSync(FIXTURE, "utf8");
    const funcs = analyzeSource(FIXTURE, source);
    const baseline: Row[] = [
      { name: "plain", displayName: "plain", startLine: 5, endLine: 7, startColumn: 0, endColumn: 1, startOffset: 143, endOffset: 190, complexity: 1 },
      { name: "withIf", displayName: "withIf", startLine: 10, endLine: 15, startColumn: 0, endColumn: 1, startOffset: 211, endOffset: 301, complexity: 2 },
      { name: "withElseIf", displayName: "withElseIf", startLine: 18, endLine: 25, startColumn: 0, endColumn: 1, startOffset: 355, endOffset: 498, complexity: 3 },
      { name: "withForAndIf", displayName: "withForAndIf", startLine: 28, endLine: 36, startColumn: 0, endColumn: 1, startOffset: 521, endOffset: 686, complexity: 3 },
      { name: "withWhile", displayName: "withWhile", startLine: 39, endLine: 45, startColumn: 0, endColumn: 1, startOffset: 706, endOffset: 810, complexity: 2 },
      { name: "withDoWhile", displayName: "withDoWhile", startLine: 48, endLine: 54, startColumn: 0, endColumn: 1, startOffset: 833, endOffset: 943, complexity: 2 },
      { name: "withForIn", displayName: "withForIn", startLine: 57, endLine: 63, startColumn: 0, endColumn: 1, startOffset: 964, endOffset: 1111, complexity: 2 },
      { name: "withCatch", displayName: "withCatch", startLine: 66, endLine: 72, startColumn: 0, endColumn: 1, startOffset: 1131, endOffset: 1233, complexity: 2 },
      { name: "risky", displayName: "risky", startLine: 74, endLine: 76, startColumn: 0, endColumn: 1, startOffset: 1235, endOffset: 1290, complexity: 1 },
      { name: "withSwitch", displayName: "withSwitch", startLine: 79, endLine: 88, startColumn: 0, endColumn: 1, startOffset: 1347, endOffset: 1520, complexity: 3 },
      { name: "withTernary", displayName: "withTernary", startLine: 91, endLine: 93, startColumn: 0, endColumn: 1, startOffset: 1542, endOffset: 1628, complexity: 2 },
      { name: "withLogicalOps", displayName: "withLogicalOps", startLine: 96, endLine: 98, startColumn: 0, endColumn: 1, startOffset: 1683, endOffset: 1773, complexity: 3 },
      { name: "withNullish", displayName: "withNullish", startLine: 101, endLine: 103, startColumn: 0, endColumn: 1, startOffset: 1833, endOffset: 1941, complexity: 4 },
      { name: "arrowPlain", displayName: "arrowPlain", startLine: 106, endLine: 106, startColumn: 26, endColumn: 54, startOffset: 2014, endOffset: 2042, complexity: 1 },
      { name: "arrowWithIf", displayName: "arrowWithIf", startLine: 109, endLine: 114, startColumn: 27, endColumn: 1, startOffset: 2098, endOffset: 2173, complexity: 2 },
      { name: "plain", displayName: "plain", startLine: 119, endLine: 121, startColumn: 2, endColumn: 3, startOffset: 2250, endOffset: 2285, complexity: 1 },
      { name: "withIf", displayName: "withIf", startLine: 124, endLine: 129, startColumn: 2, endColumn: 3, startOffset: 2306, endOffset: 2390, complexity: 2 },
      { name: "constructor", displayName: "MyClass#ctor", startLine: 132, endLine: 132, startColumn: 2, endColumn: 39, startOffset: 2420, endOffset: 2457, complexity: 1 },
      { name: "doubled", displayName: "doubled", startLine: 135, endLine: 137, startColumn: 2, endColumn: 3, startOffset: 2501, endOffset: 2576, complexity: 2 },
      { name: "setValue", displayName: "setValue", startLine: 140, endLine: 142, startColumn: 2, endColumn: 3, startOffset: 2592, endOffset: 2641, complexity: 1 },
      { name: "withNested", displayName: "withNested", startLine: 146, endLine: 152, startColumn: 0, endColumn: 1, startOffset: 2720, endOffset: 2869, complexity: 2 },
      { name: "inner", displayName: "inner", startLine: 148, endLine: 148, startColumn: 18, endColumn: 46, startOffset: 2801, endOffset: 2829, complexity: 1 },
      { name: "neverCalled", displayName: "neverCalled", startLine: 155, endLine: 157, startColumn: 0, endColumn: 1, startOffset: 2910, endOffset: 2964, complexity: 1 },
    ];
    expect(funcs.map(row)).toEqual(baseline);
    expect(funcs.every((f) => f.filePath === FIXTURE)).toBe(true);
  });

  it("skips bodyless declarations (abstract methods, overloads, ambient) but keeps their siblings", () => {
    const src = [
      "abstract class A {",
      "  abstract missing(): number;",
      "  ok(x: number): number { return x; }",
      "}",
      "interface I { ambient(): void; }",
      "declare const d: number;",
    ].join("\n");
    const funcs = analyzeSource("t.ts", src, ts.ScriptKind.TS);
    expect(funcs.map((f) => f.displayName)).toEqual(["ok"]);
    expect(funcs[0]?.complexity).toBe(1);
  });
});

describe("name inference edge cases (functionName extraction)", () => {
  it("names string-literal methods by their literal text (quotes preserved via getText())", () => {
    // The original used .getText() for MethodDeclaration / accessors, which
    // for a StringLiteral name includes the surrounding quotes.
    const src = `class C { "str Method"() { return 1; } }`;
    const f = analyzeSource("t.ts", src)[0];
    expect(f?.name).toBe('"str Method"');
    expect(f?.displayName).toBe('"str Method"');
  });

  it("names numeric and computed property methods via getText() (brackets included)", () => {
    // ComputedPropertyName.getText() includes the surrounding brackets — the
    // original implementation used getText() for these kinds, so the name
    // keeps the brackets.
    const src = `const o = { [42]: function() { return 1; }, 7: function() { return 2; } };`;
    const funcs = analyzeSource("t.ts", src);
    expect(funcs.map((f) => f.name)).toEqual(["[42]", "7"]);
  });

  it("still infers names for string-literal and computed property assignments (getText() forms)", () => {
    const src = `const k = 1;\nconst o = { "lit prop": function() { return 1; }, [k]: () => 2 };`;
    const names = analyzeSource("t.ts", src).map((f) => f.name).sort();
    expect(names).toEqual(['"lit prop"', "[k]"]);
  });

  it("infers the property name when the initializer is inside a destructuring declaration", () => {
    // The function expression's parent is the PropertyAssignment inside the
    // initializer object — the destructuring pattern does not participate
    // in naming at all.
    const src = `const { destructured } = { destructured: function() { return 1; } };`;
    const funcs = analyzeSource("t.ts", src);
    expect(funcs).toHaveLength(1);
    expect(funcs[0]?.name).toBe("destructured");
    expect(funcs[0]?.displayName).toBe("destructured");
  });

  it("uses <anonymous> when the initializer is an array literal", () => {
    // The function expression's parent is an ArrayLiteralExpression, so no
    // inference rule applies.
    const src = `const [first] = [function() { return 1; }];`;
    const funcs = analyzeSource("t.ts", src);
    expect(funcs).toHaveLength(1);
    expect(funcs[0]?.name).toBe("<anonymous>");
  });

  it("infers the name for var-statement function expressions", () => {
    const src = `var v = function(x) { return x; };`;
    expect(analyzeSource("t.ts", src).map((f) => f.name)).toEqual(["v"]);
  });

  it("falls back to <anonymous> when no parent inference applies", () => {
    const src = `call(function() { return 1; }, (x) => x);`;
    const names = analyzeSource("t.ts", src).map((f) => f.displayName).sort();
    expect(names).toEqual(["<anonymous>", "<anonymous>"]);
  });

  it("names constructors as constructor with <ClassName>#ctor display name", () => {
    const src = `class Named { constructor() {} }\nclass Mixed extends Base { constructor() { super(); } }`;
    const byDisplay = new Map(
      analyzeSource("t.ts", src).map((f) => [f.displayName, f]),
    );
    expect(byDisplay.get("Named#ctor")?.name).toBe("constructor");
    expect(byDisplay.get("Mixed#ctor")?.name).toBe("constructor");
  });

  it("infers property declaration names for both arrow and function expression fields", () => {
    const src = `class C { a = () => 1; b = function() { return 2; }; }`;
    const names = analyzeSource("t.ts", src)
      .map((f) => f.name)
      .sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("keeps method, accessor, and function declaration names (plain identifiers)", () => {
    const src = `
class C {
  method() {}
  get g() { return 1; }
  set s(v) {}
}
function fn() {}`;
    const names = analyzeSource("t.ts", src).map((f) => f.name).sort();
    expect(names).toEqual(["fn", "g", "method", "s"]);
  });
});

describe("script-kind resolution (resolveScriptKind extraction)", () => {
  const tsxSrc = `function el() { return <div>hi</div>; }`;

  it("resolves .tsx to TSX by extension (JSX parses to a function row)", () => {
    expect(analyzeSource("t.tsx", tsxSrc).map((f) => f.name)).toEqual(["el"]);
  });

  it("lets an explicit scriptKind override the extension-based resolution", () => {
    // Explicit JSX override on a .tsx path still parses the JSX body.
    expect(analyzeSource("t.tsx", tsxSrc, ts.ScriptKind.JSX).map((f) => f.name)).toEqual(["el"]);
    // A comma-less generic arrow is ambiguous in TSX mode (parsed as a JSX
    // opening tag, so no function row), but an explicit TS override resolves
    // it as a generic arrow function.
    const generic = `const f = <T>(x: T) => x;`;
    expect(analyzeSource("t.tsx", generic).map((f) => f.name)).toEqual([]);
    expect(analyzeSource("t.tsx", generic, ts.ScriptKind.TS).map((f) => f.name)).toEqual(["f"]);
    // Plain .ts resolves to TS, where the same source parses as an arrow.
    expect(analyzeSource("t.ts", generic).map((f) => f.name)).toEqual(["f"]);
  });

  it("resolves unknown extensions to TS", () => {
    expect(analyzeSource("t.weird", `function y() { return 2; }`).map((f) => f.name)).toEqual(["y"]);
  });
});

describe("complexity counting rules (isShortCircuitBinary extraction)", () => {
  it("counts a ternary (ConditionalExpression) but not nested ternaries inside nested functions", () => {
    const src = `function f(a, b, c) { return a ? (b ? 1 : 2) : 3; }`;
    expect(cyclomaticComplexity(findFunction(src, "f"))).toBe(3);
  });

  it("counts only short-circuit operators (&&, ||, ??) among binary expressions", () => {
    const src = `function f(a, b, c) { return (a + b) * c - 1 || a && b ?? c; }`;
    // base 1 + + (no) * (no) - (no) || (1) && (1) ?? (1) = 4
    expect(cyclomaticComplexity(findFunction(src, "f"))).toBe(4);
  });

  it("still does not count ||, and=, or optional chaining assignments as branches", () => {
    const src = `function f(o) { o.a ||= 1; o.b = o.b; if (o.c) return 1; return 0; }`;
    // base 1 + if (1) = 2 (||= is an assignment)
    expect(cyclomaticComplexity(findFunction(src, "f"))).toBe(2);
  });

  it("does not descend into nested functions when counting the outer body", () => {
    const src = `function outer(x) { if (x) { const g = () => { if (x) { for (let i = 0; i < 3; i++) {} } return 1; } } return 0; }`;
    // outer: base 1 + if = 2; inner branches (if + for) excluded
    expect(cyclomaticComplexity(findFunction(src, "outer"))).toBe(2);
    const inner = findNode(src, ts.SyntaxKind.ArrowFunction, () => true);
    expect(cyclomaticComplexity(inner)).toBe(3); // base 1 + if + for
  });

  it("keeps sibling functions when a bodyless abstract method sits beside them", () => {
    // Abstract methods are MethodDeclarations without a body: they must not
    // produce a row, and their siblings must still be discovered.
    const src = `abstract class A { abstract none(): number; real() { return 1; } }`;
    const funcs = analyzeSource("t.ts", src);
    expect(funcs.map((f) => f.name)).toEqual(["real"]);
  });

  it("produces no rows for interface members and ambient declarations", () => {
    // Interface methods are MethodSignature nodes (not in FUNCTION_KINDS)
    // and declare-functions have no body: neither yields a row.
    expect(analyzeSource("t.ts", `interface I { m(): void; }`)).toEqual([]);
    expect(analyzeSource("t.ts", `declare function d(): void;`)).toEqual([]);
  });

  it("skips bodyless overload signatures but keeps the implementation", () => {
    const src = `function f(x: number): string;\nfunction f(x: number): string { return String(x); }\n`;
    const funcs = analyzeSource("t.ts", src);
    expect(funcs.map((f) => f.name)).toEqual(["f"]);
    expect(funcs[0]?.startLine).toBe(2);
  });

  it("counts a do-while loop and a catch clause each as +1", () => {
    const src = `function f(n) { do { n--; } while (n > 0); try { } catch (e) {} return n; }`;
    // base 1 + do + catch = 3
    expect(cyclomaticComplexity(findFunction(src, "f"))).toBe(3);
  });
});

describe("shouldExclude — excluded-directory segment semantics", () => {
  it("excludes by directory segment, not by file name", () => {
    expect(shouldExclude("dist.ts")).toBe(false); // file NAMED dist.ts
    expect(shouldExclude("dist/foo.ts")).toBe(true); // dist/ segment
    expect(shouldExclude("node_modules/x/y.ts")).toBe(true);
    expect(shouldExclude("a/b/coverage/c.ts")).toBe(true);
    expect(shouldExclude("a/b/.git/c.ts")).toBe(true);
    expect(shouldExclude("plain.ts")).toBe(false);
  });

  it("excludes .d.ts even outside excluded directories", () => {
    expect(shouldExclude("types.d.ts")).toBe(true);
    expect(shouldExclude("dist/types.d.ts")).toBe(true);
  });
});

describe("discoverSourceFiles — root handling, dedup, and exclusions", () => {
  function makeTree(root: string): { dir: string; a: string; nested: string } {
    const dir = path.join(root, "src");
    writeFile(path.join(dir, "a.ts"), `function a() { return 1; }\n`);
    writeFile(path.join(dir, "notes.txt"), "not source\n");
    const nested = path.join(dir, "sub", "b.ts");
    writeFile(nested, `function b() { return 2; }\n`);
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFile(path.join(dir, "node_modules", "pkg", "c.ts"), `function c() { return 3; }\n`);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFile(path.join(dir, "dist", "d.ts"), `function d() { return 4; }\n`);
    return { dir, a: path.join(dir, "a.ts"), nested };
  }

  it("walks a directory root and applies default directory exclusions", () => {
    const root = tempDir("discover");
    const { dir } = makeTree(root);
    const files = discoverSourceFiles([dir]);
    expect(files).toEqual([path.join(dir, "a.ts"), path.join(dir, "sub", "b.ts")]);
  });

  it("accepts a file root directly and dedups it against its containing directory root", () => {
    const root = tempDir("discover-dedup");
    const { dir, a } = makeTree(root);
    // Same file reachable two ways: as its own root and via the directory.
    const both = discoverSourceFiles([a, dir]);
    expect(both).toEqual([a, path.join(dir, "sub", "b.ts")]);
    // Root order does not matter for dedup or the final sort.
    expect(discoverSourceFiles([dir, a])).toEqual(both);
  });

  it("dedups a symlinked file root to its canonical target spelling", () => {
    const root = tempDir("discover-symlink");
    const { dir } = makeTree(root);
    const target = path.join(dir, "a.ts");
    const link = path.join(dir, "a-link.ts");
    fs.symlinkSync(target, link);
    const files = discoverSourceFiles([link]);
    expect(files).toEqual([target]);
    // The directory root sees the symlink entry as a file too; the canonical
    // spelling dedups both.
    const withDir = discoverSourceFiles([dir]);
    expect(withDir).toEqual([target, path.join(dir, "sub", "b.ts")]);
  });

  it("silently skips nonexistent roots", () => {
    const root = tempDir("discover-missing");
    const missing = path.join(root, "does-not-exist");
    expect(discoverSourceFiles([missing])).toEqual([]);
  });

  it("stores canonical results while the predicate sees the canonical-root-spelled path", () => {
    // A symlinked directory root is canonicalised up front, so the walked
    // (and predicate-received) paths already use the canonical spelling —
    // here it happens to differ from the raw root's spelling. The collected
    // result is canonical either way.
    const root = tempDir("discover-predicate");
    const real = path.join(root, "real");
    writeFile(path.join(real, "a.ts"), `function a() { return 1; }\n`);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const received: string[] = [];
    const files = discoverSourceFiles([link], (p: string): boolean => {
      received.push(p);
      return false;
    });
    expect(files).toEqual([path.join(real, "a.ts")]);
    expect(received).toEqual([path.join(real, "a.ts")]);
    expect(received).not.toContain(path.join(link, "a.ts"));
  });

  it("does not invoke the predicate for excluded directories or non-source files, and honors its exclusions", () => {
    const root = tempDir("discover-pred-2");
    const { dir, a } = makeTree(root);
    const skipFile = path.join(dir, "skip.ts");
    writeFile(skipFile, `function s() { return 9; }\n`);
    const received: string[] = [];
    const skip = (p: string): boolean => {
      received.push(p);
      return p.endsWith("skip.ts");
    };
    const files = discoverSourceFiles([dir], skip);
    expect(files).toEqual([a, path.join(dir, "sub", "b.ts")]);
    // Predicate calls happen for a.ts, skip.ts, and sub/b.ts only — never
    // for node_modules/, dist/, or notes.txt.
    expect(received).toEqual([a, skipFile, path.join(dir, "sub", "b.ts")]);
  });

  it("honors the built-in exclusions even when the predicate would accept everything", () => {
    const root = tempDir("discover-pred-3");
    const { dir } = makeTree(root);
    const files = discoverSourceFiles([dir], () => false);
    expect(files).toEqual([path.join(dir, "a.ts"), path.join(dir, "sub", "b.ts")]);
  });
});

describe("analyzeFiles — per-file error swallowing and order", () => {
  it("analyzes each readable file in order with canonical filePath", () => {
    const root = tempDir("analyze-files");
    const f1 = path.join(root, "1.ts");
    const f2 = path.join(root, "sub", "2.ts");
    writeFile(f1, `function one() { return 1; }\n`);
    writeFile(f2, `function two() { return 2; }\n`);
    const funcs = analyzeFiles([f1, f2]);
    expect(funcs.map((f) => f.name)).toEqual(["one", "two"]);
    expect(funcs.map((f) => f.filePath)).toEqual([f1, f2]);
  });

  it("skips unreadable files without aborting the run", () => {
    const root = tempDir("analyze-files-unreadable");
    const ok = path.join(root, "ok.ts");
    writeFile(ok, `function kept() { return 1; }\n`);
    const missing = path.join(root, "missing.ts"); // never created
    const funcs = analyzeFiles([ok, missing]);
    expect(funcs.map((f) => f.name)).toEqual(["kept"]);
    // Directory-as-file is also swallowed as an unreadable input.
    expect(analyzeFiles([root])).toEqual([]);
  });
});
