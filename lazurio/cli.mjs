#!/usr/bin/env bun

// The `lazurio` command (package.json#bin): it runs the CLI of cli-main.mjs on
// Lazurio's exact Bun (decision 0134 with its addendum of 2026-10-24), in this
// process or re-executed on it (runtime/cli-runtime-lib.mjs). Nothing of the
// CLI is imported up front: ESM evaluates every static import before a line
// here runs, and a re-executed CLI needs none of it in this process.
import { fileURLToPath } from "node:url";

import { runLazurioCli } from "./runtime/cli-runtime-lib.mjs";

if (import.meta.main) {
  await runLazurioCli({
    argv: Bun.argv.slice(2),
    packageRoot: import.meta.dirname,
    mainPath: fileURLToPath(new URL("./cli-main.mjs", import.meta.url)),
    loadMain: async () => (await import("./cli-main.mjs")).main,
  });
}
