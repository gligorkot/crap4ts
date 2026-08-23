# crap4ts

A CRAP metric analyzer for TypeScript and TSX source. It calculates the
CRAP score per function from cyclomatic complexity and test coverage, then
gates on a configurable threshold.

## What is CRAP?

CRAP (Change Risk Anti-Patterns) measures the risk a function introduces by
combining its cyclomatic complexity with its test coverage. High complexity
combined with low coverage is riskier than the same complexity with thorough
coverage.

Formula:

```
CRAP = cyclomaticComplexity^2 * (1 - coverage)^3 + cyclomaticComplexity
```

Where `coverage` is a decimal in `[0, 1]` (0 = uncovered, 1 = fully covered)
and `cyclomaticComplexity` is an integer `>= 1`.

A function fails the quality gate when its CRAP score is strictly greater
than the threshold (default: **8**).

## Install

```sh
npm install --save-dev crap4ts
```

## Usage

```sh
# Analyze src/ with V8 coverage from Vitest, fail if any score > 8
npx crap4ts src --coverage coverage/coverage-final.json --threshold 8

# JSON output for CI tooling
npx crap4ts src --coverage coverage/coverage-final.json --json

# Multiple source paths
npx crap4ts src lib --coverage coverage/coverage-final.json
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--coverage <file>` | Path to Istanbul `coverage-final.json` (Vitest V8 output). **Required.** | — |
| `--config <path>` | Load exactly this TS, ESM (`.mjs`), CommonJS (`.cjs`), module-system-dependent JS (`.js`), or JSON configuration file. | auto-discovery |
| `--threshold <number>` | Override every configured CRAP failure threshold; breach when score > threshold. | `8` |
| `--json` | Output JSON report instead of human-readable table. | off |
| `--help` | Print usage and exit. | — |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — no threshold breach. |
| `1` | Invalid arguments or input (no stack trace). |
| `2` | CRAP threshold exceeded. |

## Configuration

crap4ts discovers one configuration file from the project root (the current
working directory), in this exact order:

1. `crap4ts.config.ts`
2. `crap4ts.config.mjs`
3. `crap4ts.config.cjs`
4. `crap4ts.config.js`
5. `.crap4tsrc.json`

Use `--config <path>` to select exactly one file instead; it disables discovery.
A selected or discovered config that is missing, unreadable, invalid, or has an
unsupported version is an input error (exit code 1). Config files are strict:
their required `version` is `1`, unknown fields are rejected, and thresholds
must be finite non-negative numbers.

```ts
// crap4ts.config.ts
import { defineConfig } from "crap4ts";

export default defineConfig({
  version: 1,
  src: ["src", "packages/api/src"],
  exclude: ["src/generated/**", "**/*.generated.ts"],
  threshold: 8,
  thresholds: [
    { glob: "src/legacy/**", threshold: 15 },
    { glob: "src/security/**/*.ts", threshold: 4 },
  ],
});
```

```js
// crap4ts.config.mjs — ESM in every project module system
import { defineConfig } from "crap4ts";

export default defineConfig({
  version: 1,
  src: "src",
  threshold: 8,
});
```

```js
// crap4ts.config.cjs — CommonJS in every project module system
module.exports = {
  version: 1,
  src: "src",
  threshold: 8,
};
```

JSON config has the same shape without `defineConfig`:

```json
{ "version": 1, "src": "src", "threshold": 8 }
```

`src` and `exclude` accept a string or an array of strings. `src` must contain
at least one project-relative path and may not be absolute or escape the config
file's directory; this keeps exclude and per-path threshold matching unambiguous.
Config paths and globs are relative to the config file's directory. `exclude`
uses a small, deterministic glob language: `*` matches within one path segment,
`**` matches across segments, and `?` matches one non-separator character. The
built-in exclusions for declaration files, `node_modules`, `dist`, `coverage`,
and `.git` always apply in addition to config exclusions.

For a function path, `--threshold` wins when supplied. Otherwise the most
specific matching `thresholds` rule wins; rules compare lexicographically by
literal character count (more wins), wildcard count (fewer wins), then declaration
order (earlier wins an exact tie). If no rule matches, the config `threshold`
applies; if it is absent the default is 8.
Each JSON report row and each human table row includes its applicable threshold,
and the gate evaluates that row's CRAP score against that threshold.

TypeScript and JavaScript configs execute local project code. Only run crap4ts
against repositories whose configuration you trust. TypeScript config loading
uses the package's TypeScript dependency at runtime and executes the transpiled
module in memory with resolution rooted at the config file; the built `dist/cli.js`
never writes generated files into the project. Use `.mjs` for portable ESM and
`.cjs` for portable CommonJS. A `.js` config follows Node's normal module-system
rules from the nearest `package.json` (`type: "module"` for ESM; otherwise
CommonJS), so it is not a universal ESM form.

## Generating coverage for crap4ts

crap4ts reads Istanbul-format coverage JSON, which Vitest's V8 provider emits
as `coverage/coverage-final.json`. Add this to your `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],  // "json" produces coverage-final.json
      include: ["src/**/*.ts"],
    },
  },
});
```

Then run:

```sh
npx vitest run --coverage
npx crap4ts src --coverage coverage/coverage-final.json
```

## How it works

1. **Function discovery** — Parses `.ts`/`.tsx` source with the TypeScript
   compiler API to find named functions, anonymous arrow functions, methods,
   constructors, and accessors. Declaration files (`.d.ts`), `node_modules`,
   `dist`, and `coverage` directories are excluded by default.

2. **Cyclomatic complexity** — Each function starts at CC = 1. The following
   constructs add 1:
   - `if` statements
   - `for`, `for..in`, `for..of` loops
   - `while`, `do..while` loops
   - `catch` clauses
   - `case` clauses (`default` is not counted)
   - Conditional (ternary) expressions `a ? b : c`
   - Short-circuit operators `&&`, `||`, and `??` (nullish coalescing)

   Nested functions are counted as separate entries and do not add to the
   enclosing function's complexity.

3. **Coverage mapping** — Each discovered function is matched to an Istanbul
   file entry by an unambiguous project-relative path match (exact normalized
   path, or anchored suffix where the full source relative path is a suffix of
   the coverage path — basename-only matches are rejected). Within the matched
   file, the function is associated to the fnMap entry whose `loc` is contained
   within the function's line+column range and is the most specific (smallest
   containing loc). This is used only for identity association.

   **Coverage fraction semantics**: Coverage is derived from Istanbul
   `statementMap` / `s` data — the fraction of statements whose ranges are
   owned by the function that were executed at least once. Statement
   ownership is determined per file: each statement's most-specific owning
   source function is found across ALL source functions (exact range
   containment, not a numeric heuristic), and if that owner is matched, the
   statement is credited to it; if the owner is unmatched or ambiguous, the
   statement is excluded entirely — it never falls through to a parent. This
   is `coveredStatements / totalStatements`, a per-function covered fraction
   over a meaningful execution denominator. This mirrors the core invariant of the reference implementations:
   - **Java/JaCoCo**: covered instructions / total instructions per method
   - **Go**: covered coverage statements / total statements in the function
     line range
   - **Clojure**: covered forms / total forms in the function line range

   Partial execution produces `0 < coverage < 1`. An uncovered function (all
   statements have count 0) reports coverage 0. A function with no matching
   coverage entry reports coverage 0 (`matched: false`). A fully executed
   function reports coverage 1. The fnMap boolean hit (`f[id] > 0`) is never
   treated as 100% coverage — it is used only for identity association.

   When a function has no statements in its source range (e.g. a declaration
   with no executable body, or a file entry without `statementMap`/`s` data),
   coverage is 0 with `matched` reflecting whether a fnMap identity was found.

   **Limitation**: Istanbul statement coverage counts a statement as covered
   if it was executed at least once. It does not measure branch-level or
   condition-level coverage within a single statement (e.g. short-circuit
   operators). This is the same granularity as Go's statement coverage and
   is sufficient for the CRAP metric's purpose of measuring execution
   density per function.

4. **CRAP computation** — The formula is applied per function, results are
   sorted by CRAP descending, and any score above the threshold fails the gate.

## CI configuration

This repo runs crap4ts against its own source in GitHub Actions. The workflow:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
      - run: npm ci
      - run: npm run typecheck
      - run: npm run coverage
      - run: npm run build
      - run: npm run self-score
```

The `self-score` script (`scripts/self-score.ts`, run via tsx) runs the CLI
from source against this repo's own `src/` directory using the coverage
generated in the previous step. It asserts that:
1. The CLI exits 2 (threshold exceeded).
2. JSON rows named `parseArgs` and `main` exist in the output.
3. Those rows are unmatched/uncovered (coverage 0) and exceed the threshold.
4. No unexpected functions breach the threshold (unexpected-only breaches
   are rejected).

The breach is expected because `cli.ts` functions (`parseArgs`, `main`)
have high cyclomatic complexity and no direct test coverage (they are
exercised via subprocess in tests, which V8 does not attribute to the
source file). The pure validation logic is in
`src/self-score-helpers.ts` and has unit test coverage via
`test/self-score.test.ts`. On success, its output records the maximum CRAP
score and the exact expected breached rows with each row's name, CRAP score,
coverage, and threshold. The script exits 0 only when the expected breach
occurs and is fully explained; it exits non-zero otherwise.

## Current v1 support and limitations

**Supported:**
- `.ts` and `.tsx` source analysis via the TypeScript compiler API
- Named functions, anonymous arrow functions, methods, constructors, accessors
- Cyclomatic complexity for common branch constructs (see above)
- Vitest V8 coverage (Istanbul `coverage-final.json` format)
- Source-range-based function-to-coverage mapping
- Human-readable and JSON report output
- Configurable threshold with distinct exit codes

**Not included in v1 (deliberately deferred):**
- **Mutation testing / Stryker hardening** — CRAP is a static-complexity +
  coverage gate, not a mutation score. A slow mutation-based hardener is a
  future gate, not part of this release.
- Framework-specific coverage adapters beyond Istanbul/V8 format
- Branch-level coverage granularity (v1 uses Istanbul statement-level coverage)
- Architecture/dependency enforcement
- Agent orchestration or automated refactoring
- Release publishing automation

## Development

Tests, coverage, and self-score run the CLI from source TypeScript via
[tsx](https://github.com/privatenumber/tsx) — no build step is required for
development or CI. `.nvmrc` pins the validated Node 22 runtime to `22.22.3`,
so use `nvm use` (or an equivalent version manager) before installing
dependencies. A freshly cloned checkout can run the CI-equivalent suite with
`npm ci && npm run typecheck && npm run coverage && npm run build && npm run self-score`.
CI deliberately uses `npm run coverage` as its one test execution because it
runs the Vitest suite and produces the coverage artifact consumed by self-score.

```sh
nvm use             # read the validated 22.22.3 runtime from .nvmrc
npm ci              # install dependencies exactly as CI does
npm run typecheck   # tsc --noEmit
npm run coverage    # Vitest test execution used by CI; generates coverage/coverage-final.json
npm run build       # compile to dist/ (for npm publishing)
npm run self-score  # assert expected threshold breach and print audit evidence

# Optional faster local test run when coverage output is not needed:
npm test            # vitest run (CLI tests invoke src/cli.ts via tsx)
```

### Running the CLI from source

```sh
# Run directly from TypeScript source (no build needed)
npx tsx src/cli.ts src --coverage coverage/coverage-final.json

# Or after building for the published bin
npm run build && node dist/cli.js src --coverage coverage/coverage-final.json
```

The `bin` entry and `dist/` output are kept for eventual npm publishing;
development, testing, and CI use the source TypeScript via tsx.

## License

MIT
