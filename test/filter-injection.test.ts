import { describe, expect, it } from "vitest";
import { buildReport, renderMarkdownReport, literalCode } from "../src/report.js";
import type { CrapReport, ReportFilter } from "../src/report.js";

function reportWithFilter(changedSince: string, mergeBase = "abc1234"): CrapReport {
  const filter: ReportFilter = {
    mode: "changed",
    changedSince,
    mergeBase,
    changedFileCount: 0,
  };
  return buildReport([], 8, undefined, filter);
}

/** Parse inline code spans of the form {fence} {inner} {fence}. */
function parseCodeSpans(line: string): string[] {
  const spans: string[] = [];
  const re = /(`+) ([^]*?) \1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) spans.push(m[2]);
  return spans;
}

describe("renderMarkdownReport filter metadata injection resistance", () => {
  it("keeps changedSince with embedded backticks inside one code span", () => {
    const hostile = "main` <script>alert(1)</script> `evil";
    const md = renderMarkdownReport(reportWithFilter(hostile));
    const line = md.split("\n").find((l) => l.includes("Changed-only mode"))!;
    // The full hostile value must appear verbatim inside a single code span.
    expect(parseCodeSpans(line)).toContain(hostile);
    // Everything outside spans on that line contains no markup characters.
    const outside = line.replace(/`+ [^]*? `+/g, "");
    expect(outside).not.toMatch(/[<>]/);
  });

  it("uses a delimiter longer than any embedded backtick run", () => {
    const md = renderMarkdownReport(
      reportWithFilter("```` injected ```` <details><summary>x</summary></details>"),
    );
    const line = md.split("\n").find((l) => l.includes("Changed-only mode"))!;
    const fence = line.match(/since (`+) /)?.[1];
    expect(fence).toBeDefined();
    expect(fence!.length).toBeGreaterThan(4); // embedded run is exactly 4
    for (const run of line.match(/`+/g) ?? []) {
      if (run === fence) continue;
      expect(run.length).toBeLessThan(fence!.length);
    }
  });

  it("neutralizes CR/LF/control characters in changedSince so no new lines or blocks can start", () => {
    const hostile = "main\r\n# heading\n<img src=x>\t<script>alert(1)</script>";
    const md = renderMarkdownReport(reportWithFilter(hostile));
    // Filter info stays on exactly one physical line.
    const lines = md.split("\n").filter((l) => l.includes("Changed-only mode"));
    expect(lines).toHaveLength(1);
    // The cleaned value sits inside a code span; no heading/HTML block exists.
    expect(parseCodeSpans(lines[0])).toContain("main  # heading <img src=x> <script>alert(1)</script>");
    expect(md.split("\n")).toHaveLength(renderMarkdownReport(reportWithFilter("clean")).split("\n").length);
  });

  it("applies the same hardening to mergeBase", () => {
    const md = renderMarkdownReport(reportWithFilter("main", "deadbeef`</code><details open>"));
    const line = md.split("\n").find((l) => l.includes("Changed-only mode"))!;
    expect(parseCodeSpans(line)).toContain("deadbeef`</code><details open>");
    const outside = line.replace(/`+ [^]*? `+/g, "");
    expect(outside).not.toMatch(/<\/?(code|details|script|img)/);
  });

  it("literalCode never allows an embedded run to close the span", () => {
    for (const value of ["`", "``", "a```b", "````x````", "` ` `", "\r\n`x`"]) {
      const rendered = literalCode(value);
      const fenceMatch = rendered.match(/^(`+) /);
      expect(fenceMatch).not.toBeNull();
      const fence = fenceMatch![1];
      const inner = rendered.slice(fence.length + 1, rendered.length - fence.length - 1);
      // No backtick run inside may equal or exceed the delimiter length.
      for (const run of inner.match(/`+/g) ?? []) {
        expect(run.length).toBeLessThan(fence.length);
      }
      expect(rendered.endsWith(` ${fence}`)).toBe(true);
      expect(inner).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
});
