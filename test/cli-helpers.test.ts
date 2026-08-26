import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  buildEmptyResult,
  CliArgError,
  isHelpRequest,
  parseArgsPure,
  renderReportFor,
  serializeEmptyResult,
} from "../src/cli-helpers.js";
import { buildReport } from "../src/report.js";
import type { CrapReport } from "../src/report.js";
import { EXIT_INVALID_INPUT } from "../src/crap.js";

const FIXTURE = path.resolve(__dirname, "fixtures/sample.ts");
const COVERAGE = path.resolve(__dirname, "fixtures/coverage-sample.json");

function expectArgError(fn: () => unknown, message: string): void {
  try {
    fn();
    expect.unreachable("expected CliArgError");
  } catch (e) {
    expect(e).toBeInstanceOf(CliArgError);
    expect((e as CliArgError).message).toBe(message);
  }
}

describe("isHelpRequest", () => {
  it("matches --help and -h after the script path", () => {
    expect(isHelpRequest(["node", "cli.ts", "--help"])).toBe(true);
    expect(isHelpRequest(["node", "cli.ts", "-h"])).toBe(true);
    expect(isHelpRequest(["node", "cli.ts", "--json", "--help"])).toBe(true);
  });

  it("does not match when help flag absent or embedded in a value", () => {
    expect(isHelpRequest(["node", "cli.ts", "--coverage", "--helpish"])).toBe(false);
    expect(isHelpRequest(["node", "cli.ts", "--coverage", "x", "--json"])).toBe(false);
    expect(isHelpRequest([])).toBe(false);
  });
});

describe("parseArgsPure", () => {
  it("parses a full argument set", () => {
    const args = parseArgsPure([
      "node", "cli.ts",
      "src/a.ts", "src/b.ts",
      "--coverage", "cov.json",
      "--threshold", "12.5",
      "--config", "crap.config.ts",
      "--changed-since", "main",
      "--format", "markdown",
      "--with-table",
    ]);
    expect(args).toEqual({
      sourcePaths: ["src/a.ts", "src/b.ts"],
      coverageFile: "cov.json",
      threshold: 12.5,
      configPath: "crap.config.ts",
      changedSince: "main",
      format: "markdown",
      withTable: true,
    });
  });

  it("defaults to human format and no source paths", () => {
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "c.json"]);
    expect(args.format).toBe("human");
    expect(args.sourcePaths).toEqual([]);
    expect(args.threshold).toBeUndefined();
    expect(args.configPath).toBeUndefined();
    expect(args.changedSince).toBeUndefined();
    expect(args.withTable).toBe(false);
  });

  it("parses --with-table as an opt-in Markdown table flag", () => {
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--format", "markdown", "--with-table"]);
    expect(args.withTable).toBe(true);
  });

  it("treats --json as format json", () => {
    const args = parseArgsPure(["node", "cli.ts", "--json", "--coverage", "c.json"]);
    expect(args.format).toBe("json");
  });

  it("treats --markdown as deprecated alias for format markdown", () => {
    const args = parseArgsPure(["node", "cli.ts", "--markdown", "--coverage", "c.json"]);
    expect(args.format).toBe("markdown");
  });

  it("later flags override earlier format selection", () => {
    const args = parseArgsPure(["node", "cli.ts", "--json", "--format", "human", "--coverage", "c.json"]);
    expect(args.format).toBe("human");
  });

  it("accepts zero as a valid threshold", () => {
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "0"]);
    expect(args.threshold).toBe(0);
  });

  it("rejects missing value for every value option with exact message", () => {
    for (const opt of ["--coverage", "--config", "--threshold", "--changed-since", "--format"]) {
      expectArgError(
        () => parseArgsPure(["node", "cli.ts", opt]),
        `${opt} requires a value`,
      );
    }
  });

  it("rejects a following option as a value", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "--json"]),
      "--coverage requires a value",
    );
  });

  it("rejects invalid --format values with exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c", "--format", "html"]),
      '--format must be one of human, json, markdown, got "html"',
    );
  });

  it("rejects non-numeric thresholds with exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c", "--threshold", "abc"]),
      '--threshold must be a non-negative number, got "abc"',
    );
  });

  it("rejects negative thresholds with exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c", "--threshold", "-1"]),
      '--threshold must be a non-negative number, got "-1"',
    );
  });

  it("rejects unknown options with exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c", "--bogus"]),
      'unknown option "--bogus"',
    );
  });

  it("requires --coverage", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "src"]),
      "--coverage is required",
    );
  });

  it("uses exit code EXIT_INVALID_INPUT (1) semantics for arg errors", () => {
    // The CLI maps CliArgError onto EXIT_INVALID_INPUT; assert the constant
    // wiring stays intact so exit codes are preserved.
    expect(EXIT_INVALID_INPUT).toBe(1);
  });
});

describe("renderReportFor", () => {
  function sampleReport(): CrapReport {
    return buildReport(
      [{
        functionInfo: {
          name: "sampleFn",
          displayName: "sampleFn",
          filePath: "/repo/src/sample.ts",
          startLine: 10,
          endLine: 20,
          startColumn: 1,
          endColumn: 2,
          startOffset: 0,
          endOffset: 10,
          complexity: 5,
        },
        coverage: 0.4,
        matched: true,
        totalStatements: 10,
        coveredStatements: 4,
      }],
      8,
    );
  }

  it("renders JSON via --format json equivalently to renderJsonReport", () => {
    const report = sampleReport();
    expect(renderReportFor("json", report)).toBe(JSON.stringify(report, null, 2));
    const parsed = JSON.parse(renderReportFor("json", report));
    expect(parsed.summary.threshold).toBe(8);
  });

  it("renders compact Markdown via --format markdown by default", () => {
    const out = renderReportFor("markdown", sampleReport());
    expect(out).toContain("## CRAP Report");
    expect(out).toContain("**Gate:**");
    expect(out).not.toContain("| Function | File | Line | CC | Cov | Threshold | CRAP |");
  });

  it("renders the Markdown table only when requested", () => {
    const out = renderReportFor("markdown", sampleReport(), true);
    expect(out).toContain("| Function | File | Line | CC | Cov | Threshold | CRAP |");
  });

  it("renders human output by default shape", () => {
    const out = renderReportFor("human", sampleReport());
    expect(out).toContain("CRAP Report");
    expect(out).toContain("Gate:");
  });
});

describe("empty result payload", () => {
  it("builds zeroed summary echoing threshold", () => {
    expect(buildEmptyResult(42)).toEqual({
      rows: [],
      summary: {
        totalFunctions: 0,
        breachedCount: 0,
        maxCrap: 0,
        threshold: 42,
        breached: false,
      },
    });
  });

  it("serializes with 2-space indent and trailing newline", () => {
    expect(serializeEmptyResult(7)).toBe(JSON.stringify(buildEmptyResult(7), null, 2) + "\n");
    const parsed = JSON.parse(serializeEmptyResult(7));
    expect(parsed.rows).toEqual([]);
    expect(parsed.summary.threshold).toBe(7);
    expect(parsed.summary.breached).toBe(false);
  });
});

import { defaultCliIo, failInvalid, failWithUsage, parseArgsOrExit, resolveConfigSourcePaths, usageText, writeEmptyResultFor } from "../src/cli-helpers.js";
import type { CliIo } from "../src/cli-helpers.js";

interface FakeIo extends CliIo {
  outText: string;
  errText: string;
  exitCode?: number;
}

function fakeIo(): FakeIo {
  const io: FakeIo = {
    outText: "",
    errText: "",
    out(text) {
      io.outText += text;
    },
    err(text) {
      io.errText += text;
    },
    exit(code) {
      io.exitCode = code;
      throw new Error(`exit:${code}`);
    },
  };
  return io;
}

describe("parseArgsOrExit / failWithUsage / failInvalid", () => {
  it("prints usage to stdout and exits 0 for --help", () => {
    const io = fakeIo();
    expect(() => parseArgsOrExit(["node", "cli.ts", "--help"], io)).toThrow("exit:0");
    expect(io.outText).toContain("Usage:");
    expect(io.exitCode).toBe(0);
  });

  it("parses successfully without touching streams", () => {
    const io = fakeIo();
    const args = parseArgsOrExit(["node", "cli.ts", "--coverage", "c.json", "--json"], io);
    expect(args.format).toBe("json");
    expect(io.outText).toBe("");
    expect(io.errText).toBe("");
    expect(io.exitCode).toBeUndefined();
  });

  it("on arg error prints Error + usage and exits with invalid-input code", () => {
    const io = fakeIo();
    expect(() => parseArgsOrExit(["node", "cli.ts", "--bogus"], io)).toThrow("exit:1");
    expect(io.errText).toContain('Error: unknown option "--bogus"');
    expect(io.errText).toContain("Usage:");
    expect(io.exitCode).toBe(EXIT_INVALID_INPUT);
  });

  it("failWithUsage prefixes Error and exits 1 with usage text", () => {
    const io = fakeIo();
    expect(() => failWithUsage("no source paths provided and config has no src", io)).toThrow("exit:1");
    expect(io.errText).toContain("Error: no source paths provided and config has no src");
    expect(io.errText).toContain("Exit codes:");
  });

  it("failInvalid prints Error and exits 1 without usage", () => {
    const io = fakeIo();
    expect(() => failInvalid("coverage file does not exist: x.json", io)).toThrow("exit:1");
    expect(io.errText).toBe("Error: coverage file does not exist: x.json\n");
    expect(io.errText).not.toContain("Usage:");
  });
});

describe("writeEmptyResultFor", () => {
  it("emits serialized JSON payload for json format", () => {
    const io = fakeIo();
    writeEmptyResultFor("json", "ignored message", 5, io);
    expect(JSON.parse(io.outText).summary.threshold).toBe(5);
    expect(io.outText.endsWith("\n")).toBe(true);
  });

  it("italicises the message for markdown format", () => {
    const io = fakeIo();
    writeEmptyResultFor("markdown", "No TypeScript source files found under: /x", 8, io);
    expect(io.outText).toBe("_No TypeScript source files found under: /x_\n");
  });

  it("writes the plain message plus newline for human format", () => {
    const io = fakeIo();
    writeEmptyResultFor("human", "No TypeScript source files found under: /x", 8, io);
    expect(io.outText).toBe("No TypeScript source files found under: /x\n");
  });
});

describe("usageText / defaultCliIo", () => {
  it("documents every supported flag", () => {
    for (const flag of ["--coverage", "--config", "--threshold", "--changed-since", "--format", "--markdown", "--json", "--help"]) {
      expect(usageText()).toContain(flag);
    }
    expect(usageText()).toContain("TS, ESM (.mjs), CommonJS (.cjs), JS, or JSON");
  });

  it("defaultCliIo wires the real process streams and exit", () => {
    const real = defaultCliIo();
    expect(typeof real.out).toBe("function");
    expect(typeof real.err).toBe("function");
    expect(typeof real.exit).toBe("function");
  });
});

describe("resolveConfigSourcePaths", () => {
  const root = path.resolve("/proj");

  it("returns an empty list for undefined", () => {
    expect(resolveConfigSourcePaths(undefined, root)).toEqual([]);
  });

  it("wraps a single string into a one-element resolved list", () => {
    expect(resolveConfigSourcePaths("src/a.ts", root)).toEqual([path.resolve(root, "src/a.ts")]);
  });

  it("resolves each entry of a list", () => {
    expect(resolveConfigSourcePaths(["src/a.ts", "lib/b.ts"], root)).toEqual([
      path.resolve(root, "src/a.ts"),
      path.resolve(root, "lib/b.ts"),
    ]);
  });
});

describe("parseArgsOrExit rethrows non-CliArgError exceptions", () => {
  it("propagates unexpected errors instead of converting them to usage output", () => {
    // parseArgsPure only throws CliArgError; simulate a foreign failure by
    // passing a frozen argv-like object that breaks slice.
    const io = fakeIo();
    const hostile = { slice: () => {
      throw new Error("boom");
    } } as unknown as string[];
    expect(() => parseArgsOrExit(hostile, io)).toThrow("boom");
    expect(io.exitCode).toBeUndefined();
  });
});
