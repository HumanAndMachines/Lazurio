import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadModuleTemplates } from "./module-create-lib.mjs";
import {
  DEFAULT_SCAFFOLD_VERSIONS,
  insertModuleSlotText,
  MODULE_SCAFFOLD_STACKS,
  ModuleScaffoldError,
  moduleScaffoldDefaultPort,
  moduleScaffoldTreeHash,
  planModuleScaffold,
  templateTargetPath,
} from "./module-scaffold-lib.mjs";
import { setupModule } from "./module-setup-lib.mjs";
import { readRequiredBunVersion } from "./core/toolchain-lib.mjs";
import { validateAgainstSchema } from "./runtime/json-schema-mini.mjs";

const roots = [];
const savedEnvironment = {};
const bunVersion = readRequiredBunVersion();
const templates = await loadModuleTemplates();
const versions = { bun: bunVersion, ...DEFAULT_SCAFFOLD_VERSIONS };
const pool = { start: 24_000, end: 24_099 };
const organization = Object.freeze({
  slug: "Acme",
  github_org: "AcmeHQ",
  module_port_pool: pool,
  teams: ["core", "web"],
  existing_slots: [{ path: "workspace/Billing", slug: "billing" }],
  existing_leases: [{ company: "Acme", module: "billing", port: 24_000 }],
});
const runtimeSchema = await Bun.file(join(import.meta.dirname, "schemas", "lazurio-runtime.schema.json")).json();
const preparationSchema = await Bun.file(join(import.meta.dirname, "schemas", "lazurio-preparation.schema.json")).json();

beforeAll(async () => {
  const home = await tempRoot("lazurio-scaffold-home-");
  for (const [name, value] of Object.entries({
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
  })) {
    savedEnvironment[name] = process.env[name];
    process.env[name] = value;
  }
});

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function plan(overrides = {}) {
  return planModuleScaffold({ organization, slug: "portal", stack: "vite-react", templates, versions, ...overrides });
}

function expectCode(run, code) {
  let error;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ModuleScaffoldError);
  expect(error.code).toBe(code);
  return error;
}

describe("planModuleScaffold", () => {
  test("is deterministic and hashes the sorted tree", () => {
    const first = plan({ display_name: "Zákaznický portál", teams: ["web"] });
    const second = plan({ display_name: "Zákaznický portál", teams: ["web"] });
    expect(second).toEqual(first);
    expect(first.tree_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(moduleScaffoldTreeHash([...first.files].reverse())).toBe(first.tree_hash);
    expect(first.files.map((file) => file.path)).toEqual([...first.files.map((file) => file.path)].sort());
    expect(plan({ display_name: "Jiný portál", teams: ["web"] }).tree_hash).not.toBe(first.tree_hash);
    expect(first.schema_version).toBe("lazurio.module_scaffold.plan.v1");
    expect(first.generated_by_install).toEqual(["app/v1/bun.lock"]);
  });

  test("allocates the slug-derived free pool port and writes the exact slot", () => {
    const result = plan({ display_name: "Zákaznický portál", teams: ["web"] });
    expect(result.lease).toEqual({ id: "main", host: "127.0.0.1", port: 24_009 });
    expect(result.slot).toEqual({
      path: "workspace/portal",
      slug: "portal",
      space: "workspace",
      teams: ["web"],
      category: "application",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "git-native",
      status: "active",
      notes: "Zákaznický portál: Modul založený příkazem lazurio module create (stack vite-react).",
      git: { url: "git@github.com:AcmeHQ/portal.git", branch: "main" },
    });
    const manifest = JSON.parse(file(result, "lazurio.module.json"));
    expect(manifest).toEqual({
      schema_version: "lazurio.module.v1",
      id: "portal",
      company: "Acme",
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port: 24_009 }],
      apps: ["app/v1/package.json"],
      default_app: "app/v1/package.json",
    });
    expect(plan({ port: 24_050 }).lease.port).toBe(24_050);
    expect(plan().slot.teams).toBeUndefined();
  });

  test("two different slugs against the same Organization state get different ports", () => {
    // Two work branches cannot see each other's unmerged Module; the default
    // starts at pool.start + (sha256(slug)[0..4] mod pool size), so they no
    // longer both take the lowest free port. Exact values pin the algorithm.
    const portal = plan({ slug: "portal" });
    const crm = plan({ slug: "crm" });
    expect(portal.lease.port).toBe(24_009);
    expect(crm.lease.port).toBe(24_003);
    expect(plan({ slug: "helpdesk" }).lease.port).toBe(24_027);
    // The hashed start is taken by another lease: walk forward to the next free port.
    expect(plan({ slug: "portal", organization: { ...organization, existing_leases: [
      ...organization.existing_leases,
      { company: "Acme", module: "shop", port: 24_009 },
      { company: "Acme", module: "blog", port: 24_010 },
    ] } }).lease.port).toBe(24_011);
  });

  test("the default port wraps around from the pool end to the pool start", () => {
    // "wiki" hashes to offset 96; 24096-24099 are taken, 24000 is billing's.
    const taken = [24_096, 24_097, 24_098, 24_099].map((port, index) => ({ company: "Acme", module: `m${index}`, port }));
    const result = plan({ slug: "wiki", organization: { ...organization, existing_leases: [...organization.existing_leases, ...taken] } });
    expect(result.lease.port).toBe(24_001);
    expect(moduleScaffoldDefaultPort("wiki", pool)).toBe(24_096);
    expect(moduleScaffoldDefaultPort("wiki", pool, new Set([24_096, 24_097, 24_098, 24_099, 24_000]))).toBe(24_001);
    expect(moduleScaffoldDefaultPort("wiki", { start: 24_000, end: 24_000 }, new Set([24_000]))).toBeNull();
  });

  test("the default port is deterministic: same input gives the same port and tree_hash", () => {
    for (const slug of ["portal", "crm", "wiki"]) {
      const first = plan({ slug });
      const second = plan({ slug });
      expect(second.lease).toEqual(first.lease);
      expect(second.tree_hash).toBe(first.tree_hash);
    }
    expect(plan({ slug: "portal" }).tree_hash).not.toBe(plan({ slug: "portal", port: 24_050 }).tree_hash);
  });

  test("every stack renders without leftover placeholders and with valid runtime and preparation", () => {
    for (const stack of MODULE_SCAFFOLD_STACKS) {
      const result = plan({ stack, slug: `x-${stack}` });
      for (const entry of result.files) {
        expect(entry.content.includes("{{"), `${stack}: ${entry.path}`).toBe(false);
        expect(entry.path.includes("{{") || entry.path.endsWith(".tmpl") || /(^|\/)dot-/.test(entry.path)).toBe(false);
      }
      const paths = result.files.map((entry) => entry.path);
      expect(paths).toEqual(expect.arrayContaining(["AGENTS.md", "README.md", ".gitignore", "lazurio.module.json"]));
      if (stack === "none") {
        expect(paths).toEqual([".gitignore", "AGENTS.md", "README.md", "lazurio.module.json"]);
        expect(result.lease).toBeNull();
        expect(result.generated_by_install).toEqual([]);
        continue;
      }
      expect(paths).toEqual(expect.arrayContaining([
        ".github/workflows/check.yml",
        "app/v1/package.json",
      ]));
      const packageJson = JSON.parse(file(result, "app/v1/package.json"));
      expect(packageJson.packageManager).toBe(`bun@${bunVersion}`);
      expect(validateAgainstSchema(packageJson.lazurio.runtime, runtimeSchema, "runtime")).toEqual([]);
      expect(validateAgainstSchema(packageJson.lazurio.preparation, preparationSchema, "preparation")).toEqual([]);
      expect(packageJson.lazurio.runtime.id).toBe(`acme-x-${stack}-v1`);
      expect(packageJson.scripts.check).toBeString();
      expect(packageJson.scripts.test).toBeString();
      if (stack === "python-uv") {
        expect(packageJson.lazurio.preparation).toMatchObject({ runtime: "uv", uv_version: DEFAULT_SCAFFOLD_VERSIONS.uv });
        expect(result.generated_by_install).toEqual(["app/v1/uv.lock"]);
      } else {
        expect(packageJson.lazurio.preparation.runtime).toBeUndefined();
        expect(packageJson.dependencies["@lazurio/module-kit"]).toBe(`github:Lazurio/module-kit#v${DEFAULT_SCAFFOLD_VERSIONS.module_kit}`);
        expect(paths).toContain("app/v1/tests/start.test.ts");
        expect(file(result, ".github/workflows/check.yml")).toContain("bun install --frozen-lockfile");
      }
    }
  });

  test("the Python declaration in pyproject.toml equals the one Core reads from package.json", () => {
    const result = plan({ stack: "python-uv", slug: "data-sync" });
    const pyproject = Bun.TOML.parse(file(result, "app/v1/pyproject.toml"));
    const packageJson = JSON.parse(file(result, "app/v1/package.json"));
    expect(pyproject.tool.lazurio).toEqual(packageJson.lazurio);
    expect(pyproject.project.scripts).toEqual({ "data-sync": "data_sync.server:main" });
    expect(packageJson.scripts.dev).toBe("uv run --no-sync data-sync");
    expect(result.files.map((entry) => entry.path)).toContain("app/v1/src/data_sync/server.py");
    expect(result.warnings[0]).toContain("MS-04");
  });

  test("refuses invalid input with stable codes", () => {
    expectCode(() => plan({ stack: "next" }), "unknown_stack");
    for (const slug of ["Portal", "portal-", "-portal", "por--tal", "9portal", "portal_x", "a".repeat(51), ""]) {
      expectCode(() => plan({ slug }), "invalid_slug");
    }
    for (const slug of ["productionspace", "personalspace", "mission-control", "launchpad"]) {
      expectCode(() => plan({ slug }), "reserved_slug");
    }
    for (const display_name of ["", "   ", "Portál \"x\"", "<b>", "a{{slug}}", "x".repeat(81), "line\nbreak"]) {
      expectCode(() => plan({ display_name }), "invalid_display_name");
    }
    expectCode(() => plan({ teams: ["Web"] }), "invalid_team");
    expectCode(() => plan({ teams: ["web", "web"] }), "invalid_team");
    expectCode(() => plan({ teams: ["sales"] }), "unknown_team");
    expectCode(() => plan({ organization: { ...organization, github_org: undefined } }), "invalid_organization");
    expectCode(() => plan({ versions: { ...versions, bun: "latest" } }), "invalid_versions");
    expectCode(() => plan({ slug: "billing" }), "slot_exists");
    expectCode(() => plan({ organization: { ...organization, existing_slots: [{ path: "workspace/Portal" }] } }), "slot_exists");
    expectCode(() => plan({ organization: { ...organization, module_port_pool: null } }), "pool_missing");
    expectCode(() => plan({ stack: "none", port: 24_010 }), "port_not_allowed");
    expectCode(() => plan({ port: 23_999 }), "port_outside_pool");
    expectCode(() => plan({ port: 24_000 }), "port_taken");
    const full = Array.from({ length: 100 }, (_, index) => ({ company: "Other", module: `m${index}`, port: 24_000 + index }));
    expectCode(() => plan({ organization: { ...organization, existing_leases: full } }), "pool_exhausted");
    const broken = { layers: { ...templates.layers, none: [{ path: "README.md", content: "{{unknown}}" }] } };
    expectCode(() => plan({ stack: "none", templates: broken }), "template_invalid");
    const escaping = { layers: { ...templates.layers, none: [{ path: "../README.md", content: "x" }] } };
    expectCode(() => plan({ stack: "none", templates: escaping }), "template_invalid");
  });

  test("the none stack is the no-app Module without a lease even without a pool", () => {
    const result = plan({ stack: "none", organization: { ...organization, module_port_pool: null } });
    expect(JSON.parse(file(result, "lazurio.module.json"))).toEqual({
      schema_version: "lazurio.module.v1",
      id: "portal",
      company: "Acme",
      tcp_port_policy: { mode: "none" },
      port_leases: [],
      apps: [],
    });
    expect(result.slot.category).toBe("workspace");
  });

  test("template names map dot- segments and drop .tmpl", () => {
    expect(templateTargetPath("dot-github/workflows/check.yml")).toBe(".github/workflows/check.yml");
    expect(templateTargetPath("dot-gitignore")).toBe(".gitignore");
    expect(templateTargetPath("app/v1/tests/start.test.ts.tmpl")).toBe("app/v1/tests/start.test.ts");
    expect(templateTargetPath("app/v1/src/dotenv.ts")).toBe("app/v1/src/dotenv.ts");
  });
});

describe("insertModuleSlotText", () => {
  const slot = { path: "workspace/portal", slug: "portal", required_roles: ["*"] };

  test("adds the slot after the last workspace slot and keeps every other byte", () => {
    const text = [
      "{",
      "  \"company\": \"Acme\",",
      "  \"module_slots\": [",
      "    { \"path\": \"infra\", \"required_roles\": [\"admin\"] },",
      "    {",
      "      \"path\": \"workspace/billing\",",
      "      \"required_roles\": [\"*\"]",
      "    },",
      "    {\"path\": \"productionspace/firmware\", \"required_roles\": []}",
      "  ],",
      "  \"notes\": \"ž\"",
      "}",
      "",
    ].join("\n");
    const next = insertModuleSlotText(text, slot);
    const inserted = [
      ",",
      "    {",
      "      \"path\": \"workspace/portal\",",
      "      \"slug\": \"portal\",",
      "      \"required_roles\": [",
      "        \"*\"",
      "      ]",
      "    }",
    ].join("\n");
    const anchor = text.indexOf("    },\n    {\"path\": \"productionspace") + "    }".length;
    expect(next).toBe(`${text.slice(0, anchor)}${inserted}${text.slice(anchor)}`);
    expect(JSON.parse(next).module_slots.map((item) => item.path)).toEqual([
      "infra",
      "workspace/billing",
      "workspace/portal",
      "productionspace/firmware",
    ]);
  });

  test("appends without a workspace slot and fills an empty array", () => {
    const withoutWorkspace = "{\n  \"module_slots\": [\n    { \"path\": \"infra\" }\n  ]\n}\n";
    expect(JSON.parse(insertModuleSlotText(withoutWorkspace, slot)).module_slots.at(-1)).toEqual(slot);
    const empty = "{\n  \"company\": \"Acme\",\n  \"module_slots\": []\n}\n";
    expect(insertModuleSlotText(empty, slot)).toBe(
      "{\n  \"company\": \"Acme\",\n  \"module_slots\": [\n    {\n      \"path\": \"workspace/portal\",\n      \"slug\": \"portal\",\n      \"required_roles\": [\n        \"*\"\n      ]\n    }\n  ]\n}\n",
    );
  });

  test("refuses a manifest without module_slots", () => {
    expectCode(() => insertModuleSlotText("{\"company\": \"Acme\"}", slot), "manifest_invalid");
    expectCode(() => insertModuleSlotText("not json", slot), "manifest_invalid");
  });
});

describe("generated Modules pass the Lazurio Module Standard", () => {
  for (const stack of MODULE_SCAFFOLD_STACKS) {
    test(`${stack}`, async () => {
      const fixture = await materialize(stack);
      const report = await setupModule({ lazurioRoot: fixture.lazurioRoot, moduleRoot: fixture.moduleRoot });
      const notPassing = report.standard.checks.filter((check) => check.status !== "pass");
      if (stack === "python-uv") {
        // Core does not read [tool.lazurio] yet and does not lint Python; both
        // stay warn until the Platform uv adapter (DEV-6634 W0-5).
        expect(notPassing.map((check) => [check.id, check.status])).toEqual([["MS-04", "warn"], ["MS-08", "warn"]]);
        expect(report).toMatchObject({ status: "action_required", reason: "module_standard_nonconformant" });
      } else {
        expect(notPassing).toEqual([]);
        expect(report).toMatchObject({ status: "current", reason: "module_contract_current", changes: [], issues: [] });
      }
      expect(report.standard.checks).toHaveLength(13);
    });
  }
});

function file(result, path) {
  const entry = result.files.find((item) => item.path === path);
  if (!entry) throw new Error(`${path} is not in the plan`);
  return entry.content;
}

// Writes the plan of one stack into a scratch Organization as `lazurio module
// create` would, with a lockfile that mirrors package.json instead of a real
// install (no network in tests), and commits it.
async function materialize(stack) {
  const lazurioRoot = await tempRoot(`lazurio-scaffold-${stack}-`);
  const organizationRoot = join(lazurioRoot, "organizations", "Acme_GEN3");
  const slug = `demo-${stack}`;
  const result = planModuleScaffold({
    organization: { slug: "Acme", github_org: "AcmeHQ", module_port_pool: pool, existing_slots: [], existing_leases: [] },
    slug,
    stack,
    templates,
    versions,
  });
  await writeJson(join(organizationRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "Acme", display_name: "Acme", github_org: "AcmeHQ" },
    module_port_pool: pool,
  });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "Acme",
    github_org: "AcmeHQ",
    module_slots: [result.slot],
  });
  const moduleRoot = join(organizationRoot, "workspace", slug);
  for (const entry of result.files) await writeText(join(moduleRoot, ...entry.path.split("/")), entry.content);
  for (const lockPath of result.generated_by_install) {
    const packageJson = JSON.parse(await readFile(join(moduleRoot, "app", "v1", "package.json"), "utf8"));
    await writeText(join(moduleRoot, ...lockPath.split("/")), lockPath.endsWith("bun.lock")
      ? `${JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          "": {
            name: packageJson.name,
            ...(packageJson.dependencies ? { dependencies: packageJson.dependencies } : {}),
            ...(packageJson.devDependencies ? { devDependencies: packageJson.devDependencies } : {}),
          },
        },
        packages: {},
      }, null, 2)}\n`
      : "version = 1\nrequires-python = \">=3.12\"\n");
  }
  git(moduleRoot, ["init", "--quiet", "--initial-branch=main"]);
  git(moduleRoot, ["add", "--all"]);
  git(moduleRoot, ["-c", "user.name=Lazurio Test", "-c", "user.email=lazurio-test@example.invalid", "commit", "--quiet", "-m", "scaffold"]);
  return { lazurioRoot, moduleRoot };
}

function git(cwd, args) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeJson(path, value) {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
