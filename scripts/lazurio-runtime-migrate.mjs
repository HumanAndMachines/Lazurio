#!/usr/bin/env bun

export * from "../lazurio/module-setup-lib.mjs";

import { runRuntimeMigrationCli } from "../lazurio/module-setup-lib.mjs";

if (import.meta.main) await runRuntimeMigrationCli(process.argv.slice(2));
