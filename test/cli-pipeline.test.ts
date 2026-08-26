import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GitRunner } from "../src/changed.js";
import { GitInputError } from "../src/changed.js";
import {
  assertCoverageFileExists,
  assertSourcePathsExist,
  changedFilter,
  discoverSourceFilesExcluded,
  effectiveChangedSince,
  effectiveDefaultThreshold,
  eligibleFunctionsFor,
  eligibleSetOf,
  loadChangedSince,
  renderReportFor,
  resolveCliRun,
  runCliPipeline,
  writeReportAndExit,
} from "../src/cli-helpers.js";
import type {
  CliIo,
  CliRunContext,
  ParsedCliArgs,
} from "../src/cli-helpers.js";
import { DEFAULT_THRESHOLD } from "../src/crap.js";
import { buildReport } from "../src/report.js";
import type { CrapReport, ReportRow } from "../src/report.js";
import { loadConfig } from "../src/config.js";
import type { LoadedConfig } from "../src/config.js";

/** Structural mirror of coverage.ts's internal IstanbulCoverage shape. */
type IstanbulCoverage = Record<string, {
  path: string;
  fnMap: Record<string, {
    name: string;
    decl: { start: { line: number; column: number | null }; end: { line: number; column: number | null } };
    loc: { start: { line: number; column: number | null }; end: { line: number; column: number | null } };
  }>;
  f: Record<string, number>;
  statementMap?: Record<string, { start: { line: number; column: number | null }; end: { line: number; column: number | null } }>;
  s?: Record<string, number>;
}>;

const projects: string[] = [];

function tempProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-cli-pipeline-"));
  projects.push(project);
  return project;
}

function cleanup(): void {
  for (const project of projects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
}
afterEach(cleanup);

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

function args(overrides: Partial<ParsedCliArgs> = {}): ParsedCliArgs {
  return {
    sourcePaths: ["src"],
    coverageFile: "coverage.json",
    format: "human",
    ...overrides,
  };
}

function context(overrides: Partial<CliRunContext> = {}): CliRunContext {
  return {
    args: args(),
    loaded: undefined,
    defaultThreshold: DEFAULT_THRESHOLD,
    ...overrides,
  };
}

const SOURCE = [
  "export function f(x: number): number {",
  "  if (x > 0) return 1;",
  "  if (x < 0) return -1;",
  "  return 0;",
  "}",
  "",
].join("\n");

function writeSource(project: string, text: string = SOURCE): string {
  const dir = path.join(project, "src");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "a.ts");
  fs.writeFileSync(file, text);
  return file;
}

/** Coverage for src/a.ts: `f` matched; each statement's count sets the fraction. */
function coverageFor(file: string, counts: Record<string, number>): IstanbulCoverage {
  return {
    [file]: {
      path: file,
      fnMap: {
        "0": {
          name: "f",
          decl: { start: { line: 1, column: 16 }, end: { line: 1, column: 17 } },
          loc: { start: { line: 1, column: 0 }, end: { line: 5, column: 0 } },
        },
      },
      f: { "0": 1 },
      statementMap: {
        "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 25 } },
        "1": { start: { line: 3, column: 2 }, end: { line: 3, column: 25 } },
        "2": { start: { line: 4, column: 2 }, end: { line: 4, column: 12 } },
      },
      s: counts,
    },
  };
}

function writeCoverage(project: string, coverage: IstanbulCoverage): string {
  const file = path.join(project, "coverage.json");
  fs.writeFileSync(file, JSON.stringify(coverage));
  return file;
}

function runPipeline(ctx: CliRunContext, cwd: string): FakeIo {
  const io = fakeIo();
  try {
    runCliPipeline(ctx, io, cwd);
  } catch (error) {
    // The injected io models process.exit by throwing `exit:<code>`; the code
    // is already recorded on the fake. Any other error is a genuine failure.
    if (!(error instanceof Error && error.message.startsWith("exit:"))) throw error;
  }
  return io;
}

/** Synchronous wrapper around the async loadConfig for test setup. */
function loadConfigForTest(projectRoot: string, explicitPath: string): LoadedConfig {
  const loaded = loadConfig(projectRoot, explicitPath) as LoadedConfig | undefined
    | Promise<LoadedConfig | undefined>;
  if (loaded instanceof Promise || loaded === undefined) {
    throw new Error("expected the config to load synchronously in tests");
  }
  return loaded;
}

describe("effectiveDefaultThreshold", () => {
  it("prefers the CLI threshold over config and the default", () => {
    const loaded = {
      config: { version: 1 as const, threshold: 5 },
      configPath: "/x",
      projectRoot: "/x",
    };
    expect(effectiveDefaultThreshold(args({ threshold: 9 }), loaded)).toBe(9);
    expect(effectiveDefaultThreshold(args(), loaded)).toBe(5);
    expect(effectiveDefaultThreshold(args(), undefined)).toBe(DEFAULT_THRESHOLD);
  });
});

describe("effectiveChangedSince", () => {
  it("prefers the CLI ref over config and is undefined when neither is set", () => {
    const base = context();
    expect(effectiveChangedSince(base)).toBeUndefined();
    expect(effectiveChangedSince({ ...base, args: args({ changedSince: "main" }) })).toBe("main");
    const loaded: LoadedConfig = {
      config: { version: 1, changedSince: "origin/main" },
      configPath: "/x",
      projectRoot: "/x",
    };
    expect(effectiveChangedSince({ ...base, loaded })).toBe("origin/main");
    expect(
      effectiveChangedSince({ ...base, loaded, args: args({ changedSince: "main" }) }),
    ).toBe("main");
  });
});

describe("resolveCliRun", () => {
  it("resolves CLI source paths against cwd and config src against the config directory", () => {
    const cwd = path.resolve("/work");
    const proj = path.resolve("/proj");
    const loaded: LoadedConfig = {
      config: { version: 1, src: ["lib", "src2"] },
      configPath: path.join(proj, "configs", "crap4ts.config.json"),
      projectRoot: proj,
      configRoot: path.join(proj, "configs"),
    };
    const explicit = resolveCliRun(context({ args: args({ sourcePaths: ["sub", "x/y.ts"] }), loaded }), cwd);
    expect(explicit.projectRoot).toBe(proj);
    expect(explicit.sourcePaths).toEqual([path.join(cwd, "sub"), path.join(cwd, "x", "y.ts")]);

    const fromConfig = resolveCliRun(context({ loaded, args: args({ sourcePaths: [] }) }), cwd);
    expect(fromConfig.sourcePaths).toEqual([
      path.join(proj, "configs", "lib"),
      path.join(proj, "configs", "src2"),
    ]);
    expect(fromConfig.config).toBe(loaded.config);

    const noConfig = resolveCliRun(context({ args: args({ sourcePaths: [] }) }), cwd);
    expect(noConfig.projectRoot).toBe(cwd);
    expect(noConfig.sourcePaths).toEqual([]);
    expect(noConfig.config).toBeUndefined();
  });
});

describe("changedFilter", () => {
  it("is undefined without a change set and carries the ref otherwise", () => {
    expect(changedFilter(undefined, "main")).toBeUndefined();
    const changed = {
      mergeBase: "abc123",
      files: new Map([["/p/src/a.ts", { kind: "all" as const }]]),
    };
    expect(changedFilter(changed, "main")).toEqual({
      mode: "changed",
      changedSince: "main",
      mergeBase: "abc123",
      changedFileCount: 1,
    });
    expect(changedFilter(changed, undefined)?.changedSince).toBe("abc123");
  });
});

describe("discoverSourceFilesExcluded", () => {
  it("walks the paths and applies configured exclusion globs", () => {
    const project = tempProject();
    const dir = path.join(project, "src");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "keep.ts"), "export function a(): number { return 1; }\n");
    fs.writeFileSync(path.join(dir, "skip.ts"), "export function b(): number { return 2; }\n");
    fs.writeFileSync(path.join(dir, "types.d.ts"), "export type T = number;\n");
    const found = discoverSourceFilesExcluded([dir], project, { version: 1, exclude: "**/skip.ts" });
    expect(found.map((filePath) => path.basename(filePath))).toEqual(["keep.ts"]);
  });
});

describe("eligibleFunctionsFor / eligibleSetOf", () => {
  const fn = (name: string, startLine: number, endLine: number) => ({
    name,
    displayName: name,
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 0,
    startOffset: 0,
    endOffset: 1,
    complexity: 1,
    filePath: "/p/src/a.ts",
  });

  it("keeps everything without a change set", () => {
    const functions = [fn("a", 1, 2)];
    expect(eligibleFunctionsFor(functions, undefined)).toEqual(functions);
    expect(eligibleSetOf(functions).has(functions[0]!)).toBe(true);
  });

  it("applies changed-line filtering in changed-only mode", () => {
    const inRange = fn("a", 1, 2);
    const outOfRange = fn("b", 10, 11);
    const files = new Map<string, { kind: "ranges"; ranges: { start: number; end: number }[] }>([
      ["/p/src/a.ts", { kind: "ranges", ranges: [{ start: 1, end: 2 }] }],
    ]);
    expect(eligibleFunctionsFor([inRange, outOfRange], files).map((entry) => entry.name)).toEqual([
      "a",
    ]);
  });
});

describe("assertSourcePathsExist / assertCoverageFileExists", () => {
  it("exits 1 with the exact historical messages", () => {
    const io = fakeIo();
    expect(() => assertSourcePathsExist(["/no/such/dir"], io)).toThrow("exit:1");
    expect(io.errText).toBe("Error: source path does not exist: /no/such/dir\n");

    const io2 = fakeIo();
    expect(() => assertCoverageFileExists(context(), path.resolve("/work"), io2)).toThrow("exit:1");
    expect(io2.errText).toBe("Error: coverage file does not exist: coverage.json\n");

    const io3 = fakeIo();
    assertSourcePathsExist([], io3);
    expect(io3.errText).toBe("");
  });
});

describe("coverage parsing through runCliPipeline", () => {
  it("parses a valid coverage file and proceeds to the report", () => {
    const project = tempProject();
    const file = writeSource(project);
    writeCoverage(project, coverageFor(file, { "0": 3, "1": 2, "2": 1 }));
    const io = runPipeline(context({ args: args({ format: "json" }) }), project);
    expect(io.exitCode).toBe(0);
    const parsed = JSON.parse(io.outText) as { rows: ReportRow[] };
    expect(parsed.rows).toHaveLength(1);
  });

  it("exits 1 with the parser's exact message for invalid JSON (no usage)", () => {
    const project = tempProject();
    writeSource(project);
    fs.writeFileSync(path.join(project, "coverage.json"), "{ not json");
    const io = runPipeline(context(), project);
    expect(io.exitCode).toBe(1);
    expect(io.errText.startsWith("Error: Coverage file ")).toBe(true);
    expect(io.errText).toContain("is not valid JSON");
    expect(io.errText).not.toContain("Usage:");
  });
});

describe("writeReportAndExit", () => {
  const functionCoverage = (coverage: number) => [
    {
      functionInfo: {
        name: "f",
        displayName: "f",
        startLine: 1,
        endLine: 5,
        startColumn: 0,
        endColumn: 0,
        startOffset: 0,
        endOffset: 1,
        complexity: 3,
        filePath: "/p/src/a.ts",
      },
      coverage,
      matched: true,
      totalStatements: 3,
      coveredStatements: coverage === 1 ? 3 : 0,
    },
  ];

  it("renders the report and exits 0 when the gate passes", () => {
    const io = fakeIo();
    expect(() => writeReportAndExit(context(), "/p", functionCoverage(1), undefined, io)).toThrow("exit:0");
    expect(io.exitCode).toBe(0);
    expect(io.errText).toBe("");
    const expected: CrapReport = buildReport(functionCoverage(1), 8);
    expect(io.outText).toBe(renderReportFor("human", expected) + "\n");
  });

  it("writes the exact breach line to stderr and exits 2 when the gate fails", () => {
    const io = fakeIo();
    expect(() => writeReportAndExit(context(), "/p", functionCoverage(0), undefined, io)).toThrow(
      "exit:2",
    );
    expect(io.errText).toBe("CRAP threshold exceeded: 12.0 > 8\n");
    const expected: CrapReport = buildReport(functionCoverage(0), 8);
    expect(io.outText).toBe(renderReportFor("human", expected) + "\n");
  });

  it("applies per-path configured thresholds via the run context", () => {
    const loaded: LoadedConfig = {
      config: {
        version: 1,
        thresholds: [{ glob: "**/*.ts", threshold: 100 }],
      },
      configPath: "/x",
      projectRoot: "/p",
    };
    const io = fakeIo();
    expect(() => writeReportAndExit(context({ loaded }), "/p", functionCoverage(0), undefined, io)).toThrow(
      "exit:0",
    );
    expect(io.exitCode).toBe(0);
    const expected: CrapReport = buildReport(functionCoverage(0), 8, () => 100);
    expect(io.outText).toBe(renderReportFor("human", expected) + "\n");
  });
});

describe("loadChangedSince", () => {
  function fakeGitRunner(project: string): { runner: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: GitRunner = (commandLine, cwd) => {
      calls.push([...commandLine, `@${cwd}`]);
      if (commandLine[0] === "rev-parse" && commandLine[1] === "--show-toplevel") return `${project}\n`;
      if (commandLine[0] === "rev-parse") return "cafe0000\n";
      if (commandLine[0] === "merge-base") return "abcd1234\n";
      return "";
    };
    return { runner, calls };
  }

  it("returns undefined without touching git when no ref is requested", () => {
    const project = tempProject();
    const { runner, calls } = fakeGitRunner(project);
    const ctx = context({ gitRunner: runner });
    expect(loadChangedSince(ctx, project)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("collects the change set for the CLI ref, preferring it over config", () => {
    const project = tempProject();
    const run = (command: string[]) =>
      execFileSync("git", command, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    run(["init", "--initial-branch=main"]);
    run(["config", "user.email", "test@example.invalid"]);
    run(["config", "user.name", "Test"]);
    run(["commit", "--allow-empty", "-m", "base"]);
    fs.writeFileSync(
      path.join(project, ".crap4tsrc.json"),
      JSON.stringify({ version: 1, changedSince: "origin/main" }),
    );
    const { runner, calls } = fakeGitRunner(project);
    const ctx = context({
      args: args({ changedSince: "main" }),
      loaded: {
        config: { version: 1, changedSince: "origin/main" },
        configPath: path.join(project, ".crap4tsrc.json"),
        projectRoot: project,
      },
      gitRunner: runner,
    });
    const changed = loadChangedSince(ctx, project);
    expect(changed?.mergeBase).toBe("abcd1234");
    const refCalls = calls.filter((entry) => entry[0] === "rev-parse" && entry[2]?.startsWith("cafe"));
    expect(refCalls).toHaveLength(0);
    const verify = calls.find((entry) => entry[0] === "rev-parse" && entry[1] === "--verify");
    expect(verify?.[2]).toBe("main^{commit}");
  });

  it("propagates git input errors to the caller (which maps them to exit 1)", () => {
    const project = tempProject();
    const runner: GitRunner = () => {
      throw new Error("cannot resolve git ref \"missing-ref\"; use a commit");
    };
    const ctx = context({ args: args({ changedSince: "missing-ref" }), gitRunner: runner });
    expect(() => loadChangedSince(ctx, project)).toThrow(
      'cannot determine the Git repository root: cannot resolve git ref "missing-ref"; use a commit',
    );
  });
});

describe("runCliPipeline (direct, in-process)", () => {
  it("renders the human report and exits 0 when the gate passes", () => {
    const project = tempProject();
    const file = writeSource(project);
    writeCoverage(project, coverageFor(file, { "0": 3, "1": 2, "2": 1 }));
    const io = runPipeline(context({ args: args({ format: "json" }) }), project);
    expect(io.exitCode).toBe(0);
    expect(io.errText).toBe("");
    const parsed = JSON.parse(io.outText) as { summary: { threshold: number; breached: boolean } };
    expect(parsed.summary).toMatchObject({ threshold: 8, breached: false });
    expect(io.outText.endsWith("\n")).toBe(true);
  });

  it("analyzes the directory a nested --config's src validates (end to end)", () => {
    // Nested layout: the config lives in <project>/configs and declares
    // src "src". The source file exists only under configs/src, so the run
    // can only succeed when config src resolves against the config
    // directory — the invocation root has no src to analyze.
    const project = tempProject();
    fs.mkdirSync(path.join(project, "configs"));
    const nestedFile = path.join(project, "configs", "src", "a.ts");
    fs.mkdirSync(path.join(project, "configs", "src"));
    fs.writeFileSync(nestedFile, SOURCE);
    fs.writeFileSync(
      path.join(project, "configs", "check.json"),
      JSON.stringify({ version: 1, src: "src" }),
    );
    writeCoverage(
      project,
      coverageFor(fs.realpathSync.native(nestedFile), { "0": 3, "1": 2, "2": 1 }),
    );

    // Negative proof first: without a loaded config, the default "src"
    // resolution against the invocation root finds nothing (the directory
    // does not exist), which is an invalid-input exit.
    const empty = runPipeline(context({ args: args({ sourcePaths: [] }) }), project);
    expect(empty.exitCode).toBe(1);
    expect(empty.errText).toBe("Error: no source paths provided and config has no src\n");

    // Positive proof: loading the nested config analyzes exactly the
    // validated configs/src directory and matches its coverage.
    const loaded = loadConfigForTest(project, path.join("configs", "check.json"));
    expect(loaded.configRoot).toBe(path.join(fs.realpathSync(project), "configs"));
    const io = runPipeline(
      context({ args: args({ format: "json", sourcePaths: [] }), loaded }),
      project,
    );
    expect(io.exitCode).toBe(0);
    expect(io.errText).toBe("");
    const parsed = JSON.parse(io.outText) as { rows: Array<{ filePath: string; name: string }> };
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      name: "f",
      filePath: path.join(loaded.configRoot, "src", "a.ts"),
    });
  });

  it("exits 2 with the exact breach line when the gate fails", () => {
    const project = tempProject();
    const file = writeSource(project);
    writeCoverage(project, coverageFor(file, { "0": 0, "1": 0, "2": 0 }));
    const io = runPipeline(context({ args: args({ format: "json" }) }), project);
    expect(io.exitCode).toBe(2);
    expect(io.errText).toBe("CRAP threshold exceeded: 12.0 > 8\n");
    const parsed = JSON.parse(io.outText) as { rows: ReportRow[] };
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ name: "f", coverage: 0, crap: 12 });
  });

  it("exits 0 with the empty result for an empty source directory", () => {
    const project = tempProject();
    fs.mkdirSync(path.join(project, "src"));
    writeCoverage(project, coverageFor("/unused", {}));
    const io = runPipeline(context(), project);
    expect(io.exitCode).toBe(0);
    expect(io.outText).toBe("No TypeScript source files found under: " + path.join(project, "src") + "\n");
  });

  it("exits 1 when the coverage file does not exist", () => {
    const project = tempProject();
    writeSource(project);
    const io = runPipeline(context(), project);
    expect(io.exitCode).toBe(1);
    expect(io.errText).toBe("Error: coverage file does not exist: coverage.json\n");
  });

  it("exits 1 when a source path does not exist", () => {
    const project = tempProject();
    writeCoverage(project, coverageFor("/unused", {}));
    const io = runPipeline(
      context({ args: args({ sourcePaths: ["missing-dir"] }) }),
      project,
    );
    expect(io.exitCode).toBe(1);
    expect(io.errText).toBe(`Error: source path does not exist: ${path.join(project, "missing-dir")}\n`);
  });

  it("exits 1 with the empty-result message for markdown format on no files", () => {
    const project = tempProject();
    fs.mkdirSync(path.join(project, "src"));
    writeCoverage(project, coverageFor("/unused", {}));
    const io = runPipeline(context({ args: args({ format: "markdown" }) }), project);
    expect(io.exitCode).toBe(0);
    const message = `No TypeScript source files found under: ${path.join(project, "src")}`;
    expect(io.outText).toBe(`_${message}_\n`);
  });

  it("propagates git errors so the CLI entry guard maps them to the exact Error line + exit 1", () => {
    const project = tempProject();
    const runner: GitRunner = () => {
      throw new Error("cannot resolve git ref \"missing-ref\"; use a commit, branch, tag, or remote-tracking ref available locally");
    };
    const io = fakeIo();
    expect(() => runCliPipeline(
      context({ args: args({ changedSince: "missing-ref" }), gitRunner: runner }),
      io,
      project,
    )).toThrow(GitInputError);
    expect(io.errText).toBe("");
    expect(io.outText).toBe("");
  });

  it("renders the empty-eligible report with the changed filter and exits 0 in changed-only mode", () => {
    const project = tempProject();
    fs.mkdirSync(path.join(project, "src"));
    const file = path.join(project, "src", "a.ts");
    fs.writeFileSync(file, ["// base", "export function f(): number { return 1; }", ""].join("\n"));
    writeCoverage(project, coverageFor(fs.realpathSync.native(file), { "0": 1 }));
    const run = (command: string[]) => {
      execFileSync("git", command, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    };
    run(["init", "--initial-branch=main"]);
    run(["config", "user.email", "test@example.invalid"]);
    run(["config", "user.name", "Test"]);
    run(["add", "."]);
    run(["commit", "-m", "base"]);
    run(["checkout", "-b", "feature"]);
    fs.writeFileSync(file, ["// modified", "export function f(): number { return 1; }", ""].join("\n"));
    run(["add", "."]);
    run(["commit", "-m", "change comment only"]);

    const io = runPipeline(context({ args: args({ changedSince: "main", format: "json" }) }), project);
    expect(io.exitCode).toBe(0);
    expect(io.errText).toBe("");
    const parsed = JSON.parse(io.outText) as {
      filter: { mode: string; changedSince: string };
      rows: ReportRow[];
    };
    expect(parsed.filter).toMatchObject({ mode: "changed", changedSince: "main" });
    expect(parsed.rows).toEqual([]);
  });
});
