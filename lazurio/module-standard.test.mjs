import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { moduleSetupExitCode, setupModule } from "./module-setup-lib.mjs";
import {
  MODULE_STANDARD_CHECKS,
  devScriptFindings,
  evaluateModuleStandard,
  legacyRuntimeReads,
} from "./module-standard-lib.mjs";
import { readRequiredBunVersion } from "./core/toolchain-lib.mjs";
import { validateAgainstSchema } from "./runtime/json-schema-mini.mjs";

const roots = [];
const cliPath = join(import.meta.dirname, "cli.mjs");
const reportSchema = await Bun.file(join(import.meta.dirname, "module-setup-report.v1.schema.json")).json();
const bunVersion = readRequiredBunVersion();

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("a conformant Module is current with exactly the thirteen passing checks", async () => {
  const fixture = await conformantFixture();

  const report = await setupModule(fixture);

  expect(report).toMatchObject({ status: "current", reason: "module_contract_current", changes: [], issues: [] });
  expect(report.standard.checks.map((check) => check.id)).toEqual(MODULE_STANDARD_CHECKS.map((check) => check.id));
  expect(report.standard.checks.map((check) => check.id)).toEqual([
    "MS-01", "MS-02", "MS-03", "MS-04", "MS-05", "MS-06", "MS-07",
    "MS-08", "MS-09", "MS-10", "MS-11", "MS-12", "MS-13",
  ]);
  expect(report.standard.checks.every((check) => check.status === "pass")).toBe(true);
  expect(report.standard.checks.every((check) => check.summary.length > 0 && check.action === undefined)).toBe(true);
  expect(report.runtime.apps[0].package).toBe("app/v1/package.json");
  expect(validateAgainstSchema(report, reportSchema, "module-setup")).toEqual([]);
  expect(moduleSetupExitCode(report)).toBe(0);

  const cli = Bun.spawnSync([
    process.execPath, "run", cliPath, "module", "setup", fixture.moduleRoot, "--json", "--root", fixture.lazurioRoot,
  ], { cwd: fixture.lazurioRoot, stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout.toString()).standard.checks).toHaveLength(13);
});

test("MS-01 reports an out-of-pool lease with the lowest free pool port and never moves it", async () => {
  const fixture = await conformantFixture({ port: 23_500 });
  await addNeighbourModule(fixture, { module: "neighbour", port: 24_000 });
  const manifestPath = join(fixture.moduleRoot, "lazurio.module.json");

  for (const apply of [false, true]) {
    const report = await setupModule({ ...fixture, apply });
    expect(report).toMatchObject({ status: "action_required", reason: "module_standard_nonconformant", changes: [] });
    expect(check(report, "MS-01").details).toEqual([
      "lease main 23500 leží mimo pool 24000-24099; volný port poolu: 24001",
    ]);
    expect(check(report, "MS-01").repairs).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toEqual(["MS-01"]);
    expect((await readJson(manifestPath)).port_leases[0].port).toBe(23_500);
  }

  // The move is one manifest edit made by the Agent in the Module PR.
  const manifest = await readJson(manifestPath);
  manifest.port_leases[0].port = 24_001;
  await writeJsonFile(manifestPath, manifest);
  expect((await setupModule(fixture)).status).toBe("current");
});

test("MS-01 names an exhausted pool instead of a free port", async () => {
  const fixture = await conformantFixture({ port: 23_501, pool: { start: 24_000, end: 24_000 } });
  await addNeighbourModule(fixture, { module: "neighbour", port: 24_000 });

  expect(check(await setupModule(fixture), "MS-01").details).toEqual([
    "lease main 23501 leží mimo pool 24000-24000; pool je vyčerpaný",
  ]);
});

test("MS-01 warns without an Organization pool and fails on overlapping pools or foreign leases", async () => {
  const withoutPool = await conformantFixture({ pool: null });
  // The Module contract already blocks a lease without a pool; the standard
  // itself treats the missing pool as undecidable, never as pass.
  expect(await setupModule(withoutPool)).toMatchObject({
    status: "action_required",
    reason: "module_port_policy_invalid",
    standard: null,
  });
  const undecided = await evaluateModuleStandard({
    moduleRoot: withoutPool.moduleRoot,
    slotPath: "workspace/portal",
    manifest: await readJson(join(withoutPool.moduleRoot, "lazurio.module.json")),
    packages: new Map([["app/v1/package.json", await readJson(join(withoutPool.appRoot, "package.json"))]]),
    organization: { slug: "Acme", module_port_pool: null },
    organizations: [{ slug: "Acme", module_port_pool: null }],
    modules: [],
  });
  expect(undecided.checks.find((item) => item.id === "MS-01")).toMatchObject({
    status: "warn",
    details: ["Acme nemá module_port_pool; lease nelze posoudit"],
  });

  const overlapping = await conformantFixture();
  await addOrganization(overlapping, { slug: "Beta", pool: { start: 24_050, end: 24_149 }, module: "shop", port: 24_010 });
  const report = await setupModule(overlapping);
  expect(check(report, "MS-01").status).toBe("fail");
  expect(check(report, "MS-01").details).toEqual(expect.arrayContaining([
    "pool 24000-24099 se překrývá s Beta na 24050-24099",
    "port 24010 drží i Beta/shop",
  ]));
});

test("MS-02 adds a missing packageManager but only reports wrong versions and lockfile problems", async () => {
  const missing = await conformantFixture({ mutatePackage: (pkg) => { delete pkg.packageManager; } });
  const applied = await setupModule({ ...missing, apply: true });
  expect(applied.status).toBe("completed");
  const written = await readJson(join(missing.appRoot, "package.json"));
  expect(written.packageManager).toBe(`bun@${bunVersion}`);
  expect(Object.keys(written).indexOf("packageManager")).toBe(Object.keys(written).indexOf("type") + 1);

  const wrong = await conformantFixture({ mutatePackage: (pkg) => { pkg.packageManager = "bun@1.0.0"; } });
  const wrongReport = await setupModule({ ...wrong, apply: true });
  expect(wrongReport).toMatchObject({ status: "action_required", changes: [] });
  expect(check(wrongReport, "MS-02").details).toEqual([
    `app/v1/package.json: packageManager bun@1.0.0 neodpovídá bun@${bunVersion}`,
  ]);

  const stale = await conformantFixture({ mutatePackage: (pkg) => { pkg.dependencies.zod = "^4.0.0"; } });
  expect(check(await setupModule(stale), "MS-02").details).toEqual([
    "app/v1/package.json: app/v1/bun.lock není čerstvý (dependencies.zod chybí v lockfilu)",
  ]);

  const uncommitted = await conformantFixture({ git: "without-lock" });
  expect(check(await setupModule(uncommitted), "MS-02").details).toEqual([
    "app/v1/package.json: app/v1/bun.lock není commitnutý",
  ]);

  const notGit = await conformantFixture({ git: false });
  expect(check(await setupModule(notGit), "MS-02")).toMatchObject({ status: "warn" });
});

test("MS-04 adds the preparation skeleton only when it is unambiguous", async () => {
  const withCheck = await conformantFixture({ mutatePackage: (pkg) => { delete pkg.lazurio.preparation; } });
  const applied = await setupModule({ ...withCheck, apply: true });
  expect(applied.status).toBe("completed");
  expect((await readJson(join(withCheck.appRoot, "package.json"))).lazurio.preparation).toEqual({
    schema_version: "lazurio.preparation.v1",
    owner_package: "app/v1/package.json",
    check_script: "check:prepared",
  });

  const explicitBun = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.preparation.runtime = "bun"; },
  });
  const explicitPlan = await setupModule(explicitBun);
  expect(explicitPlan).toMatchObject({ status: "actionable", reason: "standard_repairs_ready" });
  expect(check(explicitPlan, "MS-04")).toMatchObject({
    status: "fail",
    details: [
      "app/v1/package.json: runtime: bun zapsané explicitně — Platforma dnes neznámá pole odmítá; klíč vynech (chybí = bun)",
    ],
    repairs: ["app/v1/package.json: odebrat lazurio.preparation.runtime (chybí = bun)"],
  });
  const explicitApplied = await setupModule({ ...explicitBun, apply: true });
  expect(explicitApplied.status).toBe("completed");
  expect((await readJson(join(explicitBun.appRoot, "package.json"))).lazurio.preparation).toEqual({
    schema_version: "lazurio.preparation.v1",
    owner_package: "app/v1/package.json",
    check_script: "check:prepared",
  });

  const withoutCheck = await conformantFixture({
    mutatePackage: (pkg) => {
      delete pkg.lazurio.preparation;
      delete pkg.scripts["check:prepared"];
    },
  });
  const partial = await setupModule({ ...withoutCheck, apply: true });
  expect(partial).toMatchObject({ status: "action_required" });
  expect(partial.changes).toHaveLength(1);
  expect((await readJson(join(withoutCheck.appRoot, "package.json"))).lazurio.preparation.check_script).toBeUndefined();
  expect(check(partial, "MS-04").details).toEqual([
    "app/v1/package.json: lazurio.preparation: chybí povinné pole 'check_script'",
  ]);

  const pythonWarning = "app/v1/package.json: Python App: čtení [tool.lazurio] z pyproject.toml zatím není v Core; ověř přípravu ručně";
  const python = await conformantFixture({ mutatePackage: (pkg) => { delete pkg.lazurio.preparation; } });
  await writeText(join(python.appRoot, "pyproject.toml"), "[project]\nname = \"portal\"\n");
  const undecided = await setupModule({ ...python, apply: true });
  expect(undecided.changes).toEqual([]);
  expect(check(undecided, "MS-04")).toMatchObject({ status: "warn", details: [pythonWarning] });

  const uvWithoutVersion = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.preparation.runtime = "uv"; },
  });
  expect(check(await setupModule(uvWithoutVersion), "MS-04")).toMatchObject({
    status: "fail",
    details: [pythonWarning, "app/v1/package.json: lazurio.preparation: chybí povinné pole 'uv_version'"],
  });
  const uvWithVersion = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.lazurio.preparation.runtime = "uv";
      pkg.lazurio.preparation.uv_version = "0.8.4";
    },
  });
  expect(check(await setupModule(uvWithVersion), "MS-04")).toMatchObject({ status: "warn", details: [pythonWarning] });

  const lifecycle = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.prepare = "vite build";
      pkg.scripts.postinstall = "bun run src/check-prepared.ts";
      pkg.lazurio.preparation.prepare_script = "prepare";
      pkg.lazurio.preparation.check_script = "postinstall";
    },
  });
  expect(check(await setupModule({ ...lifecycle, apply: true }), "MS-04")).toMatchObject({
    status: "fail",
    details: [
      "app/v1/package.json: postinstall je npm lifecycle jméno — bun install ho spouští sám; použij prepare:app / check:prepared",
      "app/v1/package.json: prepare je npm lifecycle jméno — bun install ho spouští sám; použij prepare:app / check:prepared",
    ],
  });
  expect((await readJson(join(lifecycle.appRoot, "package.json"))).lazurio.preparation.check_script).toBe("postinstall");

  const grammar = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts["check prepared"] = "bun run src/check-prepared.ts";
      pkg.scripts["1prepare"] = "vite build";
      pkg.lazurio.preparation.check_script = "check prepared";
      pkg.lazurio.preparation.prepare_script = "1prepare";
    },
  });
  const grammarReport = await setupModule({ ...grammar, apply: true });
  expect(grammarReport.changes).toEqual([]);
  expect(check(grammarReport, "MS-04")).toMatchObject({
    status: "fail",
    details: [
      "app/v1/package.json: check prepared: jméno skriptu neodpovídá gramatice čtečky Platformy ^[A-Za-z][A-Za-z0-9:_-]*$",
      "app/v1/package.json: 1prepare: jméno skriptu neodpovídá gramatice čtečky Platformy ^[A-Za-z][A-Za-z0-9:_-]*$",
    ],
  });

  const broken = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.lazurio.preparation.runtime = "deno";
      pkg.lazurio.preparation.check_script = "missing";
    },
  });
  const brokenCheck = check(await setupModule(broken), "MS-04");
  expect(brokenCheck.status).toBe("fail");
  expect(brokenCheck.details.join("\n")).toContain("deno");
  expect(brokenCheck.details).toContain("app/v1/package.json: check_script missing neexistuje v app/v1/package.json");
});

test("MS-05 flags every non-single-process dev shape and accepts the standard shapes", () => {
  for (const [command, finding] of [
    ["bun run build && bun run src/server.ts", "&&"],
    ["bun src/a.ts; bun src/b.ts", ";"],
    ["bun src/server.ts | tee log", "|"],
    ["bun src/server.ts || true", "||"],
    ["concurrently \"vite\" \"bun api.ts\"", "concurrently"],
    ["npm-run-all --parallel web api", "npm-run-all"],
    ["vite build --watch", "build"],
    ["npx vite", "npx"],
    ["node server.js", "node"],
    ["bunx vite", "bunx"],
    ["bun x vite", "bun x"],
    ["nvm use && vite", "nvm"],
    ["NODE_ENV=development bun src/server.ts", "inline VAR="],
    ["bun src/worker.ts & bun src/server.ts", "& (proces na pozadí)"],
  ]) {
    expect(devScriptFindings(command)).toContain(finding);
  }
  for (const command of [
    "bun run src/server.ts",
    "bun ./node_modules/vite/bin/vite.js --host \"$LAZURIO_RUNTIME_LISTENER_APP_HOST\" --port \"$LAZURIO_RUNTIME_LISTENER_APP_PORT\" --strictPort",
    "astro dev",
  ]) {
    expect(devScriptFindings(command)).toEqual([]);
  }
});

test("MS-05 follows the dev script chain in a real Module", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun run serve";
      pkg.scripts.serve = "bun run build && bun run src/server.ts";
      pkg.scripts.build = "vite build";
    },
  });
  expect(check(await setupModule(fixture), "MS-05")).toMatchObject({ status: "fail" });
});

test("MS-06 finds legacy host/port authority in App sources but not in tests", async () => {
  expect(legacyRuntimeReads("const port = Number(process.env.PORT)")).toEqual(["process.env.PORT"]);
  expect(legacyRuntimeReads("Bun.env[\"PORT\"]; process.env.LAZURIO_RUNTIME_HOST")).toEqual([
    "LAZURIO_RUNTIME_HOST",
    "Bun.env.PORT",
  ]);
  expect(legacyRuntimeReads("process.env.COMPANYASCODE_APP_PORT; readFile('lazurio.module.json')")).toEqual([
    "COMPANYASCODE_*",
    "lazurio.module.json (lease soubor)",
  ]);
  expect(legacyRuntimeReads("process.env.LAZURIO_RUNTIME_LISTENER_APP_PORT")).toEqual([]);

  const fixture = await conformantFixture();
  await writeText(join(fixture.appRoot, "src", "legacy.ts"), "export const port = process.env.LAZURIO_RUNTIME_PORT;\n");
  await writeText(join(fixture.appRoot, "src", "server.test.ts"), "process.env.PORT = '1';\n");
  expect(check(await setupModule(fixture), "MS-06").details).toEqual([
    "app/v1/src/legacy.ts: čte LAZURIO_RUNTIME_PORT",
  ]);
});

test("MS-06 fails when the lease port is hardcoded in an App source", async () => {
  const fixture = await conformantFixture({ port: 24_010 });
  await writeText(join(fixture.appRoot, "src", "config.ts"), "export const fallbackPort = 24010;\n");
  await writeText(join(fixture.appRoot, "src", "other.ts"), "export const unrelated = 124010; export const ratio = 0.24010;\n");
  await writeText(join(fixture.appRoot, "src", "server.test.ts"), "const port = 24010;\n");

  const report = await setupModule(fixture);

  expect(report.status).toBe("action_required");
  expect(check(report, "MS-06").details).toEqual([
    "app/v1/src/config.ts: port leasu 24010 je zapsaný natvrdo",
  ]);
});

test("MS-07 rejects .env files on the start path and dotenv", async () => {
  const fixture = await conformantFixture({ mutatePackage: (pkg) => { pkg.dependencies.dotenv = "^16.0.0"; } });
  await writeText(join(fixture.appRoot, ".env.local"), "SECRET=1\n");
  await writeText(join(fixture.appRoot, ".env.example"), "SECRET=\n");
  await writeText(join(fixture.appRoot, "src", "env.ts"), "import \"dotenv/config\";\n");
  expect(check(await setupModule(fixture), "MS-07").details).toEqual([
    "app/v1/src/env.ts: importuje dotenv",
    "app/v1/.env.local: soubor .env.local na start cestě",
    "app/v1/package.json: závislost dotenv",
  ]);
});

test("MS-08 requires TypeScript strict and no JavaScript sources outside public/", async () => {
  const preset = await conformantFixture({ tsconfig: { extends: "astro/tsconfigs/strict" } });
  await writeText(join(preset.appRoot, "public", "legacy-widget.js"), "window.x = 1;\n");
  expect(check(await setupModule(preset), "MS-08").status).toBe("pass");

  const loose = await conformantFixture({ tsconfig: { compilerOptions: { strict: false, allowJs: true } } });
  await writeText(join(loose.appRoot, "vite.config.mjs"), "export default {};\n");
  expect(check(await setupModule(loose), "MS-08").details).toEqual([
    "app/v1/package.json: app/v1/tsconfig.json povoluje allowJs",
    "app/v1/vite.config.mjs: JavaScript zdroj",
  ]);

  const unknownPreset = await conformantFixture({ tsconfig: { extends: "@acme/tsconfig/base.json" } });
  expect(check(await setupModule(unknownPreset), "MS-08")).toMatchObject({ status: "warn" });

  const relative = await conformantFixture({ tsconfig: { extends: "./tsconfig.base.json" } });
  await writeText(join(relative.appRoot, "tsconfig.base.json"), "{\n  // shared\n  \"compilerOptions\": { \"strict\": true, },\n}\n");
  expect(check(await setupModule(relative), "MS-08").status).toBe("pass");
});

test("MS-09 rejects symlinks that lead outside the Module repository, tracked as fail and untracked as warn", async () => {
  const fixture = await conformantFixture();
  const outside = join(fixture.organizationRoot, "launchpad", "contracts");
  await mkdir(outside, { recursive: true });
  await writeText(join(outside, "index.ts"), "export const x = 1;\n");
  await symlink(outside, join(fixture.appRoot, "src", "contracts"));
  await symlink(join(fixture.appRoot, "src", "local.ts"), join(fixture.appRoot, "src", "alias.ts"));
  await writeText(join(fixture.appRoot, "src", "shared.ts"), "import { x } from \"./contracts/index.ts\";\nexport { x };\n");
  runGit(fixture.moduleRoot, ["add", "."]);

  expect(check(await setupModule(fixture), "MS-09")).toMatchObject({
    status: "fail",
    details: ["app/v1/src/contracts: symlink vede mimo repo Modulu (" + outside + ")"],
  });

  const untracked = await conformantFixture();
  await symlink(join(untracked.lazurioRoot, "elsewhere"), join(untracked.moduleRoot, "db"));
  expect(check(await setupModule(untracked), "MS-09")).toMatchObject({
    status: "warn",
    details: ["db: symlink míří na neexistující cíl mimo repo (" + join(untracked.lazurioRoot, "elsewhere") + ")"],
  });
});

test("MS-09 rejects imports and file dependencies outside the Module repository", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => { pkg.dependencies.contracts = "file:../../../../launchpad/contracts"; },
  });
  await writeText(
    join(fixture.appRoot, "src", "shared.ts"),
    "import { x } from \"../../../../launchpad/contracts/v1/index.ts\";\nimport { y } from \"../../../../deals/app/v1/src/y.ts\";\nimport { z } from \"./local.ts\";\nexport { x, y, z };\n",
  );
  expect(check(await setupModule(fixture), "MS-09").details).toEqual([
    "app/v1/src/shared.ts: import ../../../../launchpad/contracts/v1/index.ts míří mimo repo Modulu do launchpad/",
    "app/v1/src/shared.ts: import ../../../../deals/app/v1/src/y.ts míří mimo repo Modulu",
    "app/v1/package.json: závislost contracts ukazuje mimo repo (file:../../../../launchpad/contracts)",
  ]);
});

test("MS-10 requires released tags for repository-db and module-kit", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.dependencies["@lazurio/repository-db"] = "github:Lazurio/repository-db#3f2c1a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
      pkg.dependencies["@lazurio/module-kit"] = "github:Lazurio/module-kit#main";
    },
  });
  expect(check(await setupModule(fixture), "MS-10").details).toEqual([
    "app/v1/package.json: @lazurio/module-kit@github:Lazurio/module-kit#main není github:Lazurio/<repo>#v<semver>",
    "app/v1/package.json: @lazurio/repository-db@github:Lazurio/repository-db#3f2c1a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 není github:Lazurio/<repo>#v<semver>",
  ]);
});

test("MS-11 rejects machine paths, start-time symlinks and the modules/ layout", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun run src/server.ts";
      pkg.scripts["dev:link"] = "ln -s ../data data";
    },
  });
  await writeText(join(fixture.appRoot, "src", "paths.ts"), "export const root = \"/Users/someone/Lazurio/data\";\n");
  await writeText(
    join(fixture.appRoot, "src", "server.ts"),
    "import { symlinkSync } from \"node:fs\";\nsymlinkSync(\"a\", \"b\");\nexport {};\n",
  );
  expect(check(await setupModule(fixture), "MS-11").details).toEqual([
    "app/v1/src/paths.ts: absolutní cesta /Users/someone/Lazurio/data",
    "app/v1/src/server.ts: start entrypoint vytváří symlink",
  ]);

  const layout = await evaluateModuleStandard({
    moduleRoot: fixture.moduleRoot,
    slotPath: "modules/portal",
    manifest: await readJson(join(fixture.moduleRoot, "lazurio.module.json")),
    packages: new Map([["app/v1/package.json", await readJson(join(fixture.appRoot, "package.json"))]]),
    organization: { slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } },
    organizations: [{ slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } }],
    modules: [],
  });
  expect(layout.checks.find((item) => item.id === "MS-11").details).toContain(
    "slot modules/portal používá zrušený layout modules/; Modul patří do workspace/",
  );
});

test("MS-12 keeps apps[] and app generations aligned", async () => {
  const fixture = await conformantFixture({ appPath: "app/v3/package.json" });
  for (const generation of ["v1", "v2"]) {
    await writeJsonFile(join(fixture.moduleRoot, "app", generation, "package.json"), { name: `old-${generation}`, private: true });
  }
  expect(check(await setupModule(fixture), "MS-12").details).toEqual([
    "app/v1/package.json není deklarovaný v apps[]",
    "app/v2/package.json není deklarovaný v apps[]",
    "Modul drží 3 generace App (v1, v2, v3); povolené jsou dvě: výchozí a jedna předchozí nebo kandidátní",
  ]);
});

test("MS-12 accepts a declared newer candidate generation beside an older default", async () => {
  const fixture = await conformantFixture({ appPath: "app/v2/package.json" });
  const candidate = structuredClone(await readJson(join(fixture.appRoot, "package.json")));
  candidate.name = "candidate-v3";
  await writeJsonFile(join(fixture.moduleRoot, "app", "v3", "package.json"), candidate);
  const manifest = await readJson(join(fixture.moduleRoot, "lazurio.module.json"));
  manifest.apps.push("app/v3/package.json");
  await writeJsonFile(join(fixture.moduleRoot, "lazurio.module.json"), manifest);

  expect(check(await setupModule(fixture), "MS-12").status).toBe("pass");
});

test("MS-03 and MS-13 report a missing runtime and missing check/test scripts", async () => {
  const fixture = await conformantFixture();
  const packageJson = await readJson(join(fixture.appRoot, "package.json"));
  delete packageJson.lazurio.runtime;
  delete packageJson.scripts.test;
  const evaluation = await evaluateModuleStandard({
    moduleRoot: fixture.moduleRoot,
    slotPath: "workspace/portal",
    manifest: await readJson(join(fixture.moduleRoot, "lazurio.module.json")),
    packages: new Map([["app/v1/package.json", packageJson]]),
    organization: { slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } },
    organizations: [{ slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } }],
    modules: [],
  });
  expect(evaluation.checks.find((item) => item.id === "MS-03").details).toEqual([
    "app/v1/package.json: lazurio.runtime chybí",
  ]);
  expect(evaluation.checks.find((item) => item.id === "MS-13").details).toEqual([
    "app/v1/package.json: skript test chybí",
  ]);
});

test("human output lists failing checks and their next step", async () => {
  const fixture = await conformantFixture({ port: 23_502 });
  const cli = Bun.spawnSync([
    process.execPath, "run", cliPath, "module", "setup", fixture.moduleRoot, "--root", fixture.lazurioRoot,
  ], { cwd: fixture.lazurioRoot, stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(2);
  const output = cli.stdout.toString();
  expect(output).toContain("Lazurio Module Standard: 12/13 pass");
  expect(output).toContain("MS-01 fail");
  expect(output).toContain("lease main 23502 leží mimo pool 24000-24099; volný port poolu: 24000");
  expect(output).toContain("Další krok: Přepiš port leasu v lazurio.module.json na navržený volný port poolu");
});

function check(report, id) {
  return report.standard.checks.find((item) => item.id === id);
}

async function conformantFixture({
  module = "portal",
  port = 24_010,
  pool = { start: 24_000, end: 24_099 },
  appPath = "app/v1/package.json",
  tsconfig = { compilerOptions: { strict: true } },
  mutatePackage = null,
  git = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-standard-"));
  roots.push(root);
  const organizationRoot = join(root, "organizations", "Acme_GEN3");
  const moduleRoot = join(organizationRoot, "workspace", module);
  const appRoot = join(moduleRoot, dirname(appPath));
  await mkdir(join(appRoot, "src"), { recursive: true });
  await writeJsonFile(join(organizationRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "Acme", display_name: "Acme", github_org: "Acme" },
    ...(pool ? { module_port_pool: pool } : {}),
  });
  await writeJsonFile(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "Acme",
    github_org: "Acme",
    module_slots: [{
      path: `workspace/${module}`,
      slug: module,
      git: { url: `git@github.com:Acme/${module}.git`, branch: "main" },
    }],
  });
  await writeJsonFile(join(moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: module,
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
    apps: [appPath],
    default_app: appPath,
  });
  const packageJson = {
    name: `@acme/${module}`,
    private: true,
    packageManager: `bun@${bunVersion}`,
    type: "module",
    scripts: {
      dev: "bun run src/server.ts",
      check: "tsc --noEmit && biome check",
      test: "bun test",
      "check:prepared": "bun run src/check-prepared.ts",
    },
    dependencies: { "@lazurio/module-kit": "github:Lazurio/module-kit#v0.1.0" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: `acme-${module}-v1`,
        title: "Portal",
        company: "Acme",
        module,
        surface: "internal",
        dev_script: "dev",
        tags: [module],
        listeners: [{
          id: "app",
          role: "entrypoint",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/health" },
        }],
      },
      preparation: {
        schema_version: "lazurio.preparation.v1",
        owner_package: appPath,
        check_script: "check:prepared",
      },
    },
  };
  const lockDependencies = { ...packageJson.dependencies };
  mutatePackage?.(packageJson);
  await writeJsonFile(join(appRoot, "package.json"), packageJson);
  await writeText(join(appRoot, "bun.lock"), `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "@acme/${module}",
      "dependencies": ${JSON.stringify(lockDependencies)},
    },
  },
  "packages": {},
}
`);
  await writeJsonFile(join(appRoot, "tsconfig.json"), tsconfig);
  await writeText(
    join(appRoot, "src", "server.ts"),
    "const port = Number(process.env.LAZURIO_RUNTIME_LISTENER_APP_PORT);\nexport { port };\n",
  );
  await writeText(join(appRoot, "src", "local.ts"), "export const z = 1;\n");
  if (git) {
    runGit(moduleRoot, ["init"]);
    runGit(moduleRoot, ["config", "user.name", "Lazurio Test"]);
    runGit(moduleRoot, ["config", "user.email", "lazurio-test@example.invalid"]);
    if (git === "without-lock") runGit(moduleRoot, ["add", "lazurio.module.json"]);
    else runGit(moduleRoot, ["add", "."]);
    runGit(moduleRoot, ["commit", "-m", "fixture"]);
  }
  return { lazurioRoot: root, organizationRoot, moduleRoot, appRoot, module };
}

async function addNeighbourModule(fixture, { module, port }) {
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const manifest = await readJson(manifestPath);
  manifest.module_slots.push({
    path: `workspace/${module}`,
    slug: module,
    git: { url: `git@github.com:Acme/${module}.git`, branch: "main" },
  });
  await writeJsonFile(manifestPath, manifest);
  await writeJsonFile(join(fixture.organizationRoot, "workspace", module, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: module,
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
  });
}

async function addOrganization(fixture, { slug, pool, module, port }) {
  const organizationRoot = join(fixture.lazurioRoot, "organizations", `${slug}_GEN3`);
  await writeJsonFile(join(organizationRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug, display_name: slug, github_org: slug },
    module_port_pool: pool,
  });
  await writeJsonFile(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: slug,
    github_org: slug,
    module_slots: [{
      path: `workspace/${module}`,
      slug: module,
      git: { url: `git@github.com:${slug}/${module}.git`, branch: "main" },
    }],
  });
  await writeJsonFile(join(organizationRoot, "workspace", module, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: module,
    company: slug,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
  });
}

function runGit(cwd, args) {
  const executable = Bun.which("git");
  if (!executable) throw new Error("Git is required for Module standard tests");
  const result = Bun.spawnSync([executable, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
