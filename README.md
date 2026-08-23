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
| `--threshold <number>` | CRAP failure threshold; breach when score > threshold. | `8` |
| `--json` | Output JSON report instead of human-readable table. | off |
| `--help` | Print usage and exit. | — |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — no threshold breach. |
| `1` | Invalid arguments or input (no stack trace). |
| `2` | CRAP threshold exceeded. |

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
   `fnMap` entry by source line range overlap. A function with no coverage
   entry reports coverage `0` (it is never dropped from the report).
   Coverage is treated as boolean: execution count > 0 = covered (1), else
   uncovered (0).

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
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run coverage
      - run: npm run self-score
```

The `self-score` script builds the CLI and runs it against this repo's own
`src/` directory using the coverage generated in the previous step. The
initial threshold is deliberately permissive while the codebase matures.

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
- Branch-level coverage granularity (v1 uses function-level boolean coverage)
- Configuration files (`.crap4tsrc`); all config is via CLI flags
- Architecture/dependency enforcement
- Agent orchestration or automated refactoring
- Release publishing automation

## Development

```sh
npm install          # install dependencies
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run coverage     # vitest run --coverage
npm run build        # compile to dist/
npm run self-score   # build + run CLI against this repo's own source
```

## License

MIT
