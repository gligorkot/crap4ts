# Changelog

## 1.1.0

### Added: compact Markdown reports

Markdown reports are now compact by default: they retain the heading, changed-only
filter metadata, and summary while omitting per-function rows. Pass `--with-table`
to the CLI to include the existing GFM table. The GitHub Action behaves the same
way; set its `with-table` input to `"true"` to include rows in the job summary.
JSON and human output are unchanged.

## 1.0.1

### Fixed: summary-first Markdown report

In the GitHub Action job summary (and `--format markdown` output), the
summary line (Threshold / Functions / Max CRAP / Breached / Gate) is now
rendered before the functions table, so the table is the final content for
non-empty reports. Empty-report output is unchanged.

## 1.0.0

### Breaking: static declarative configuration only

Executable configuration was deliberately replaced by a static declarative
subset in 1.0.0 (introduced in `0.2.x` and now the only supported form).
crap4ts **never executes configuration files**; it parses them statically and
accepts only literal config data.

No longer supported in any config file:

- Config code execution or evaluation
- Import resolution — import declarations are tolerated syntactically, but the
  imported packages are never resolved or loaded at runtime
- Helper expressions beyond the exact `defineConfig({ ... })` wrapper call
- Spreads, computed keys, template literals with substitutions, function calls,
  references to variables, or any other non-literal expression

Accepted TypeScript/JavaScript config shapes:

- `export default { ... }` (`crap4ts.config.ts`, `.mjs`, module-system `.js`)
- `export default defineConfig({ ... })` with an optional (never-resolved)
  import declaration for `defineConfig` from `@gligor/crap4ts`
- `module.exports = { ... }` (`crap4ts.config.cjs`, CommonJS-style `.js`)

All values must be literals: strings, numbers, booleans, arrays, and plain
objects. Each extension enforces its module system exactly (`.ts`/`.mjs` accept
only ESM static forms; `.cjs` accepts only the CommonJS form; `.js` accepts
either but never both). JSON configs (`.crap4tsrc.json`) were already literal
and are unchanged.

### Migrating to 1.0.0

Replace computed values with literals directly in the config file:

```ts
// Before (no longer supported)
import { thresholdsFromEnv } from "./lib/crap-thresholds";

export default defineConfig({
  version: 1,
  src: process.env.CRAP_SRC ?? "src",
  threshold: thresholdsFromEnv(),
});

// After (1.0.0)
import { defineConfig } from "@gligor/crap4ts";

export default defineConfig({
  version: 1,
  src: ["src"],
  threshold: 8,
});
```

Generate per-environment values outside crap4ts (a script that writes a JSON
config, or explicit CLI flags such as `--threshold`) instead of computing them
inside the config file. See README's [Configuration](./README.md#configuration)
section for the full accepted grammar.
