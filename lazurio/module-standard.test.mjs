import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { moduleSetupExitCode, setupModule } from "./module-setup-lib.mjs";
import {
  MODULE_STANDARD_CHECKS,
  bunEnvFileFindings,
  bunInvocations,
  developmentServerFindings,
  devScriptFindings,
  evaluateModuleStandard,
  legacyRuntimeReads,
  transpiledSource,
  workflowMinutesFindings,
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
    "MS-08", "MS-09", "MS-10", "MS-11", "MS-12", "MS-13", "MS-14",
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
  expect(JSON.parse(cli.stdout.toString()).standard.checks).toHaveLength(14);
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

// MS-02 "exact and published" (decision 0171, addendum of 2026-10-24, point
// 4): each case measures a fixture App against a synthetic toolchain manifest
// (default and minimum Bun 1.4.2) with an injected registry answer, so no
// case depends on Lazurio's own Bun or touches the network.
const ms02Summary = "packageManager je přesná a vydaná verze Bunu a lockfile je commitnutý a čerstvý";

test("MS-02 adds a missing packageManager as the toolchain manifest's default Bun", async () => {
  const toolchain = bunToolchain({ default: "1.4.4", minimum: "1.4.2" });
  const missing = await conformantFixture({ mutatePackage: (pkg) => { delete pkg.packageManager; } });
  const registry = registryAnswers({});

  const planned = await setupModule({ ...missing, toolchain, isBunVersionPublished: registry.check });
  expect(planned).toMatchObject({ status: "actionable", reason: "standard_repairs_ready" });
  expect(check(planned, "MS-02")).toEqual({
    id: "MS-02",
    status: "fail",
    summary: ms02Summary,
    details: ["app/v1/package.json: packageManager chybí (očekáváno bun@1.4.4)"],
    action: "Nastavte packageManager na přesnou vydanou verzi Bunu (výchozí bun@1.4.4) a commitněte čerstvý bun.lock.",
    repairs: ["app/v1/package.json: doplnit packageManager bun@1.4.4"],
  });

  const applied = await setupModule({ ...missing, apply: true, toolchain, isBunVersionPublished: registry.check });
  expect(applied.status).toBe("completed");
  const written = await readJson(join(missing.appRoot, "package.json"));
  expect(written.packageManager).toBe("bun@1.4.4");
  expect(Object.keys(written).indexOf("packageManager")).toBe(Object.keys(written).indexOf("type") + 1);
  // The default needs no registry lookup, before or after the repair.
  expect(registry.asked).toEqual([]);
});

test("MS-02 fails a packageManager that is not an exact Bun version and never rewrites it", async () => {
  for (const packageManager of ["bun@1.4", "bun@^1.4.2", "bun@1.4.3+sha512.abc", "npm@10.0.0"]) {
    const { report, registry } = await measureBunPin(packageManager, { apply: true });
    expect(report).toMatchObject({ status: "action_required", changes: [] });
    expect(check(report, "MS-02")).toMatchObject({
      status: "fail",
      summary: ms02Summary,
      details: [`app/v1/package.json: packageManager ${packageManager} není přesná verze Bunu (bun@x.y.z)`],
      action: "Nastavte packageManager na přesnou vydanou verzi Bunu (výchozí bun@1.4.2) a commitněte čerstvý bun.lock.",
    });
    expect(check(report, "MS-02").repairs).toBeUndefined();
    expect(registry.asked).toEqual([]);
  }
});

test("MS-02 passes the default Bun without asking the registry", async () => {
  const { report, registry } = await measureBunPin("bun@1.4.2");
  expect(report).toMatchObject({ status: "current", issues: [] });
  expect(check(report, "MS-02")).toEqual({ id: "MS-02", status: "pass", summary: ms02Summary, details: [] });
  expect(registry.asked).toEqual([]);
});

test("MS-02 warns on a published Bun newer than the default", async () => {
  const { report, registry } = await measureBunPin("bun@1.4.3", { published: { "1.4.3": true } });
  expect(check(report, "MS-02")).toMatchObject({
    status: "warn",
    details: ["app/v1/package.json: verze Bunu 1.4.3 je novější než výchozí 1.4.2; každé Prostředí ji při prvním startu stáhne"],
  });
  expect(registry.asked).toEqual(["1.4.3"]);
});

test("MS-02 warns on a published Bun below the minimum", async () => {
  const { report, registry } = await measureBunPin("bun@1.4.1", { published: { "1.4.1": true } });
  expect(check(report, "MS-02")).toMatchObject({
    status: "warn",
    details: ["app/v1/package.json: verze Bunu 1.4.1 je pod minimem 1.4.2"],
  });
  expect(registry.asked).toEqual(["1.4.1"]);
});

test("MS-02 fails a Bun version the registry does not know", async () => {
  const { report, registry } = await measureBunPin("bun@1.4.99", { published: { "1.4.99": false } });
  expect(check(report, "MS-02")).toMatchObject({
    status: "fail",
    details: ["app/v1/package.json: verze Bunu 1.4.99 není vydaná"],
  });
  expect(registry.asked).toEqual(["1.4.99"]);
});

test("MS-02 only warns when the release cannot be verified offline, and never throws", async () => {
  const offline = await measureBunPin("bun@1.4.3", { published: { "1.4.3": null } });
  expect(check(offline.report, "MS-02")).toMatchObject({
    status: "warn",
    details: [
      "app/v1/package.json: vydání Bunu 1.4.3 nejde ověřit (offline)",
      "app/v1/package.json: verze Bunu 1.4.3 je novější než výchozí 1.4.2; každé Prostředí ji při prvním startu stáhne",
    ],
  });

  // A check that throws (a broken injected one) counts as unverifiable.
  const fixture = await conformantFixture({ mutatePackage: (pkg) => { pkg.packageManager = "bun@1.4.3"; } });
  const report = await setupModule({
    ...fixture,
    toolchain: bunToolchain(),
    isBunVersionPublished: async () => { throw new Error("registry exploded"); },
  });
  expect(check(report, "MS-02")).toMatchObject({ status: "warn" });
  expect(check(report, "MS-02").details[0]).toBe("app/v1/package.json: vydání Bunu 1.4.3 nejde ověřit (offline)");
});

test("MS-02 treats a Bun version in the runtime cache as published without the network", async () => {
  const { bunVersionPublished } = await import("./runtime/bun-runtime-lib.mjs");
  const cacheRoot = await mkdtemp(join(tmpdir(), "lazurio-ms02-cache-"));
  roots.push(cacheRoot);
  const system = async () => ({ platform: "linux", arch: "x64", libc: "glibc", avx2: true });
  await writeText(join(cacheRoot, "1.4.3", "node_modules", "@oven", "bun-linux-x64", "bin", "bun"), "#!/bin/sh\n");
  const fetches = [];
  const fixture = await conformantFixture({ mutatePackage: (pkg) => { pkg.packageManager = "bun@1.4.3"; } });
  const report = await setupModule({
    ...fixture,
    toolchain: bunToolchain(),
    isBunVersionPublished: (version) => bunVersionPublished(version, {
      cacheRoot,
      system,
      fetchFn: async (url) => {
        fetches.push(String(url));
        throw new Error("the cached version must not reach the registry");
      },
    }),
  });
  expect(check(report, "MS-02")).toMatchObject({
    status: "warn",
    details: ["app/v1/package.json: verze Bunu 1.4.3 je novější než výchozí 1.4.2; každé Prostředí ji při prvním startu stáhne"],
  });
  expect(fetches).toEqual([]);
});

test("MS-02 lockfile freshness stays a static comparison for any pinned Bun", async () => {
  const stale = await measureBunPin("bun@1.4.2", { mutatePackage: (pkg) => { pkg.dependencies.zod = "^4.0.0"; } });
  expect(check(stale.report, "MS-02").details).toEqual([
    "app/v1/package.json: app/v1/bun.lock není čerstvý (dependencies.zod chybí v lockfilu)",
  ]);
  const staleNewer = await measureBunPin("bun@1.4.3", {
    published: { "1.4.3": true },
    mutatePackage: (pkg) => { pkg.dependencies.zod = "^4.0.0"; },
  });
  expect(check(staleNewer.report, "MS-02")).toMatchObject({ status: "fail" });
  expect(check(staleNewer.report, "MS-02").details).toContain(
    "app/v1/package.json: app/v1/bun.lock není čerstvý (dependencies.zod chybí v lockfilu)",
  );

  const uncommitted = await measureBunPin("bun@1.4.2", { git: "without-lock" });
  expect(check(uncommitted.report, "MS-02").details).toEqual([
    "app/v1/package.json: app/v1/bun.lock není commitnutý",
  ]);

  const notGit = await measureBunPin("bun@1.4.2", { git: false });
  expect(check(notGit.report, "MS-02")).toMatchObject({ status: "warn" });

  for (const measured of [stale, uncommitted, notGit]) expect(measured.registry.asked).toEqual([]);
  expect(staleNewer.registry.asked).toEqual(["1.4.3"]);
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
  // An existing declaration is never rewritten by --apply: the finding stays
  // for the Agent's reviewed edit.
  const explicitReport = await setupModule({ ...explicitBun, apply: true });
  expect(explicitReport).toMatchObject({ status: "action_required", reason: "module_standard_nonconformant", changes: [] });
  expect(check(explicitReport, "MS-04")).toMatchObject({
    status: "fail",
    details: [
      "app/v1/package.json: runtime: bun zapsané explicitně — Platforma dnes neznámá pole odmítá; klíč vynechte (chybí = bun)",
    ],
  });
  expect(check(explicitReport, "MS-04").repairs).toBeUndefined();
  expect((await readJson(join(explicitBun.appRoot, "package.json"))).lazurio.preparation.runtime).toBe("bun");

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

  const pythonWarning = "app/v1/package.json: Python App: čtení [tool.lazurio] z pyproject.toml zatím není v Core; ověřte přípravu ručně";
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
      "app/v1/package.json: postinstall je npm lifecycle jméno — bun install ho spouští sám; použijte prepare:app / check:prepared",
      "app/v1/package.json: prepare je npm lifecycle jméno — bun install ho spouští sám; použijte prepare:app / check:prepared",
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
    "bun --no-env-file run src/server.ts",
    "bun --no-env-file ./node_modules/vite/bin/vite.js --host \"$LAZURIO_RUNTIME_LISTENER_APP_HOST\" --port \"$LAZURIO_RUNTIME_LISTENER_APP_PORT\" --strictPort",
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

test("MS-05 knows a development server from a production start (kap. 4.6)", () => {
  for (const [command, finding] of [
    ["vite", "vite"],
    ["vite --host \"$LAZURIO_RUNTIME_LISTENER_APP_HOST\" --strictPort", "vite"],
    ["bun --no-env-file ./node_modules/vite/bin/vite.js --port \"$LAZURIO_RUNTIME_LISTENER_APP_PORT\"", "vite"],
    ["astro dev", "astro dev"],
    ["bun --no-env-file ./node_modules/astro/astro.js dev", "astro dev"],
    ["bun --no-env-file --hot src/server.ts", "--hot"],
    ["bun --no-env-file --watch run src/server.ts", "--watch"],
  ]) {
    expect(developmentServerFindings(command)).toContain(finding);
  }
  for (const command of [
    "bun --no-env-file run src/server.ts",
    "bun --no-env-file run src/vite-server.ts",
    "bun --no-env-file src/vite.ts",
    "bun --no-env-file run server/astro-pages.ts",
    "vite preview",
    "vite build",
    "astro build",
  ]) {
    expect(developmentServerFindings(command)).toEqual([]);
  }
});

test("an App with its own server holds its start_script to the start-path checks", async () => {
  const declare = (start, scripts = {}) => (pkg) => {
    pkg.scripts = { ...pkg.scripts, ...scripts };
    pkg.lazurio.runtime.start_script = start;
  };
  // The development script that already is the production server.
  expect((await setupModule(await conformantFixture({ mutatePackage: declare("dev") }))).status).toBe("current");
  // A separate start script, with a client built by build_script.
  const client = await conformantFixture({
    mutatePackage: (pkg) => {
      declare("start", { start: "bun --no-env-file run src/server.ts", build: "vite build" })(pkg);
      Object.assign(pkg.lazurio.runtime, { build_script: "build", build_output: "dist" });
    },
  });
  expect((await setupModule(client)).status).toBe("current");

  // A start script that is not a script of the package: the runtime contract
  // refuses it, and MS-03 names it.
  const missingFixture = await conformantFixture({ mutatePackage: declare("start") });
  expect(JSON.stringify((await setupModule(missingFixture)).issues)).toContain("start_script start neexistuje v scripts");
  const evaluation = await evaluateModuleStandard({
    moduleRoot: missingFixture.moduleRoot,
    slotPath: "workspace/portal",
    manifest: await readJson(join(missingFixture.moduleRoot, "lazurio.module.json")),
    packages: new Map([["app/v1/package.json", await readJson(join(missingFixture.appRoot, "package.json"))]]),
    organization: { slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } },
    organizations: [{ slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } }],
    modules: [],
  });
  expect(evaluation.checks.find((item) => item.id === "MS-03")).toMatchObject({
    status: "fail",
    details: ["app/v1/package.json: start_script start neexistuje v scripts"],
  });

  const devServer = await setupModule(await conformantFixture({
    mutatePackage: declare("start", { start: "bun --no-env-file run serve", serve: "astro dev" }),
  }));
  expect(check(devServer, "MS-05").details).toEqual([
    "app/v1/package.json: start_script start spouští vývojový server (astro dev): astro dev",
  ]);
  // The development script itself may stay a development server.
  expect(check(await setupModule(await conformantFixture({
    mutatePackage: (pkg) => { pkg.scripts.dev = "astro dev"; },
  })), "MS-05")).toMatchObject({ status: "pass" });

  const chained = await setupModule(await conformantFixture({
    mutatePackage: declare("start", { start: "bun run build && bun src/server.ts", build: "vite build" }),
  }));
  // The chain of the start script, followed into `build`, as for dev.
  expect(check(chained, "MS-05").details).toEqual([
    "app/v1/package.json: start obsahuje &&: bun run build && bun src/server.ts",
    "app/v1/package.json: start obsahuje build: bun run build && bun src/server.ts",
    "app/v1/package.json: start obsahuje build: vite build",
  ]);
  expect(check(chained, "MS-07").details).toEqual([
    "app/v1/package.json: start spouští Bun bez --no-env-file: bun run build && bun src/server.ts",
  ]);
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
  await writeText(join(fixture.appRoot, "src", "other.ts"), "export const unrelated = 124010; export const ratio = 0.24010; export const scale = 24010.5;\n");
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

test("MS-07 requires --no-env-file on every Bun invocation of the start path (#471)", async () => {
  const bare = await conformantFixture({ mutatePackage: (pkg) => { pkg.scripts.dev = "bun run src/server.ts"; } });
  const bareReport = await setupModule(bare);
  expect(bareReport.status).toBe("action_required");
  expect(check(bareReport, "MS-07")).toMatchObject({
    status: "fail",
    details: ["app/v1/package.json: dev spouští Bun bez --no-env-file: bun run src/server.ts"],
  });

  const chained = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun --no-env-file run serve";
      pkg.scripts.serve = "bun src/server.ts";
    },
  });
  expect(check(await setupModule(chained), "MS-07").details).toEqual([
    "app/v1/package.json: dev spouští Bun bez --no-env-file: bun src/server.ts",
  ]);

  // The flag after `run` is a Bun option too; the chain follows into `serve`.
  const afterRun = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun run --no-env-file serve";
      pkg.scripts.serve = "bun src/server.ts";
    },
  });
  expect(check(await setupModule(afterRun), "MS-07").details).toEqual([
    "app/v1/package.json: dev spouští Bun bez --no-env-file: bun src/server.ts",
  ]);
  const afterRunFlagged = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun run --no-env-file serve";
      pkg.scripts.serve = "bun --no-env-file src/server.ts";
    },
  });
  expect(check(await setupModule(afterRunFlagged), "MS-07")).toMatchObject({ status: "pass", details: [] });

  // A value-taking option before the script name consumes its value; the
  // chain still reaches `serve` (one tokenizer for MS-07 and the chain).
  const valueOption = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun run --no-env-file --cwd . serve";
      pkg.scripts.serve = "bun src/server.ts";
    },
  });
  expect(check(await setupModule(valueOption), "MS-07").details).toEqual([
    "app/v1/package.json: dev spouští Bun bez --no-env-file: bun src/server.ts",
  ]);
  const valueOptionFlagged = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.scripts.dev = "bun run --no-env-file --cwd . serve";
      pkg.scripts.serve = "bun --no-env-file src/server.ts";
    },
  });
  expect(check(await setupModule(valueOptionFlagged), "MS-07")).toMatchObject({ status: "pass", details: [] });

  // Bun passes options after the entry to the script: the flag there is no flag.
  const late = await conformantFixture({ mutatePackage: (pkg) => { pkg.scripts.dev = "bun run src/server.ts --no-env-file"; } });
  expect(check(await setupModule(late), "MS-07").details).toEqual([
    "app/v1/package.json: dev má --no-env-file až za vstupem (Bun ho předá skriptu jako argument): bun run src/server.ts --no-env-file",
  ]);

  // An explicit --env-file is loaded even with --no-env-file.
  const envFile = await conformantFixture({
    mutatePackage: (pkg) => { pkg.scripts.dev = "bun --no-env-file --env-file=config/local.conf run src/server.ts"; },
  });
  expect(check(await setupModule(envFile), "MS-07").details).toEqual([
    "app/v1/package.json: dev načítá soubor přes --env-file: bun --no-env-file --env-file=config/local.conf run src/server.ts",
  ]);

  // A framework CLI started by the Launchpad's own `bun --no-env-file run`
  // invokes no second Bun process; scripts off the start path are not judged.
  const framework = await conformantFixture({ mutatePackage: (pkg) => { pkg.scripts.dev = "astro dev"; } });
  expect(check(await setupModule(framework), "MS-07")).toMatchObject({ status: "pass", details: [] });
  expect(check(await setupModule(await conformantFixture()), "MS-07")).toMatchObject({ status: "pass" });
});

test("MS-07 reads Bun options only before the entry, after `bun` or after `bun run`", () => {
  for (const [command, findings] of [
    ["bun --no-env-file run src/server.ts", []],
    ["bun run --no-env-file src/server.ts", []],
    ["bun --no-env-file ./node_modules/vite/bin/vite.js --host \"$LAZURIO_RUNTIME_LISTENER_APP_HOST\"", []],
    ["bun --cwd app --no-env-file run src/server.ts", []],
    ["bun run --no-env-file --cwd . serve", []],
    ["bun run --no-env-file --cwd=. serve", []],
    ["bun run --cwd . serve", ["missing"]],
    ["bun run src/server.ts", ["missing"]],
    ["bun run src/server.ts --no-env-file", ["after-entry"]],
    ["bun src/server.ts --no-env-file --env-file x.conf", ["after-entry"]],
    ["bun --no-env-file --env-file=custom.conf src/server.ts", ["env-file"]],
    ["bun --no-env-file --env-file custom.conf src/server.ts", ["env-file"]],
    ["bun run --no-env-file --env-file custom.conf src/server.ts", ["env-file"]],
    ["bun --env-file custom.conf src/server.ts", ["missing", "env-file"]],
    ["astro dev", []],
  ]) {
    expect([command, bunEnvFileFindings(command)]).toEqual([command, findings]);
  }
  for (const command of ["bun run --no-env-file --cwd . serve", "bun run --no-env-file --cwd=. serve"]) {
    expect(bunInvocations(command)).toEqual([{ options: ["--no-env-file", "--cwd"], entry: "serve", args: [] }]);
  }
  expect(bunInvocations("bun --no-env-file src/server.ts --port 1")).toEqual([
    { options: ["--no-env-file"], entry: "src/server.ts", args: ["--port", "1"] },
  ]);
});

test("required secrets declare names only; MS-03 warns that this Launchpad has no vault reader", async () => {
  const declared = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.secrets = ["EXTERNAL_API_KEY", "WEBHOOK_SIGNING_KEY"]; },
  });
  const report = await setupModule(declared);
  expect(report.status).toBe("action_required");
  expect(check(report, "MS-03")).toMatchObject({ status: "warn" });
  expect(check(report, "MS-03").details).toEqual([
    expect.stringContaining("lazurio.runtime.secrets (EXTERNAL_API_KEY, WEBHOOK_SIGNING_KEY) tento Launchpad z trezoru nepředává"),
  ]);
  expect(report.standard.checks.filter((item) => item.status !== "pass").map((item) => item.id)).toEqual(["MS-03"]);

  for (const [secrets, message] of [
    [[], "secrets musí být neprázdné pole jmen"],
    ["EXTERNAL_API_KEY", "secrets musí být neprázdné pole jmen"],
    [["external_api_key"], "secrets[0] není validní"],
    [["1KEY"], "secrets[0] není validní"],
    [["EXTERNAL-API-KEY"], "secrets[0] není validní"],
    [["EXTERNAL_API_KEY", "EXTERNAL_API_KEY"], "secrets[1] EXTERNAL_API_KEY je duplicitní"],
  ]) {
    const invalid = await conformantFixture({ mutatePackage: (pkg) => { pkg.lazurio.runtime.secrets = secrets; } });
    const invalidReport = await setupModule(invalid);
    expect(invalidReport).toMatchObject({ status: "action_required", reason: "runtime_contract_invalid", standard: null });
    // The setup message carries the absolute package path, native separators included.
    expect(invalidReport.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(`package.json: lazurio.runtime.${message}`),
    ]);
  }
});

test("module setup accepts optional capabilities and rejects ambiguous secret declarations", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.optional_secrets = ["WAITLIST_DATABASE_URL"]; },
  });
  const report = await setupModule(fixture);
  expect(report).toMatchObject({ status: "current", reason: "module_contract_current", issues: [] });
  expect(check(report, "MS-03").status).toBe("pass");
  expect(report.standard.checks.every((item) => item.status === "pass")).toBe(true);

  for (const declaration of [
    { optional_secrets: [] },
    { optional_secrets: "WAITLIST_DATABASE_URL" },
    { optional_secrets: ["database_url"] },
    { optional_secrets: ["1KEY"] },
    { optional_secrets: ["DATABASE-URL"] },
    { optional_secrets: ["DATABASE_URL", "DATABASE_URL"] },
    { secrets: ["DATABASE_URL"], optional_secrets: ["DATABASE_URL"] },
  ]) {
    const invalid = await conformantFixture({
      mutatePackage: (pkg) => Object.assign(pkg.lazurio.runtime, declaration),
    });
    expect(await setupModule(invalid)).toMatchObject({
      status: "action_required", reason: "runtime_contract_invalid", standard: null,
    });
  }
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

// Decision 0176: Modules live side by side in workspace/. An App reads a
// sibling it declares in lazurio.runtime.required_module_slots as ../<slug>/
// from its Module root (data and read models only); everything else outside
// the repository stays a finding.
const siblingReads = [
  "import prices from \"../../../../pricebook/db/prices.json\";",
  "const records = import.meta.glob(\"../../../../pricebook/db/records/*.json\", { eager: true });",
  "const readModel = resolve(import.meta.dirname, \"../../../../pricebook/generated/read-model.json\");",
  "export { prices, records, readModel };",
].join("\n");

test("MS-09 accepts data reads of a declared sibling Module under ../<slug>/", async () => {
  for (const slot of ["workspace/pricebook", "workspace/pricebook/db"]) {
    const fixture = await conformantFixture({
      mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = [slot]; },
    });
    await writeText(join(fixture.appRoot, "src", "prices.ts"), `import { resolve } from "node:path";\n${siblingReads}\n`);
    runGit(fixture.moduleRoot, ["add", "."]);

    const report = await setupModule(fixture);

    expect(check(report, "MS-09")).toMatchObject({ status: "pass", details: [] });
    expect(check(report, "MS-06").status).toBe("pass");
    expect(report.status).toBe("current");
  }
});

test("MS-09 fails reads of an undeclared sibling, code of a declared sibling and any other escape", async () => {
  const undeclared = await conformantFixture();
  await writeText(join(undeclared.appRoot, "src", "prices.ts"), `import { resolve } from "node:path";\n${siblingReads}\n`);
  expect(check(await setupModule(undeclared), "MS-09")).toMatchObject({
    status: "fail",
    details: [
      "app/v1/src/prices.ts: import ../../../../pricebook/db/prices.json čte Modul pricebook, který App nedeklaruje v lazurio.runtime.required_module_slots",
      "app/v1/src/prices.ts: cesta ../../../../pricebook/db/records/*.json čte Modul pricebook, který App nedeklaruje v lazurio.runtime.required_module_slots",
      "app/v1/src/prices.ts: cesta ../../../../pricebook/generated/read-model.json čte Modul pricebook, který App nedeklaruje v lazurio.runtime.required_module_slots",
    ],
  });

  const declared = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = ["workspace/pricebook"]; },
  });
  await writeText(
    join(declared.appRoot, "src", "escape.ts"),
    [
      "import { price } from \"../../../../pricebook/app/v1/src/price.ts\";",
      "import { helper } from \"../../../../pricebook/src/helper\";",
      "const views = import.meta.glob(\"../../../../pricebook/app/v1/src/views/*.tsx\");",
      "const other = new URL(\"../../../../deals/db/deals.json\", import.meta.url);",
      "const organization = resolve(import.meta.dirname, \"../../../../../modules.manifest.json\");",
      "export { price, helper, views, other, organization };",
    ].join("\n"),
  );
  expect(check(await setupModule(declared), "MS-09").details).toEqual([
    "app/v1/src/escape.ts: import ../../../../pricebook/app/v1/src/price.ts načítá kód Modulu pricebook; ze sousedního Modulu se čtou jen data",
    "app/v1/src/escape.ts: import ../../../../pricebook/src/helper načítá kód Modulu pricebook; ze sousedního Modulu se čtou jen data",
    "app/v1/src/escape.ts: cesta ../../../../pricebook/app/v1/src/views/*.tsx načítá kód Modulu pricebook; ze sousedního Modulu se čtou jen data",
    "app/v1/src/escape.ts: cesta ../../../../deals/db/deals.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots",
    "app/v1/src/escape.ts: cesta ../../../../../modules.manifest.json míří mimo repo Modulu",
  ]);
});

test("MS-06 fails reads of a sibling's manifests even when the sibling is declared", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = ["workspace/pricebook"]; },
  });
  await writeText(
    join(fixture.appRoot, "src", "links.ts"),
    [
      "import { readFile } from \"node:fs/promises\";",
      "const lease = await readFile(new URL(\"../../../../pricebook/lazurio.module.json\", import.meta.url), \"utf8\");",
      "const runtime = await readFile(new URL(\"../../../../pricebook/app/v1/package.json\", import.meta.url), \"utf8\");",
      "export { lease, runtime };",
    ].join("\n"),
  );

  const report = await setupModule(fixture);

  expect(check(report, "MS-06").details).toEqual([
    "app/v1/src/links.ts: čte lazurio.module.json (lease soubor)",
    "app/v1/src/links.ts: čte package.json Modulu pricebook (runtime a lease souseda)",
  ]);
  expect(check(report, "MS-09").status).toBe("pass");
});

test("MS-09 judges a cwd-relative path from the App root as well as from the file", async () => {
  const probe = [
    "import { readFile } from \"node:fs/promises\";",
    "import { resolve } from \"node:path\";",
    "const prices = await readFile(\"../../../deals/db/prices.json\", \"utf8\");",
    "const multi = resolve(",
    "  import.meta.dirname,",
    "  \"../../../../deals/db/multi.json\",",
    ");",
    "export { prices, multi };",
  ].join("\n");
  const undeclared = await conformantFixture();
  await writeText(join(undeclared.appRoot, "src", "probe.ts"), probe);
  expect(check(await setupModule(undeclared), "MS-09").details).toEqual([
    "app/v1/src/probe.ts: cesta ../../../deals/db/prices.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots (vůči kořeni App app/v1, pracovnímu adresáři procesu)",
    "app/v1/src/probe.ts: cesta ../../../../deals/db/multi.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots",
  ]);

  const declared = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = ["workspace/deals/db"]; },
  });
  await writeText(join(declared.appRoot, "src", "probe.ts"), probe);
  expect(check(await setupModule(declared), "MS-09")).toMatchObject({ status: "pass", details: [] });
});

test("MS-09 normalizes relative paths that start with ./", async () => {
  const fixture = await conformantFixture();
  await writeText(
    join(fixture.appRoot, "src", "probe.ts"),
    [
      "const deals = new URL(\"./../../../../deals/db/deals.json\", import.meta.url);",
      "const local = new URL(\"./../local.json\", import.meta.url);",
      "export { deals, local };",
    ].join("\n"),
  );
  expect(check(await setupModule(fixture), "MS-09").details).toEqual([
    "app/v1/src/probe.ts: cesta ./../../../../deals/db/deals.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots",
  ]);
});

test("MS-09 allows a declared sibling only under its db/ and generated/ trees", async () => {
  const fixture = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = ["workspace/pricebook"]; },
  });
  await writeText(
    join(fixture.appRoot, "src", "probe.ts"),
    [
      "const secrets = new URL(\"../../../../pricebook/.env\", import.meta.url);",
      "const config = new URL(\"../../../../pricebook/app/v1/config.toml\", import.meta.url);",
      "const readme = new URL(\"../../../../pricebook/README.md\", import.meta.url);",
      "const hidden = new URL(\"../../../../pricebook/db/.env.local\", import.meta.url);",
      "const whole = new URL(\"../../../../pricebook\", import.meta.url);",
      "const data = new URL(\"../../../../pricebook/db/records/\", import.meta.url);",
      "const model = new URL(\"../../../../pricebook/generated/v2/prices.json\", import.meta.url);",
      "export { secrets, config, readme, hidden, whole, data, model };",
    ].join("\n"),
  );
  const only = "ze souseda se čte jen db/ a generated/";
  expect(check(await setupModule(fixture), "MS-09").details).toEqual([
    `app/v1/src/probe.ts: cesta ../../../../pricebook/.env čte Modul pricebook mimo jeho data; ${only}`,
    `app/v1/src/probe.ts: cesta ../../../../pricebook/app/v1/config.toml čte Modul pricebook mimo jeho data; ${only}`,
    `app/v1/src/probe.ts: cesta ../../../../pricebook/README.md čte Modul pricebook mimo jeho data; ${only}`,
    `app/v1/src/probe.ts: cesta ../../../../pricebook/db/.env.local čte Modul pricebook mimo jeho data; ${only}`,
    `app/v1/src/probe.ts: cesta ../../../../pricebook čte Modul pricebook mimo jeho data; ${only}`,
  ]);
});

test("MS-09 ignores paths named only in comments and keeps code after // inside literals", async () => {
  const fixture = await conformantFixture();
  await writeText(
    join(fixture.appRoot, "src", "probe.ts"),
    [
      "import { resolve } from \"node:path\";",
      "// Example only: \"../../../../../modules.manifest.json\"",
      "/* import { price } from \"../../../../pricebook/app/v1/src/price.ts\"; */",
      "const local = resolve(import.meta.dirname, \"../../../src/local.json\"); // in-Module: \"../../../../deals/db/x.json\"",
      "const api = \"https://example.com/api\"; const leak = new URL(\"../../../../deals/db/url.json\", import.meta.url);",
      "const slashes = /\\/\\//g; const regexLeak = new URL(\"../../../../deals/db/regex.json\", import.meta.url);",
      "export { local, api, leak, slashes, regexLeak };",
    ].join("\n"),
  );
  expect(check(await setupModule(fixture), "MS-09").details).toEqual([
    "app/v1/src/probe.ts: cesta ../../../../deals/db/url.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots",
    "app/v1/src/probe.ts: cesta ../../../../deals/db/regex.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots",
  ]);
});

test("MS-09 does not read a path in a comment inside a template interpolation", async () => {
  const fixture = await conformantFixture();
  await writeText(
    join(fixture.appRoot, "src", "probe.ts"),
    [
      "const id = 1;",
      "export const message = `${id /* example only: \"../../../../pricebook/db/prices.json\" */}`;",
      "export const read = `${/* \"../../../../pricebook/db/note.json\" */ new URL(\"../../../../deals/db/deals.json\", import.meta.url)}`;",
    ].join("\n"),
  );
  expect(check(await setupModule(fixture), "MS-09").details).toEqual([
    "app/v1/src/probe.ts: cesta ../../../../deals/db/deals.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots",
  ]);
});

test("MS-09 judges a cwd-relative read inside a template interpolation from the App root", async () => {
  const probe = [
    "import { readFileSync } from \"node:fs\";",
    "export const value = `${readFileSync(\"../../../deals/db/prices.json\", \"utf8\")}`;",
  ].join("\n");
  const undeclared = await conformantFixture();
  await writeText(join(undeclared.appRoot, "src", "probe.ts"), probe);
  expect(check(await setupModule(undeclared), "MS-09").details).toEqual([
    "app/v1/src/probe.ts: cesta ../../../deals/db/prices.json čte Modul deals, který App nedeklaruje v lazurio.runtime.required_module_slots (vůči kořeni App app/v1, pracovnímu adresáři procesu)",
  ]);

  const declared = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = ["workspace/deals"]; },
  });
  await writeText(join(declared.appRoot, "src", "probe.ts"), probe);
  expect(check(await setupModule(declared), "MS-09")).toMatchObject({ status: "pass", details: [] });
});

test("MS-09 still sees type-only imports the transpiler would drop", async () => {
  const fixture = await conformantFixture();
  await writeText(
    join(fixture.appRoot, "src", "types.ts"),
    [
      "import type { Price } from \"../../../../pricebook/app/v1/src/price.ts\";",
      "import { type Deal } from \"../../../../deals/app/v1/src/deal.ts\";",
      "// import type { Old } from \"../../../../deals/app/v1/src/old.ts\";",
      "export type Pair = [Price, Deal];",
    ].join("\n"),
  );
  expect(check(await setupModule(fixture), "MS-09").details).toEqual([
    "app/v1/src/types.ts: import ../../../../pricebook/app/v1/src/price.ts míří mimo repo Modulu",
    "app/v1/src/types.ts: import ../../../../deals/app/v1/src/deal.ts míří mimo repo Modulu",
  ]);
});

test("transpiledSource drops comments, keeps literals and falls back to the source", () => {
  const source = [
    "// comment \"../../../x.json\"",
    "const a = `t ${/* \"../../../y.json\" */ \"../z.json\"} https://e.com/a`;",
    "const b = /\\/\\//.test(a) ? \"../ok.json\" : readFile(\"../../../w.json\");",
    "/* block \"../../../v.json\" */ export const c: string = a + b;",
  ].join("\n");
  const { code, masked } = transpiledSource(source, ".ts");
  expect(code).not.toContain("x.json");
  expect(code).not.toContain("y.json");
  expect(code).not.toContain("v.json");
  for (const kept of ["\"../z.json\"", "https://e.com/a", "/\\/\\//", "\"../ok.json\"", "readFile(\"../../../w.json\")"]) {
    expect(code).toContain(kept);
  }
  expect(masked.length).toBe(code.length);
  expect(masked).toContain("readFile(\"" + " ".repeat("../../../w.json".length) + "\")");

  const astro = "---\n// \"../../../x.json\"\nconst posts = import.meta.glob(\"../../content/*.md\");\n---\n<p>// kept as written</p>\n";
  const astroCode = transpiledSource(astro, ".astro").code;
  expect(astroCode).not.toContain("x.json");
  expect(astroCode).toContain("import.meta.glob(\"../../content/*.md\")");
  expect(astroCode.endsWith("\n---\n<p>// kept as written</p>\n")).toBe(true);

  expect(transpiledSource("const = \"../../../x.json\"; // broken", ".ts").code).toBe("const = \"../../../x.json\"; // broken");
});

test("a sibling App address derived from the own external origin needs nothing from the checker", async () => {
  const fixture = await conformantFixture();
  await writeText(
    join(fixture.appRoot, "src", "sibling-origin.ts"),
    [
      "const own = new URL(process.env.LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN ?? \"\");",
      "const [, ...rest] = own.hostname.split(\".\");",
      "export const pricebookOrigin = `${own.protocol}//${[\"pricebook\", ...rest].join(\".\")}`;",
    ].join("\n"),
  );
  runGit(fixture.moduleRoot, ["add", "."]);

  expect((await setupModule(fixture)).status).toBe("current");
});

test("MS-06 accepts the sibling address of a declared Module and fails it for an undeclared one or a data mount only (decision 0176, addendum of 2026-10-10)", async () => {
  const caller = [
    "// process.env.LAZURIO_RUNTIME_SIBLING_DEALS_ORIGIN in a comment is not a read",
    "const pricebook = process.env.LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN;",
    "const priceList = Bun.env[\"LAZURIO_RUNTIME_SIBLING_PRICE_LIST_ORIGIN\"];",
    "export { pricebook, priceList };",
  ].join("\n");

  const declared = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.lazurio.runtime.required_module_slots = ["workspace/pricebook", "workspace/price-list"];
    },
  });
  await writeText(join(declared.appRoot, "src", "siblings.ts"), `${caller}\n`);
  runGit(declared.moduleRoot, ["add", "."]);
  expect(check(await setupModule(declared), "MS-06")).toMatchObject({ status: "pass", details: [] });
  expect((await setupModule(declared)).status).toBe("current");

  const dataOnly = await conformantFixture({
    mutatePackage: (pkg) => {
      pkg.lazurio.runtime.required_module_slots = ["workspace/pricebook/db"];
    },
  });
  await writeText(join(dataOnly.appRoot, "src", "siblings.ts"), `${caller}\n`);
  await writeText(
    join(dataOnly.appRoot, "src", "siblings.test.ts"),
    "process.env.LAZURIO_RUNTIME_SIBLING_DEALS_ORIGIN = \"http://127.0.0.1:1\";\n",
  );
  expect(check(await setupModule(dataOnly), "MS-06")).toMatchObject({
    status: "fail",
    details: [
      "app/v1/src/siblings.ts: čte LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN, ale App nedeklaruje sousední Modul jako slot workspace/<slug> v lazurio.runtime.required_module_slots",
      "app/v1/src/siblings.ts: čte LAZURIO_RUNTIME_SIBLING_PRICE_LIST_ORIGIN, ale App nedeklaruje sousední Modul jako slot workspace/<slug> v lazurio.runtime.required_module_slots",
    ],
  });

  // Reading a sibling's lease for its address stays an MS-06 finding even
  // when the sibling is declared.
  const lease = await conformantFixture({
    mutatePackage: (pkg) => { pkg.lazurio.runtime.required_module_slots = ["workspace/pricebook"]; },
  });
  await writeText(
    join(lease.appRoot, "src", "siblings.ts"),
    "const lease = await Bun.file(new URL(\"../../../../pricebook/lazurio.module.json\", import.meta.url)).json();\nexport const origin = `http://127.0.0.1:${lease.port_leases[0].port}`;\n",
  );
  expect(check(await setupModule(lease), "MS-06").details).toEqual([
    "app/v1/src/siblings.ts: čte lazurio.module.json (lease soubor)",
  ]);
});

test("MS-06 counts only reads of a sibling address from the environment, in every form, never a mention of its name", async () => {
  const undeclared = (name) => `čte LAZURIO_RUNTIME_SIBLING_${name}_ORIGIN, ale App nedeklaruje sousední Modul jako slot workspace/<slug> v lazurio.runtime.required_module_slots`;
  const reads = await conformantFixture({ module: "reports" });
  await writeText(
    join(reads.appRoot, "src", "reads.ts"),
    [
      "const a = process.env?.LAZURIO_RUNTIME_SIBLING_ALPHA_ORIGIN;",
      "const b = import.meta.env[`LAZURIO_RUNTIME_SIBLING_BETA_ORIGIN`];",
      "const { LAZURIO_RUNTIME_SIBLING_GAMMA_ORIGIN: c } = Bun.env;",
      "export { a, b, c };",
    ].join("\n"),
  );
  expect(check(await setupModule(reads), "MS-06").details).toEqual([
    `app/v1/src/reads.ts: ${undeclared("ALPHA")}`,
    `app/v1/src/reads.ts: ${undeclared("BETA")}`,
    `app/v1/src/reads.ts: ${undeclared("GAMMA")}`,
  ]);

  // Mentions are not reads: a message, a constant, a comment, an Astro HTML
  // or JSX comment and template text.
  const mentions = await conformantFixture({ module: "reports" });
  await writeText(
    join(mentions.appRoot, "src", "mentions.ts"),
    [
      "export const note = \"LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN\";",
      "export const message = `Launchpad nepředal LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN`;",
      "/* process.env.LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN */",
    ].join("\n"),
  );
  await writeText(
    join(mentions.appRoot, "src", "page.astro"),
    [
      "---",
      "const title = \"Ceny\";",
      "---",
      "<!-- process.env.LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN -->",
      "{/* process.env.LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN */}",
      "<p>{title}: LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN</p>",
    ].join("\n"),
  );
  runGit(mentions.moduleRoot, ["add", "."]);
  expect(check(await setupModule(mentions), "MS-06")).toMatchObject({ status: "pass", details: [] });
});

test("MS-06 reads sibling addresses in the Python sources of a uv App too", async () => {
  const uvApp = (slots) => conformantFixture({
    module: "reports",
    mutatePackage: (pkg) => {
      pkg.lazurio.preparation.runtime = "uv";
      pkg.lazurio.preparation.uv_version = "0.8.4";
      if (slots) pkg.lazurio.runtime.required_module_slots = slots;
    },
  });
  const server = [
    "import os",
    "from os import environ",
    "# os.environ[\"LAZURIO_RUNTIME_SIBLING_DEALS_ORIGIN\"] in a comment is not a read",
    "NOTE = \"set LAZURIO_RUNTIME_SIBLING_DEALS_ORIGIN # not a comment, not a read\"",
    "pricebook = os.environ[\"LAZURIO_RUNTIME_SIBLING_PRICEBOOK_ORIGIN\"]",
    "price_list = os.getenv('LAZURIO_RUNTIME_SIBLING_PRICE_LIST_ORIGIN')",
    "stock = environ.get(\"LAZURIO_RUNTIME_SIBLING_STOCK_ORIGIN\", \"\")",
  ].join("\n");

  const undeclared = await uvApp(null);
  await writeText(join(undeclared.appRoot, "src", "reports", "server.py"), `${server}\n`);
  await writeText(join(undeclared.appRoot, "tests", "test_server.py"), "os.environ[\"LAZURIO_RUNTIME_SIBLING_TEST_ORIGIN\"] = \"x\"\n");
  await writeText(join(undeclared.appRoot, "src", "reports", "server_test.py"), "os.getenv(\"LAZURIO_RUNTIME_SIBLING_TEST_ORIGIN\")\n");
  const message = (name) => `app/v1/src/reports/server.py: čte LAZURIO_RUNTIME_SIBLING_${name}_ORIGIN, ale App nedeklaruje sousední Modul jako slot workspace/<slug> v lazurio.runtime.required_module_slots`;
  expect(check(await setupModule(undeclared), "MS-06")).toMatchObject({
    status: "fail",
    details: [message("PRICEBOOK"), message("PRICE_LIST"), message("STOCK")],
  });

  const declared = await uvApp(["workspace/pricebook", "workspace/price-list", "workspace/stock"]);
  await writeText(join(declared.appRoot, "src", "reports", "server.py"), `${server}\n`);
  expect(check(await setupModule(declared), "MS-06")).toMatchObject({ status: "pass", details: [] });
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

test("MS-14 warns when Windows or macOS runs on push, a schedule or every pull request, and stays quiet for Linux and code pull requests", async () => {
  const fixture = await conformantFixture();
  const workflows = join(fixture.moduleRoot, ".github", "workflows");
  await mkdir(workflows, { recursive: true });
  await writeFile(join(workflows, "every-change.yml"), [
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  check:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, windows-latest]",
    "    steps:",
    "      - run: bun test",
    "",
  ].join("\n"));
  await writeFile(join(workflows, "nightly-mac.yml"), [
    "on:",
    "  schedule:",
    "    - cron: '0 3 * * *'",
    "jobs:",
    "  mac:",
    "    runs-on: macos-latest",
    "    steps:",
    "      - run: bun test",
    "",
  ].join("\n"));
  await writeFile(join(workflows, "windows-portability.yml"), [
    "on:",
    "  pull_request:",
    "    paths:",
    "      - \"app/**\"",
    "  workflow_dispatch:",
    "jobs:",
    "  windows:",
    "    runs-on: windows-latest",
    "    steps:",
    "      - run: bun test",
    "",
  ].join("\n"));
  await writeFile(join(workflows, "linux.yml"), [
    "on: [pull_request, push]",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: bun test",
    "",
  ].join("\n"));
  const evaluation = await evaluateModuleStandard({
    moduleRoot: fixture.moduleRoot,
    slotPath: "workspace/portal",
    manifest: await readJson(join(fixture.moduleRoot, "lazurio.module.json")),
    packages: new Map([["app/v1/package.json", await readJson(join(fixture.appRoot, "package.json"))]]),
    organization: { slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } },
    organizations: [{ slug: "Acme", module_port_pool: { start: 24_000, end: 24_099 } }],
    modules: [],
  });
  const check = evaluation.checks.find((item) => item.id === "MS-14");
  expect(check.status).toBe("warn");
  expect([...check.details].sort()).toEqual([
    ".github/workflows/every-change.yml: Windows nebo macOS běží pro každý pull_request (chybí pull_request.paths na kód)",
    ".github/workflows/every-change.yml: Windows nebo macOS běží při push",
    ".github/workflows/nightly-mac.yml: Windows nebo macOS běží podle plánu (schedule)",
  ]);
  expect(check.action).toContain("workflow_dispatch");
  expect(evaluation.checks.filter((item) => item.id !== "MS-14").every((item) => item.status === "pass")).toBe(true);
});

test("workflowMinutesFindings reads every trigger shape and refuses unreadable YAML", () => {
  expect(workflowMinutesFindings("on: push\njobs:\n  a:\n    runs-on: [self-hosted, macos]\n")).toEqual([
    "Windows nebo macOS běží při push",
  ]);
  expect(workflowMinutesFindings("on:\n  pull_request_target:\n    paths-ignore: [docs/**]\njobs:\n  a:\n    runs-on: windows-2022\n")).toEqual([
    "Windows nebo macOS běží pro každý pull_request_target (chybí pull_request.paths na kód)",
  ]);
  expect(workflowMinutesFindings("on: [workflow_dispatch, release]\njobs:\n  a:\n    runs-on: windows-latest\n")).toEqual([]);
  expect(workflowMinutesFindings("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n")).toEqual([]);
  expect(workflowMinutesFindings("on: [push\n")).toEqual(["workflow nejde přečíst jako YAML"]);
});

test("human output lists failing checks and their next step", async () => {
  const fixture = await conformantFixture({ port: 23_502 });
  const cli = Bun.spawnSync([
    process.execPath, "run", cliPath, "module", "setup", fixture.moduleRoot, "--root", fixture.lazurioRoot,
  ], { cwd: fixture.lazurioRoot, stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(2);
  const output = cli.stdout.toString();
  expect(output).toContain("Lazurio Module Standard: 13/14 pass");
  expect(output).toContain("MS-01 fail");
  expect(output).toContain("lease main 23502 leží mimo pool 24000-24099; volný port poolu: 24000");
  expect(output).toContain("Další krok: Přepište port leasu v lazurio.module.json na navržený volný port poolu");
});

function check(report, id) {
  return report.standard.checks.find((item) => item.id === id);
}

// A synthetic lazurio/toolchain.json as readToolchainManifest returns it.
function bunToolchain({ default: bunDefault = "1.4.2", minimum = "1.4.2" } = {}) {
  return Object.freeze({
    schema_version: "lazurio.toolchain.v1",
    tools: Object.freeze({
      bun: Object.freeze({ default: bunDefault, minimum }),
      node: Object.freeze({ minimum: "22.12.0" }),
      uv: Object.freeze({ default: "0.11.6" }),
      gh: Object.freeze({ minimum: "2.57.0" }),
      git: Object.freeze({ minimum: "2.31.0" }),
    }),
  });
}

// The registry as MS-02 asks it: `answers` maps a version to true (200),
// false (404) or null (offline); any other lookup is a test failure.
function registryAnswers(answers) {
  const asked = [];
  return {
    asked,
    check: async (version) => {
      asked.push(version);
      if (!Object.hasOwn(answers, version)) throw new Error(`unexpected registry lookup for Bun ${version}`);
      return answers[version];
    },
  };
}

async function measureBunPin(packageManager, { published = {}, apply = false, mutatePackage = null, git = true } = {}) {
  const fixture = await conformantFixture({
    git,
    mutatePackage: (pkg) => {
      pkg.packageManager = packageManager;
      mutatePackage?.(pkg);
    },
  });
  const registry = registryAnswers(published);
  const report = await setupModule({
    ...fixture,
    apply,
    toolchain: bunToolchain(),
    isBunVersionPublished: registry.check,
  });
  return { report, registry, fixture };
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
      dev: "bun --no-env-file run src/server.ts",
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
