#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runLazurioUpdate } from "./lazurio-update-lib.mjs";

const options = parseArgs(Bun.argv.slice(2));
const organizations = options.organizationsFile
  ? JSON.parse(await readFile(resolve(options.organizationsFile), "utf8"))
  : null;
const result = await runLazurioUpdate({
  rootPath: resolve(options.root),
  runtimeRoot: resolve(options.runtimeRoot),
  organizations,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--root", "--runtime-root", "--organizations-file"].includes(key)) {
      throw new Error(`lazurio update runtime does not support ${key ?? "an empty argument"}`);
    }
    if (!value) throw new Error(`${key} requires a value`);
    if (key === "--root") values.root = value;
    if (key === "--runtime-root") values.runtimeRoot = value;
    if (key === "--organizations-file") values.organizationsFile = value;
  }
  if (!values.root || !values.runtimeRoot) throw new Error("lazurio update runtime arguments are incomplete");
  return values;
}
