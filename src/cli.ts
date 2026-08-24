#!/usr/bin/env node
/**
 * crap4ts CLI entry point.
 *
 * Deliberately thin: process-level bindings only — argv, cwd, the real
 * output surface, and the top-level unexpected-error guard. The run itself
 * is the directly testable pipeline in src/cli-helpers.ts
 * ({@link runCliPipeline}); every output byte and exit code is produced
 * there, so this file carries no orchestration of its own.
 */
import { loadConfig } from "./config.js";
import {
  defaultCliIo,
  effectiveDefaultThreshold,
  parseArgsOrExit,
  runCliPipeline,
} from "./cli-helpers.js";
import type { CliRunContext } from "./cli-helpers.js";
import { EXIT_INVALID_INPUT } from "./crap.js";

const io = defaultCliIo();

/**
 * Run one CLI invocation: parse args, load the config, compute the effective
 * default threshold, and run the full analysis pipeline (including the
 * changed-only git phase). Unexpected failures from the pipeline (git,
 * config, filesystem) are mapped by the top-level guard to the historical
 * `Error: <message>` line and exit 1.
 */
async function main(): Promise<void> {
  const args = parseArgsOrExit(process.argv, io);
  const cwd = process.cwd();
  const loaded = await loadConfig(cwd, args.configPath);
  const context: CliRunContext = {
    args,
    loaded,
    defaultThreshold: effectiveDefaultThreshold(args, loaded),
  };
  runCliPipeline(context, io, cwd);
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${(error as Error).message}\n`);
  process.exit(EXIT_INVALID_INPUT);
});
