#!/usr/bin/env bun

export {
  allocateModulePort,
  readAllModuleContracts,
} from "../lazurio/module-port-lib.mjs";

import { runModulePortCli } from "../lazurio/module-port-lib.mjs";

if (import.meta.main) await runModulePortCli(process.argv.slice(2));
