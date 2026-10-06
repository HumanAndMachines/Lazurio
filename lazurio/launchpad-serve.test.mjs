import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

import {
  LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE,
  buildLaunchpadServeInvocation,
  runLaunchpadServe,
} from "./launchpad-serve-lib.mjs";

test("serve fasáda deleguje lifecycle Serveru přes --reuse, nikdy přes OS opener", async () => {
  let captured;
  const exitCode = await runLaunchpadServe({
    root: "/Users/colleague/Lazurio",
    organization: "AgentMint",
    codeRoot: "/runtime/lazurio",
    inspectServerPath: (serverPath) => serverPath === resolve("/runtime/lazurio", "launchpad/src/server.mjs"),
    launchServer(invocation) {
      captured = invocation;
      return 37;
    },
  });

  expect(exitCode).toBe(37);
  expect(captured).toEqual({
    serverPath: resolve("/runtime/lazurio", "launchpad/src/server.mjs"),
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
  expect(buildLaunchpadServeInvocation({ root: "/srv/lazurio", codeRoot: "/verified/runtime" })).toMatchObject({
    serverPath: resolve("/verified/runtime", "launchpad/src/server.mjs"),
    args: ["--reuse", "--root", "/srv/lazurio", "--agent-entry"],
  });
  expect(buildLaunchpadServeInvocation({ root: "/srv/lazurio", personalspace: true, codeRoot: "/runtime" }).args)
    .toEqual(["--reuse", "--root", "/srv/lazurio", "--agent-entry", "--personalspace"]);
  expect(() => buildLaunchpadServeInvocation({
    root: "/srv/lazurio",
    organization: "AgentMint",
    personalspace: true,
  })).toThrow(TypeError);
  expect(() => buildLaunchpadServeInvocation({
    root: "/srv/lazurio",
    organization: "../OtherOrg",
  })).toThrow(TypeError);
});

test("package code origin bez Serveru failne před spawnem místo fallbacku na operated Root", async () => {
  let launched = false;
  const error = await runLaunchpadServe({
    root: "/Users/colleague/Lazurio",
    codeRoot: "/npm/global/node_modules/@lazurio/runtime",
    inspectServerPath: () => false,
    launchServer() {
      launched = true;
      return 0;
    },
  }).catch((failure) => failure);

  expect(error).toMatchObject({
    code: LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE,
    serverPath: resolve(
      "/npm/global/node_modules/@lazurio/runtime",
      "launchpad/src/server.mjs",
    ),
  });
  expect(error.message).not.toContain("/Users/colleague/Lazurio/launchpad");
  expect(launched).toBe(false);
});

test("CLI parser přijme serve help a odmítne konflikty i JSON", () => {
  const cli = join(import.meta.dirname, "cli.mjs");
  const help = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "serve", "--help"]);
  const conflict = Bun.spawnSync([
    process.execPath, "run", cli, "launchpad", "serve", "--organization", "AgentMint", "--personalspace",
  ]);
  const json = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "serve", "--json"]);
  const unsafe = Bun.spawnSync([
    process.execPath, "run", cli, "launchpad", "serve", "--organization", "../OtherOrg",
  ]);

  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("lazurio launchpad serve [--organization <slug> | --personalspace]");
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stderr.toString()).toContain("se vzájemně vylučují");
  expect(json.exitCode).toBe(2);
  expect(json.stderr.toString()).toContain("nepodporuje --json");
  expect(unsafe.exitCode).toBe(2);
  expect(unsafe.stderr.toString()).toContain("Organization slug is required");
  expect(unsafe.stderr.toString()).not.toContain("at organizationHash");
});
