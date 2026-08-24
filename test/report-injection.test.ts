import { describe, expect, it } from "vitest";
import { buildReport, literalCode, renderMarkdownReport } from "../src/report.js";
import type { FunctionCoverage } from "../src/coverage.js";
import type { FunctionInfo } from "../src/complexity.js";

/**
 * Adversarial values that attempt Markdown/HTML injection through function
 * names and file paths. Each must be rendered as literal text inside a code
 * span, never as a link, image, HTML block, emphasis, heading, or table
 * structure.
 */
const ADVERSARIAL_NAMES: readonly string[] = [
  "[link](https://evil.example)",
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "![image](https://evil.example/x.png)",
  "name`code`more",
  "back\\slash|pipe",
  "line1\n## heading injected",
  "line1\r\n<img src=x>",
  "**bold** __also bold__ *em*",
  "| fake | header |",
  "[a](b) [c](d) <details><summary>x</summary>y</details>",
];

function makeFn(name: string, complexity: number, coverage: number): FunctionCoverage {
  const fi: FunctionInfo = {
    name,
    displayName: name,
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 100,
    startOffset: 0,
    endOffset: 100,
    complexity,
    filePath: `/src/${name}.ts`,
  };
  return { functionInfo: fi, coverage, matched: true, totalStatements: 2, coveredStatements: coverage * 2 };
}

describe("renderMarkdownReport injection resistance", () => {
  it.each(ADVERSARIAL_NAMES)("renders %j as literal content", (hostile) => {
    const report = buildReport([makeFn(hostile, 4, 0)], 8);
    const md = renderMarkdownReport(report);
    const rowLine = md.split("\n").find((l) => l.startsWith(`| \`${hostile.slice(0, 4)}`) || l.includes("\\|") || l.startsWith("| ⚠️"));

    // Unsafe content is rendered as a literal code span; punctuation is
    // escaped so the hostile value cannot add Markdown table columns.
    expect(md).toContain(literalCode(hostile.replace(/[!-/:-@[-`{-~]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, " ")));

    // No raw un-escaped hostile markup survives in the table row.
    if (rowLine !== undefined) {
      expect(rowLine).not.toMatch(/(?<!\\)\[[^\]]*\]\(https?:\/\//);
      expect(rowLine).not.toContain("`<script");
      expect(rowLine).not.toContain("`<img ");
      expect(rowLine).not.toMatch(/(?<!\\)<[a-z]/);
    }
  });

  it("never emits CR or LF from dynamic cell values (no new table rows or blocks)", () => {
    const hostile = "fn\n| injected | row |\n<script>";
    const md = renderMarkdownReport(buildReport([makeFn(hostile, 4, 0)], 8));
    const dataLines = md.split("\n").filter((l) => l.startsWith("|"));
    // Header + separator + one data row only.
    expect(dataLines).toHaveLength(3);
    for (const line of dataLines) {
      expect(line).not.toContain("<script>");
      expect(line).not.toContain("injected | row |");
    }
  });

  it("escapes pipes so adversarial names cannot add columns to the table", () => {
    const md = renderMarkdownReport(buildReport([makeFn("a|b|c", 4, 0)], 8));
    const dataRow = md.split("\n").find((l) => l.startsWith("| ") && !l.startsWith("| Function") && !l.startsWith("| ---"));
    expect(dataRow).toBeDefined();
    // 7 columns => exactly 8 pipes; escaped pipes don't count.
    expect((dataRow as string).match(/(?<!\\)\|/g)).toHaveLength(8);
  });

  it("uses a longer delimiter when unsafe values contain backticks", () => {
    const md = renderMarkdownReport(buildReport([makeFn("x`y", 4, 0)], 8));
    expect(md).toContain(literalCode("x\\`y"));
  });

  it("neutralizes link syntax in file paths too", () => {
    const fi: FunctionInfo = {
      name: "fn",
      displayName: "fn",
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 10,
      startOffset: 0,
      endOffset: 10,
      complexity: 4,
      filePath: "/src/[x](https://evil.example)/a.ts",
    };
    const md = renderMarkdownReport(buildReport([{ functionInfo: fi, coverage: 0, matched: true, totalStatements: 1, coveredStatements: 0 }], 8));
    expect(md).not.toMatch(/\]\(https?:\/\//);
  });
});
