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
npm install --save-dev @gligor/crap4ts
```

## Usage

```sh
# Analyze src/ with V8 coverage from Vitest, fail if any score > 8
npx crap4ts src --coverage coverage/coverage-final.json --threshold 8

# JSON output for CI tooling
npx crap4ts src --coverage coverage/coverage-final.json --json

# Markdown table for a pull-request/job summary
npx crap4ts src --coverage coverage/coverage-final.json --format markdown
# --markdown is an alias for --format markdown

# Multiple source paths
npx crap4ts src lib --coverage coverage/coverage-final.json
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--coverage <file>` | Path to Istanbul `coverage-final.json` (Vitest V8 output). **Required.** | — |
| `--config <path>` | Load exactly this TS, ESM (`.mjs`), CommonJS (`.cjs`), module-system-dependent JS (`.js`), or JSON configuration file. | auto-discovery |
| `--threshold <number>` | Override every configured CRAP failure threshold; breach when score > threshold. | `8` |
| `--changed-since <git-ref>` | Gate only committed functions changed between `HEAD` and the merge base of this ref and `HEAD`. | off |
| `--format <human\|json\|markdown>` | Select human-readable, JSON, or PR-friendly Markdown table output. | `human` |
| `--markdown` | Alias for `--format markdown`. | off |
| `--json` | Alias for `--format json`. | off |
| `--help` | Print usage and exit. | — |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — no threshold breach. |
| `1` | Invalid arguments or input (no stack trace). |
| `2` | CRAP threshold exceeded. |

## GitHub Action

**Prerequisite:** install this package as a dev dependency in the repository
that uses the Action, and generate coverage, before invoking it. The Action
runs only `node_modules/.bin/crap4ts` from your workspace — it never resolves
global/PATH binaries, never runs `npx`, installs packages, or fetches
anything.

```yaml
- run: npm ci        # installs @gligor/crap4ts from devDependencies
- run: npm run coverage
- uses: gligorkot/crap4ts@v1
  with:
    coverage: coverage/coverage-final.json
    src: src
    threshold: 8
```

If the CLI is not installed (no `node_modules/.bin/crap4ts`), the action fails
immediately with a clear error instead of falling back to any other binary.

The action does not generate coverage, upload artifacts, or comment
on pull requests. It executes the locally installed CLI, writes the Markdown report to
`$GITHUB_STEP_SUMMARY` and exposes `breached-count`, `max-crap`, and `pass`
(`"true"`/`"false"`) outputs. Exit codes: `0` on pass, `2` when the threshold is
breached (outputs and summary are written first either way); any other non-zero exit
propagates unchanged. Dynamic function names and file paths are rendered as escaped
literal code spans so they cannot inject Markdown or HTML into the summary.

## Publishing

Releases are published to npm as `@gligor/crap4ts` by
`.github/workflows/publish.yml`, triggered on push to `main` and via
`workflow_dispatch`. The workflow runs typecheck, tests, and build first,
then publishes **only when the `package.json` version is not already on the
npm registry** — it never bumps versions automatically.

Authentication uses npm **OIDC trusted publishing** (`id-token: write`); no
long-lived `NPM_TOKEN` secret is stored in the repository.

One-time setup required before the first automated publish works:

1. Trusted publishing cannot perform the very first publish of a brand-new
   package name. From a checkout with publish rights to the `@gligor` scope,
   run `npm ci && npm publish --access public`. The package `prepack` hook runs
   the build before packaging, so the initial release cannot omit `dist/`.
2. Then, on npmjs.com, configure the package `@gligor/crap4ts` as a
   **trusted publisher** with Organization/user `gligor`, Repository
   `crap4ts`, Workflow filename `publish.yml` (filename only), and Allowed
   actions `npm publish`. Leave npm's optional "Environment" field blank: this
   workflow declares **no** GitHub Actions environment, so a non-blank
   environment would make OIDC claims mismatch and every publish fail. After
   that, the workflow's trusted-publisher OIDC flow handles all subsequent
   version publishes.

### GitHub Marketplace

This repository can be listed as a GitHub Marketplace Action because `action.yml`
is at the repository root. Its intended reference is `uses: gligorkot/crap4ts@v1`.
Marketplace publication is a one-time GitHub web release flow with browser/2FA
confirmation; GitHub does not support automating it from a workflow. Publish the
scoped npm package first, then create the public `v1` release and select the
Marketplace option. The Marketplace Action still deliberately requires
`@gligor/crap4ts` in the consumer project's dev dependencies; it never
installs or downloads packages at runtime.

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
import { defineConfig } from "@gligor/crap4ts";

export default defineConfig({
  version: 1,
  src: ["src", "packages/api/src"],
  exclude: ["src/generated/**", "**/*.generated.ts"],
  threshold: 8,
  changedSince: "origin/main", // optional default; CLI --changed-since wins
  thresholds: [
    { glob: "src/legacy/**", threshold: 15 },
    { glob: "src/security/**/*.ts", threshold: 4 },
  ],
});
```

```js
// crap4ts.config.mjs — ESM in every project module system
import { defineConfig } from "@gligor/crap4ts";

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
Config paths, globs, and exclusions are relative to the config file's
directory — including for a nested file chosen with `--config`, so the analyzed
sources are always exactly the ones validated against that config's own
directory. The containing project root (the invocation root) still bounds where
the selected config file itself may live. `exclude`
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

Configuration files are declarative and are never executed. crap4ts parses
them statically and accepts only literal config data: arbitrary code,
expressions, references, spreads, computed keys, and calls (other than the
exact `defineConfig({ ... })` wrapper) are rejected as invalid config. Import
declarations in TS/ESM configs are tolerated syntactically but the imported
packages are never resolved or loaded at runtime.

The selected or discovered config file — including through symlinks — must
resolve inside the project root; a `--config` path or symlink that escapes it
is an input error.

TypeScript and JavaScript configs accept exactly these shapes:

- `export default { ... }` (TS, `.mjs`, `.js`)
- `export default defineConfig({ ... })` with an optional import declaration
  for `defineConfig` (the import is never resolved)
- `module.exports = { ... }` (`.cjs`, CommonJS-style `.js`)

All values must be literals (strings, numbers, booleans, arrays, plain
objects). Each extension enforces its module system exactly: `.ts` and `.mjs`
configs accept only the ESM static default-export forms; `.cjs` accepts only
the exact CommonJS form; a `.js` config may deliberately use either form, but
never both. A bare `exports = ...` assignment is rejected in every extension,
ESM exports are rejected in `.cjs`, CommonJS assignments are rejected in
`.ts`/`.mjs`, mixed ESM/CommonJS files are rejected, and a second export is
rejected rather than silently overriding the first. Use `.mjs` for portable ESM
and `.cjs` for portable CommonJS.

## Changed-only gates

Use `--changed-since <git-ref>` (or config `changedSince`) to score only
functions affected by committed changes. The CLI resolves `<git-ref>` to a
commit, calculates `git merge-base <resolved-ref> HEAD`, then compares that
merge base to `HEAD`. This is equivalent to the commit range
`<merge-base>..HEAD`, so it includes all commits on the current branch since it
diverged from the ref; it is not a two-dot comparison of the ref tip to HEAD.
An explicit CLI value always overrides `changedSince` from config.

For each changed `.ts`/`.tsx` file under the selected source paths, crap4ts
parses the **complete current file** and performs normal per-file coverage
ownership mapping before filtering report rows to functions whose inclusive
source line range intersects a changed hunk. Parsing the whole file is
intentional: nested functions and their statements retain the same ownership
rules as a full report. Added files select all their functions. Deleted files
have no current source to score and are ignored. Pure renames and binary/no-hunk
changes select no functions; they never expand to a full-file or full-repository
scan. An edited rename (Git `R<100`) conservatively selects all functions in its
destination file, while only Git `R100` is treated as a pure rename with no
eligible functions. A deletion hunk uses its new-file insertion boundary as its
deterministic line location.

```sh
# Local branch compared with locally available main
npx crap4ts src --coverage coverage/coverage-final.json --changed-since main

# PR CI: checkout/fetch the base commit, then use the PR base SHA
npx crap4ts src --coverage coverage/coverage-final.json \
  --changed-since "$GITHUB_EVENT_PULL_REQUEST_BASE_SHA" --json
```

Changed-only mode appears in human output and adds `filter` metadata to JSON:
`mode`, `changedSince`, resolved `mergeBase`, and `changedFileCount`. If valid
source and coverage inputs yield no eligible changed functions, it reports that
fact explicitly and exits 0; this is not presented as a full-repository passing
report. Invalid Git availability, ref resolution, or merge-base discovery is an
input error (exit 1).

Changed-only selection deliberately considers committed `HEAD` only. To avoid
reading source that differs from that commit, the command rejects staged,
unstaged, or untracked `.ts`/`.tsx` worktree files (exit 1); commit or stash
those files first. Non-TypeScript worktree files do not affect selection.
Generated files remain subject to normal exclusions/config exclusions, so their
changes can yield no eligible rows. Rename detection is used for safe path
handling: an `R100` rename without content changes does not create a CRAP
obligation, while an edited rename is conservatively included.

Roll out deliberately: first run the JSON command as informational CI output,
inspect `filter` metadata and coverage matches, then enable the threshold gate
on PRs once the base ref is reliably fetched and generated-file exclusions are
configured. Do not replace a full-repository gate until that policy decision is
intentional.

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
      - name: CRAP report (threshold 8; diagnostic)
        run: |
          # Append the built CLI's Markdown report to $GITHUB_STEP_SUMMARY.
          # Exit 2 is accepted as the expected outcome of this intentionally
          # informational report; every other nonzero exit fails the job and
          # never publishes a summary.
          node dist/cli.js src --coverage coverage/coverage-final.json --threshold 8 --format markdown
      - run: npm run self-score
```

The CLI's default threshold is **8**. CI publishes the built CLI's
threshold-8 own-source report to the GitHub Job Summary as an intentional,
informational diagnostic: it is visible on every run and does not fail the job
on its expected exit code 2. The **enforced** own-source threshold-8 gate is
the `self-score` script described below.

The `self-score` script (`scripts/self-score.ts`, run via tsx) runs the
real source CLI (`tsx src/cli.ts`) against this repo's own `src/` directory
using the fresh coverage generated in the previous step, at `--threshold 8
--json`. It is the repository's honest own-source gate: it fails closed on
missing or stale coverage, on uninterpretable CLI results, or on any report
it cannot prove is a structurally valid, summary-consistent, own-source
result of the current tree, and then passes (exit 0) only when **zero rows
have a CRAP score strictly above their applicable threshold (threshold 8)**
— the breach counts are recomputed from the rows, never trusted from the
summary. On success it prints an audit block with the function count,
coverage-matched count, maximum CRAP, and the breached-row count (0). Any
other outcome — including any breached row — exits 1.

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
- Automatic release version bumping (publishing exists, but versions are always bumped manually)

## Development

Tests, coverage, and self-score run the CLI from source TypeScript via
[tsx](https://github.com/privatenumber/tsx) — no build step is required for
development or CI. `.nvmrc` is the source of truth for the validated Node 22
runtime, so use `nvm use` (or an equivalent version manager) before installing
dependencies. A freshly cloned checkout can run the CI-equivalent suite with
`npm ci && npm run typecheck && npm run coverage && npm run build && npm run self-score`.
CI deliberately uses `npm run coverage` as its one test execution because it
runs the Vitest suite and produces the coverage artifact consumed by self-score.

```sh
nvm use             # read the validated runtime from .nvmrc
npm ci              # install dependencies exactly as CI does
npm run typecheck   # tsc --noEmit
npm run coverage    # Vitest test execution used by CI; generates coverage/coverage-final.json
npm run build       # compile to dist/ (for npm publishing)
npm run self-score  # pass only when zero own-source rows strictly exceed threshold 8, and print audit evidence

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
