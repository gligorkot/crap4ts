import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath } from "../src/path-identity.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) fs.rmSync(tempPath, { recursive: true, force: true });
});

describe("canonicalPath", () => {
  it("gives symlink and physical spellings one filesystem identity", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "crap4ts-path-identity-"));
    tempPaths.push(temp);
    const physical = path.join(temp, "physical");
    const alias = path.join(temp, "alias");
    fs.mkdirSync(physical);
    fs.writeFileSync(path.join(physical, "source.ts"), "export const value = 1;\n");
    fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");

    expect(canonicalPath(path.join(alias, "source.ts"))).toBe(canonicalPath(path.join(physical, "source.ts")));
  });

  it("keeps a resolved path for a missing coverage path", () => {
    const missing = path.join(os.tmpdir(), "crap4ts-path-identity-missing", "source.ts");
    expect(canonicalPath(missing)).toBe(path.resolve(missing));
  });
});
