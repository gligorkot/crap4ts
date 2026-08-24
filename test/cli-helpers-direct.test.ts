import { describe, expect, it } from "vitest";
import { CliArgError, parseArgsPure } from "../src/cli-helpers.js";

/**
 * Direct in-process tests for the argv-scanning helpers extracted from the
 * threshold-8-breaching `parseArgsPure` to cut its CRAP score while
 * preserving every behavior:
 *
 * - value-option validation: presence is required before per-option
 *   validation, a following flag is rejected, and every message is
 *   byte-exact;
 * - `--threshold` conversion: non-numeric, negative, and boundary values;
 * - `--format` validation against the supported set;
 * - per-token dispatch: value options consume their value (including the
 *   `--threshold` else-arm of the value-option switch), `--json` and the
 *   `--markdown` alias set the format, unknown `--` options fail, and
 *   everything else is a source path;
 * - scan order: later flags override earlier ones, mixed tokens scan
 *   left-to-right, and the required `--coverage` check runs after the full
 *   scan with the historical message.
 */

function expectArgError(fn: () => unknown, message: string): void {
  try {
    fn();
    expect.unreachable("expected CliArgError");
  } catch (e) {
    expect(e).toBeInstanceOf(CliArgError);
    expect((e as CliArgError).message).toBe(message);
  }
}

describe("argv value-option validation (requireValue extraction)", () => {
  it("rejects a missing value with the exact message for every value option", () => {
    for (const opt of ["--coverage", "--config", "--threshold", "--changed-since", "--format"]) {
      expectArgError(
        () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", opt]),
        `${opt} requires a value`,
      );
    }
  });

  it("rejects a following option as a value with the exact message", () => {
    for (const [opt, next] of [
      ["--coverage", "--json"],
      ["--config", "--markdown"],
      ["--threshold", "--json"],
      ["--changed-since", "--json"],
      ["--format", "--json"],
    ] as const) {
      expectArgError(
        () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", opt, next]),
        `${opt} requires a value`,
      );
    }
  });

  it("checks value presence before per-option validation: a missing value is reported first", () => {
    // `--format` with no value at all: the presence error wins over the
    // (impossible-to-reach) format-validity error.
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--format"]),
      "--format requires a value",
    );
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold"]),
      "--threshold requires a value",
    );
  });

  it("checks value presence before the required-coverage check: the scan error wins", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage"]),
      "--coverage requires a value",
    );
  });
});

describe("threshold value conversion (parseThresholdValue extraction)", () => {
  it("accepts integer, decimal, and zero thresholds", () => {
    expect(parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "12"]).threshold).toBe(12);
    expect(parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "12.5"]).threshold).toBe(12.5);
    expect(parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "0"]).threshold).toBe(0);
  });

  it("rejects non-numeric thresholds with the exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "abc"]),
      '--threshold must be a non-negative number, got "abc"',
    );
  });

  it("rejects non-finite thresholds with the exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "Infinity"]),
      '--threshold must be a non-negative number, got "Infinity"',
    );
  });

  it("rejects negative thresholds with the exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "-1"]),
      '--threshold must be a non-negative number, got "-1"',
    );
  });
});

describe("format value validation (assertSupportedFormat extraction)", () => {
  it("accepts each supported format", () => {
    for (const format of ["human", "json", "markdown"]) {
      expect(parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--format", format]).format).toBe(format);
    }
  });

  it("rejects unsupported formats with the exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--format", "html"]),
      '--format must be one of human, json, markdown, got "html"',
    );
  });
});

describe("bare-argument dispatch (applyBareArg extraction)", () => {
  it("collects non-option tokens as source paths in order", () => {
    const args = parseArgsPure(["node", "cli.ts", "a.ts", "dir/", "b.ts", "--coverage", "c.json"]);
    expect(args.sourcePaths).toEqual(["a.ts", "dir/", "b.ts"]);
  });

  it("sets the format for the --json flag without consuming the next token", () => {
    // The token after --json is NOT a value: it stays a source path.
    const args = parseArgsPure(["node", "cli.ts", "--json", "a.ts", "--coverage", "c.json"]);
    expect(args.format).toBe("json");
    expect(args.sourcePaths).toEqual(["a.ts"]);
  });

  it("sets the format for the deprecated --markdown alias", () => {
    expect(parseArgsPure(["node", "cli.ts", "--markdown", "--coverage", "c.json"]).format).toBe("markdown");
  });

  it("rejects unknown options with the exact message", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--bogus"]),
      'unknown option "--bogus"',
    );
  });

  it("rejects unknown long options even when a value-like token follows", () => {
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--bogus", "value"]),
      'unknown option "--bogus"',
    );
  });
});

describe("value-option dispatch (applyValueOption extraction)", () => {
  it("assigns --coverage, --config, --changed-since, and --format values", () => {
    const args = parseArgsPure([
      "node", "cli.ts",
      "--coverage", "cov.json",
      "--config", "crap.config.ts",
      "--changed-since", "main",
      "--format", "markdown",
    ]);
    expect(args.coverageFile).toBe("cov.json");
    expect(args.configPath).toBe("crap.config.ts");
    expect(args.changedSince).toBe("main");
    expect(args.format).toBe("markdown");
  });

  it("assigns --threshold via the else-arm of the value-option switch", () => {
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "7"]);
    expect(args.threshold).toBe(7);
  });

  it("keeps omitted optional value options absent from the result object", () => {
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "c.json"]);
    expect(Object.prototype.hasOwnProperty.call(args, "threshold")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(args, "configPath")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(args, "changedSince")).toBe(false);
  });
});

describe("scan order and composition (scanArgs extraction)", () => {
  it("parses a full argument set", () => {
    const args = parseArgsPure([
      "node", "cli.ts",
      "src/a.ts", "src/b.ts",
      "--coverage", "cov.json",
      "--threshold", "12.5",
      "--config", "crap.config.ts",
      "--changed-since", "main",
      "--format", "markdown",
    ]);
    expect(args).toEqual({
      sourcePaths: ["src/a.ts", "src/b.ts"],
      coverageFile: "cov.json",
      threshold: 12.5,
      configPath: "crap.config.ts",
      changedSince: "main",
      format: "markdown",
    });
  });

  it("defaults to human format and no source paths", () => {
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "c.json"]);
    expect(args.format).toBe("human");
    expect(args.sourcePaths).toEqual([]);
  });

  it("lets later flags override earlier format selection", () => {
    expect(parseArgsPure(["node", "cli.ts", "--json", "--format", "human", "--coverage", "c.json"]).format).toBe("human");
    expect(parseArgsPure(["node", "cli.ts", "--format", "json", "--markdown", "--coverage", "c.json"]).format).toBe("markdown");
    expect(parseArgsPure(["node", "cli.ts", "--markdown", "--json", "--coverage", "c.json"]).format).toBe("json");
  });

  it("lets later value options override earlier values", () => {
    const args = parseArgsPure([
      "node", "cli.ts",
      "--threshold", "1", "--threshold", "2",
      "--coverage", "first.json", "--coverage", "second.json",
      "--config", "a.json", "--config", "b.json",
      "--changed-since", "dev", "--changed-since", "main",
    ]);
    expect(args.threshold).toBe(2);
    expect(args.coverageFile).toBe("second.json");
    expect(args.configPath).toBe("b.json");
    expect(args.changedSince).toBe("main");
  });

  it("applies tokens strictly left-to-right: an early error stops the scan", () => {
    // The later --bogus is never reached because the invalid threshold fails first.
    expectArgError(
      () => parseArgsPure(["node", "cli.ts", "--coverage", "c.json", "--threshold", "abc", "--bogus"]),
      '--threshold must be a non-negative number, got "abc"',
    );
  });

  it("consumes value tokens so they are not seen as separate arguments", () => {
    // "cov.json" is consumed by --coverage; the scan continues at --json.
    const args = parseArgsPure(["node", "cli.ts", "--coverage", "cov.json", "--json"]);
    expect(args.coverageFile).toBe("cov.json");
    expect(args.format).toBe("json");
    expect(args.sourcePaths).toEqual([]);
  });
});

describe("required-coverage check (parseArgsPure tail)", () => {
  it("requires --coverage after the full scan with the exact message", () => {
    expectArgError(() => parseArgsPure(["node", "cli.ts"]), "--coverage is required");
    expectArgError(() => parseArgsPure(["node", "cli.ts", "src"]), "--coverage is required");
  });
});
