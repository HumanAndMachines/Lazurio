import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildLaunchpadServeInvocation,
  runLaunchpadServe,
} from "./launchpad-serve-lib.mjs";

test("serve fasáda deleguje lifecycle Serveru přes --reuse, nikdy přes OS opener", async () => {
  let captured;
  const exitCode = await runLaunchpadServe({
    root: "/Users/colleague/Lazurio",
    organization: "AgentMint",
    codeRoot: "/runtime/lazurio",
    launchServer(invocation) {
      captured = invocation;
      return 37;
    },
  });

  expect(exitCode).toBe(37);
  expect(captured).toEqual({
    serverPath: "/runtime/lazurio/launchpad/src/server.mjs",
    args: [
      "--reuse",
      "--root",
      "/Users/colleague/Lazurio",
      "--agent-entry",
      "--organization",
      "AgentMint",
    ],
    cwd: "/Users/colleague/Lazurio",
  });
  expect(captured.args).not.toContain("--open");
});

test("serve invocation drží root a Personalspace jako vzájemně výlučné request-local scope", () => {
  expect(buildLaunchpadServeInvocation({ root: "/srv/lazurio", codeRoot: "/runtime" }).args)
    .toEqual(["--reuse", "--root", "/srv/lazurio", "--agent-entry"]);
  expect(buildLaunchpadServeInvocation({ root: "/srv/lazurio", personalspace: true, codeRoot: "/runtime" }).args)
    .toEqual(["--reuse", "--root", "/srv/lazurio", "--agent-entry", "--personalspace"]);
  expect(() => buildLaunchpadServeInvocation({
    root: "/srv/lazurio",
    organization: "AgentMint",
    personalspace: true,
  })).toThrow(TypeError);
});

test("CLI parser přijme serve help a odmítne konflikty i JSON", () => {
  const cli = join(import.meta.dirname, "cli.mjs");
  const help = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "serve", "--help"]);
  const conflict = Bun.spawnSync([
    process.execPath, "run", cli, "launchpad", "serve", "--organization", "AgentMint", "--personalspace",
  ]);
  const json = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "serve", "--json"]);

  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("lazurio launchpad serve [--organization <slug> | --personalspace]");
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stderr.toString()).toContain("se vzájemně vylučují");
  expect(json.exitCode).toBe(2);
  expect(json.stderr.toString()).toContain("nepodporuje --json");
});
