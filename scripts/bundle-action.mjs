/**
 * Bundle the CLI and its runtime dependencies into a single self-contained
 * CommonJS file for the composite GitHub Action (action/action.cjs).
 *
 * The action must run from a bare Git checkout at the published tag with no
 * node_modules, so the bundle inlines everything (including the TypeScript
 * compiler used for per-file config loading).
 */
import { build } from "esbuild";
import { stat } from "node:fs/promises";

const outfile = "action/action.cjs";
const summaryOutfile = "action/summary.cjs";
const targets = /** @type {const} */ ([
  ["src/cli.ts", outfile],
  ["src/summary.ts", summaryOutfile],
]);
for (const [entry, out] of targets) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: out,
    sourcemap: false,
    minify: false,
    legalComments: "none",
  });
  const info = await stat(out);
  process.stdout.write(`Bundled ${out} (${info.size} bytes)\n`);
}
