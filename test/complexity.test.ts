import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  analyzeSource,
  analyzeFiles,
  cyclomaticComplexity,
  discoverSourceFiles,
  shouldExclude,
} from "../src/complexity.js";
import ts from "typescript";

const FIXTURE = path.resolve(__dirname, "fixtures/sample.ts");

function parseFunction(source: string, name: string): ts.Node {
  const sf = ts.createSourceFile(
    "test.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
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

describe("cyclomaticComplexity", () => {
  it("counts CC=1 for plain function", () => {
    expect(cyclomaticComplexity(parseFunction("function f() { return 1; }", "f"))).toBe(1);
  });

  it("counts CC=2 for if statement", () => {
    const src = "function f(x) { if (x) return 1; return 0; }";
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(2);
  });

  it("counts for/while/do/for-in/for-of loops", () => {
    const cases: Array<[string, number]> = [
      ["function f(a) { for (const x of a) {} return 0; }", 2],
      ["function f(a) { for (const k in a) {} return 0; }", 2],
      ["function f(n) { for (let i=0;i<n;i++) {} return 0; }", 2],
      ["function f(n) { while(n>0) { n--; } return 0; }", 2],
      ["function f(n) { do { n--; } while(n>0); return 0; }", 2],
    ];
    for (const [src, expected] of cases) {
      expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(expected);
    }
  });

  it("counts catch clause", () => {
    const src = "function f() { try { return 1; } catch(e) { return 0; } }";
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(2);
  });

  it("counts case clauses but not default", () => {
    const src = "function f(c) { switch(c) { case 1: return 1; case 2: return 2; default: return 0; } }";
    // base 1 + 2 cases = 3
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(3);
  });

  it("counts ternary expression", () => {
    const src = "function f(x) { return x > 0 ? 1 : 0; }";
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(2);
  });

  it("counts && and || short-circuit operators", () => {
    const src = "function f(a, b) { return a && b || !a; }";
    // base 1 + && + || = 3
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(3);
  });

  it("counts ?? nullish coalescing", () => {
    const src = "function f(a) { return a ?? 0; }";
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(2);
  });

  it("does not count nested function body in outer complexity", () => {
    const src = "function f(x) { if (x) { const g = () => { if (x > 1) return 2; }; g(); } return 0; }";
    // outer: base 1 + if = 2; inner arrow's if not counted in outer
    expect(cyclomaticComplexity(parseFunction(src, "f"))).toBe(2);
  });
});

describe("analyzeSource on fixture", () => {
  const source = `function plain() { return 1; }
function withIf(x) { if (x) return x; return 0; }
const arrow = (x) => x + 1;`;

  it("finds named functions and arrow functions", () => {
    const funcs = analyzeSource("test.ts", source);
    const names = funcs.map((f) => f.displayName);
    expect(names).toContain("plain");
    expect(names).toContain("withIf");
    expect(names).toContain("arrow");
  });

  it("computes correct complexity for fixture functions", () => {
    const funcs = analyzeSource("test.ts", source);
    const byName = new Map(funcs.map((f) => [f.displayName, f]));
    expect(byName.get("plain")?.complexity).toBe(1);
    expect(byName.get("withIf")?.complexity).toBe(2);
    expect(byName.get("arrow")?.complexity).toBe(1);
  });
});

describe("analyzeSource — anonymous FunctionExpression name inference", () => {
  it("infers name from variable declaration for anonymous function expression", () => {
    const src = `const handler = function(x) { return x; };`;
    const funcs = analyzeSource("test.ts", src);
    const handler = funcs.find((f) => f.displayName === "handler");
    expect(handler).toBeDefined();
    expect(handler?.name).toBe("handler");
  });

  it("infers name from variable declaration for anonymous arrow function", () => {
    const src = `const callback = (x) => x + 1;`;
    const funcs = analyzeSource("test.ts", src);
    const callback = funcs.find((f) => f.displayName === "callback");
    expect(callback).toBeDefined();
    expect(callback?.name).toBe("callback");
  });

  it("infers name from PropertyAssignment for function expression in object", () => {
    const src = `const obj = { handler: function(x) { return x; } };`;
    const funcs = analyzeSource("test.ts", src);
    const handler = funcs.find((f) => f.displayName === "handler");
    expect(handler).toBeDefined();
    expect(handler?.name).toBe("handler");
  });

  it("infers name from PropertyAssignment for arrow function in object", () => {
    const src = `const obj = { onClick: (e) => e.target };`;
    const funcs = analyzeSource("test.ts", src);
    const onClick = funcs.find((f) => f.displayName === "onClick");
    expect(onClick).toBeDefined();
    expect(onClick?.name).toBe("onClick");
  });

  it("infers name from PropertyDeclaration for arrow function in class", () => {
    const src = `class C { handler = (x) => x + 1; }`;
    const funcs = analyzeSource("test.ts", src);
    const handler = funcs.find((f) => f.displayName === "handler");
    expect(handler).toBeDefined();
    expect(handler?.name).toBe("handler");
  });

  it("infers name from PropertyDeclaration for function expression in class", () => {
    const src = `class C { process = function(x) { return x; }; }`;
    const funcs = analyzeSource("test.ts", src);
    const processFn = funcs.find((f) => f.displayName === "process");
    expect(processFn).toBeDefined();
    expect(processFn?.name).toBe("process");
  });

  it("uses <anonymous> for unnamed function expression not assigned to anything", () => {
    const src = `call(function() { return 1; });`;
    const funcs = analyzeSource("test.ts", src);
    const anon = funcs.find((f) => f.displayName === "<anonymous>");
    expect(anon).toBeDefined();
  });
});

describe("analyzeSource on full fixture file", () => {
  it("finds all expected functions with correct complexity", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(FIXTURE, "utf8");
    const funcs = analyzeSource(FIXTURE, source);
    const byName = new Map(funcs.map((f) => [f.displayName, f] as const));

    // Standalone functions
    expect(byName.get("plain")?.complexity).toBe(1);
    expect(byName.get("withIf")?.complexity).toBe(2);
    expect(byName.get("withElseIf")?.complexity).toBe(3);
    expect(byName.get("withForAndIf")?.complexity).toBe(3);
    expect(byName.get("withWhile")?.complexity).toBe(2);
    expect(byName.get("withDoWhile")?.complexity).toBe(2);
    expect(byName.get("withForIn")?.complexity).toBe(2);
    expect(byName.get("withCatch")?.complexity).toBe(2);
    expect(byName.get("risky")?.complexity).toBe(1);
    expect(byName.get("withSwitch")?.complexity).toBe(3);
    expect(byName.get("withTernary")?.complexity).toBe(2);
    expect(byName.get("withLogicalOps")?.complexity).toBe(3);
    expect(byName.get("withNullish")?.complexity).toBe(4);
    expect(byName.get("arrowPlain")?.complexity).toBe(1);
    expect(byName.get("arrowWithIf")?.complexity).toBe(2);

    // Class methods
    expect(byName.get("MyClass#ctor")?.complexity).toBe(1);
    expect(byName.get("doubled")?.complexity).toBe(2); // get accessor with ternary

    // Nested
    expect(byName.get("withNested")?.complexity).toBe(2);
    expect(byName.get("neverCalled")?.complexity).toBe(1);
  });

  it("reports valid source ranges", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(FIXTURE, "utf8");
    const funcs = analyzeSource(FIXTURE, source);
    for (const fn of funcs) {
      expect(fn.startLine).toBeGreaterThanOrEqual(1);
      expect(fn.endLine).toBeGreaterThanOrEqual(fn.startLine);
      expect(fn.startOffset).toBeGreaterThanOrEqual(0);
      expect(fn.endOffset).toBeGreaterThan(fn.startOffset);
      expect(fn.filePath).toBe(FIXTURE);
    }
  });
});

describe("analyzeFiles", () => {
  it("analyzes a file path and returns functions", () => {
    const funcs = analyzeFiles([FIXTURE]);
    expect(funcs.length).toBeGreaterThan(10);
    expect(funcs.every((f) => f.filePath === FIXTURE)).toBe(true);
  });
});

describe("discoverSourceFiles", () => {
  it("discovers .ts files in a directory", () => {
    const dir = path.resolve(__dirname, "fixtures");
    const files = discoverSourceFiles([dir]);
    expect(files).toContain(FIXTURE);
  });

  it("skips .d.ts declaration files", () => {
    expect(shouldExclude("/x/foo.d.ts")).toBe(true);
    expect(shouldExclude("/x/foo.ts")).toBe(false);
  });

  it("excludes node_modules/dist/coverage paths", () => {
    expect(shouldExclude("/x/node_modules/foo.ts")).toBe(true);
    expect(shouldExclude("/x/dist/foo.ts")).toBe(true);
    expect(shouldExclude("/x/coverage/foo.ts")).toBe(true);
  });
});
