/** Filesystem path identity helpers.
 *
 * macOS exposes `/var` through a `/private/var` symlink. Git may report the
 * physical spelling while Node callers retain the logical spelling, so plain
 * path.resolve() is insufficient when matching source, coverage, and Git paths.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Return the canonical absolute spelling for an existing path, or a resolved
 * absolute path when it does not exist. The fallback preserves diagnostics and
 * coverage suffix matching for paths reported from another machine.
 */
export function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
