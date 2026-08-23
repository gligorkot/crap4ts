import { mkdirSync, writeFileSync } from "node:fs";

const cjsDirectory = new URL("../dist/cjs/", import.meta.url);
mkdirSync(cjsDirectory, { recursive: true });
writeFileSync(new URL("package.json", cjsDirectory), '{"type":"commonjs"}\n');
