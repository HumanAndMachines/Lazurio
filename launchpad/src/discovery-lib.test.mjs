import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "fs/promises";
import {
  discoverLaunchpadApps,
  organizationRelativePathIssue,
  organizationRepositoryPathCasingIssue,
  runtimeLoadedEnvFileSelection,
  runtimeScriptPortAuthorityIssues,
  runtimeSourcePortAuthorityIssues,
} from "../../lazurio/runtime/discovery-lib.mjs";
import {
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
} from "../../lazurio/core/organization-activation-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("discovery načte read-only plugin metadata", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
      summary: "Read-only metadata pro Launchpad.",
      metadata: [
        {
          label: "Source of truth",
          value: "Git filesystem database",
        },
      ],
      links: [
        {
          label: "Manuál",
          kind: "manual",
          path: "modules/demo/app/v1/README.md",
        },
      ],
      sections: [
        {
          title: "Poznámka",
          body: "Plugin nespouští kód.",
        },
      ],
    },
  });
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps[0].plugin).toMatchObject({
    schema_version: "companyascode.launchpad_plugin.v1",
    title: "Demo kontext",
    path: "organizations/TestCompany/modules/demo/app/v1/launchpad.plugin.json",
  });
  expect(apps[0].cwd).toBe("organizations/TestCompany/modules/demo/app/v1");
  expect(apps[0].plugin.links[0].path).toBe("modules/demo/app/v1/README.md");
});

test("discovery přenese builder metadata icon/description/group z manifestu", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: {
      icon: "control",
      description: "Denní přehled a spuštění firemních aplikací.",
      group: "Denní práce",
    },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps[0].icon).toBe("control");
  expect(apps[0].description).toBe("Denní přehled a spuštění firemních aplikací.");
  expect(apps[0].group).toBe("Denní práce");
});

test.skipIf(process.platform === "win32")("Organization discovery izoluje Module manifest odkazující mimo přesný checkout", async () => {
  const root = await createCompaniesWorkspaceFixture({ plugin: null });
  const companyRoot = join(root, "organizations", "TestCompany");
  const moduleRoot = join(companyRoot, "modules", "demo");
  const packagePath = join(moduleRoot, "app", "v1", "package.json");
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [{
      path: "modules/demo",
      slug: "demo",
      git: { url: "git@github.com:TestCompany/demo.git", branch: "main" },
    }],
  });
  await writeJson(packagePath, {
    name: "test-company-demo-v1",
    private: true,
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "test-company-demo-v1",
        title: "Demo v1",
        company: "test-company",
        module: "demo",
        surface: "internal",
        dev_script: "dev",
        listeners: [{
          id: "web",
          role: "entrypoint",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/health" },
        }],
      },
    },
  });
  const manifestPath = join(moduleRoot, "lazurio.module.json");
  await writeJson(manifestPath, {
    schema_version: "lazurio.module.v1",
    id: "demo",
    company: "test-company",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 4242 }],
  });
  const foreignManifest = join(companyRoot, "foreign-module.json");
  await rename(manifestPath, foreignManifest);
  await symlink(foreignManifest, manifestPath, "file");

  const result = await discoverLaunchpadApps(root);
  expect(result.apps).toHaveLength(0);
  expect(result.invalid_apps).toHaveLength(1);
  expect(result.invalid_apps[0].manifest_issues.join("\n")).toContain("odkazuje mimo vybraný checkout");
});

test.skipIf(process.platform === "win32")("Organization root authority JSON nesmí odkazovat mimo přesný mount", async () => {
  for (const fileName of ["company.gen3.json", "modules.manifest.json"]) {
    const root = await createCompaniesWorkspaceFixture({ plugin: null });
    const companyRoot = join(root, "organizations", "TestCompany");
    const targetPath = join(companyRoot, fileName);
    const foreignPath = join(root, `foreign-${fileName}`);
    await rename(targetPath, foreignPath);
    await symlink(foreignPath, targetPath, "file");

    const result = await discoverLaunchpadApps(root);
    expect(result.apps).toHaveLength(0);
    expect(result.failures.join("\n")).toContain(fileName);
    expect(result.failures.join("\n")).toContain("odkazuje mimo vybraný checkout");
  }
});

test("discovery bez builder metadata dá null fallback bez failure", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps[0].icon).toBeNull();
  expect(apps[0].description).toBeNull();
  expect(apps[0].group).toBeNull();
});

test("discovery je warning-first u vadného builder metadata, appka zůstává validní", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: {
      description: "x".repeat(500),
      group: "   ",
    },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  // Appka zůstává v apps (ne v invalid_apps) — warning-first.
  expect(apps).toHaveLength(1);
  // Prázdný group spadne na null; příliš dlouhý description dostane varování.
  expect(apps[0].group).toBeNull();
  expect(warnings.some((warning) => warning.includes("description") && warning.includes("builder metadata"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("group") && warning.includes("builder metadata"))).toBe(true);
});

test("discovery přenese production_url (PROD run) z manifestu", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: { production_url: "https://deals.omegaco.com" },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps[0].production_url).toBe("https://deals.omegaco.com");
});

test("discovery bez production_url dá null (honest disabled PROD stub)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps[0].production_url).toBeNull();
});

test("discovery je warning-first u nevalidní production_url, appka zůstává validní", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: { production_url: "deals.omegaco.com" },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toHaveLength(1);
  expect(apps[0].production_url).toBeNull();
  expect(warnings.some((warning) => warning.includes("production_url") && warning.includes("builder metadata"))).toBe(true);
});

test("discovery fail-closed na malformed production_url (review P1 2026-07-16)", async () => {
  for (const value of ["https://", "http://[", "https:// user", "https://?x"]) {
    const root = await createCompaniesWorkspaceFixture({
      plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
      appOverrides: { production_url: value },
    });
    const { apps, failures } = await discoverLaunchpadApps(root);
    expect(failures).toEqual([]);
    expect(apps[0].production_url).toBeNull();
  }
});

test("discovery přeskočí adresář bez company.gen3.json bez failure (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  // Holý adresář bez markeru (rozdělaný checkout, pracovní složka) není
  // Organizace → skenem se přeskočí, nikdy jako failure (decision 0042).
  await mkdir(join(root, "organizations", "JustAFolder"), { recursive: true });
  await writeFile(join(root, "organizations", "JustAFolder", "note.md"), "# nic", "utf8");

  const { apps, organizations, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps).toHaveLength(1);
  expect(organizations.map((organization) => organization.slug)).toEqual(["test-company"]);
});

test("discovery podporuje Mission Control data-repo cutover bez root task ledgerů", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  for (const ledger of ["TODO.tasks.json", "DONE.tasks.json", "ISSUES.open.json"]) {
    await rm(join(root, "organizations", "TestCompany", ledger), { force: true });
  }

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toHaveLength(1);
});

test("legacy registry klíče se ignorují s jedním deprecation warningem, ne failure (scan-first)", async () => {
  const root = await createGenerationMountFixture();
  // Stale lokální kopie sdíleného configu ještě nese registry klíče, včetně
  // Organizace, která na disku VŮBEC není namountovaná.
  const config = await Bun.file(join(root, "launchpad.gen3.json")).json();
  config.organizations = [
    { slug: "GhostOrg", display_name: "Ghost", path: "organizations/GhostOrg_GEN3" },
  ];
  config.templates = [
    { slug: "mission-control-template", template_type: "module", path: "templates/x/MissionControlTemplate" },
  ];
  await writeJson(join(root, "launchpad.gen3.json"), config);

  const { organizations, failures, warnings } = await discoverLaunchpadApps(root);

  // Registry se ignoruje: chybějící mount NIKDY není failure a duch z registru se neobjeví.
  expect(failures).toEqual([]);
  expect(organizations.some((organization) => organization.slug === "GhostOrg")).toBe(false);
  // Jen jeden deprecation warning zmíní zastaralé klíče.
  const deprecation = warnings.filter((warning) => warning.includes("zastaralé registry klíče"));
  expect(deprecation).toHaveLength(1);
  expect(deprecation[0]).toContain("organizations");
  expect(deprecation[0]).toContain("templates");
  // Skutečné Organizace se dál objeví skenem disku.
  expect(organizations.some((organization) => organization.slug === "DemoCo")).toBe(true);
});

test("discovery podporuje _GEN3 mount cesty při čisté interní identitě Organizace", async () => {
  const root = await createGenerationMountFixture();
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => [app.company, app.organization_path, app.package_path])).toEqual([
    [
      "BetaCo",
      "organizations/BetaCo_GEN3",
      "organizations/BetaCo_GEN3/mission-control/app/v2/package.json",
    ],
    [
      "DemoCo",
      "organizations/DemoCo_GEN3",
      "organizations/DemoCo_GEN3/mission-control/app/v1/package.json",
    ],
  ]);
});

test("proper-case company je přesná identita, ale app id musí zůstat lowercase", async () => {
  const root = await createGenerationMountFixture();
  const packagePath = join(
    root,
    "organizations",
    "BetaCo_GEN3",
    "mission-control",
    "app",
    "v2",
    "package.json",
  );
  const packageJson = await Bun.file(packagePath).json();
  packageJson.companyascode.app.id = "BetaCo-mission-control-v2";
  await writeJson(packagePath, packageJson);

  const { apps, invalid_apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => [app.id, app.company])).toEqual([
    ["democo-mission-control-v1", "DemoCo"],
  ]);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0]).toMatchObject({
    id: "BetaCo-mission-control-v2",
    company: "BetaCo",
    manifest_state: "invalid_manifest",
  });
  expect(invalid_apps[0].manifest_issues.join("\n")).toContain(
    "companyascode.app.id neodpovídá patternu ^[a-z0-9]+(-[a-z0-9]+)*$",
  );
});

test("discovery načte root shared Guide local surface jako Launchpad app", async () => {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-shared-guide-"));
  tempRoots.push(root);
  const guideAppRoot = join(root, "guide", "app", "v1");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  await mkdir(guideAppRoot, { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "conglomerate",
      display_name: "Lazurio",
      root_role: "launchpad-root",
    },
    local_surfaces: [
      {
        path: "guide",
        kind: "shared-guide",
        authority: "read-only-view",
      },
    ],
  });
  await writeJson(join(guideAppRoot, "package.json"), {
    name: "conglomerate-guide-v1",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "conglomerate-guide-v1",
        title: "Guide GEN3",
        company: "conglomerate",
        module: "guide",
        surface: "manual",
        port: 5281,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["guide", "onboarding", "first-client"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => [app.id, app.company, app.organization_path, app.package_path])).toContainEqual([
    "conglomerate-guide-v1",
    "conglomerate",
    "guide",
    "guide/app/v1/package.json",
  ]);
});

test("discovery automaticky načte lokálně naklonovanou Organization bez registry entry", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OmegaCo_GEN3",
    company: "OmegaCo",
    appDir: "mission-control/app/v3",
    appId: "omegaco-mission-control-v3",
    port: 5293,
  });

  const { apps, failures, organizations } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(organizations.map((organization) => [
    organization.slug,
    organization.path,
    organization.discovery_source,
  ])).toContainEqual([
    "OmegaCo",
    "organizations/OmegaCo_GEN3",
    "filesystem",
  ]);
  expect(apps.map((app) => [app.company, app.organization_path, app.package_path])).toContainEqual([
    "OmegaCo",
    "organizations/OmegaCo_GEN3",
    "organizations/OmegaCo_GEN3/mission-control/app/v3/package.json",
  ]);
});

test("discovery ignoruje organization-local worktree checkouty", async () => {
  const root = await createGenerationMountFixture();
  const worktreeAppRoot = join(
    root,
    "organizations",
    "BetaCo_GEN3",
    ".worktrees",
    "DEV-0028-invoices-deals-link",
    "mission-control",
    "app",
    "v2",
  );
  await mkdir(worktreeAppRoot, { recursive: true });
  await writeJson(join(worktreeAppRoot, "package.json"), {
    name: "betaco-mission-control-v2-worktree-copy",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "betaco-mission-control-v2",
        title: "Mission Control",
        company: "BetaCo",
        module: "mission-control",
        surface: "internal",
        port: 5392,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.package_path)).toEqual([
    "organizations/BetaCo_GEN3/mission-control/app/v2/package.json",
    "organizations/DemoCo_GEN3/mission-control/app/v1/package.json",
  ]);
});

test("discovery ignoruje skryté nekanonické workspace checkouty, takže nemohou vyhrát duplicitní app id", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  const canonicalAppRoot = join(companyRoot, "workspace", "warehouse", "app", "v1");
  const hiddenAppRoot = join(companyRoot, "workspace", ".warehouse-pr41-buddy-review", "app", "v1");
  const packageJson = {
    name: "test-company-warehouse-v1",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-warehouse-v1",
        title: "Warehouse v1",
        company: "test-company",
        module: "warehouse",
        surface: "internal",
        port: 4361,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["warehouse"],
      },
    },
  };
  await mkdir(canonicalAppRoot, { recursive: true });
  await mkdir(hiddenAppRoot, { recursive: true });
  await writeJson(join(canonicalAppRoot, "package.json"), packageJson);
  await writeJson(join(hiddenAppRoot, "package.json"), packageJson);

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(invalid_apps).toEqual([]);
  expect(apps.find((app) => app.id === "test-company-warehouse-v1")?.package_path).toBe(
    "organizations/TestCompany/workspace/warehouse/app/v1/package.json",
  );
  expect(apps.some((app) => app.package_path.includes(".warehouse-pr41-buddy-review"))).toBe(false);
});

test("discovery izoluje nevalidní app manifest jako invalid_apps záznam (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const staleAppRoot = join(root, "organizations", "TestCompany", "modules", "stale", "app", "v1");
  await mkdir(staleAppRoot, { recursive: true });
  await writeJson(join(staleAppRoot, "package.json"), {
    name: "stale-app",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "stale-app-v1",
        title: "Stale app",
        company: "workspace",
        module: "stale",
        surface: "internal",
        port: 4243,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["stale"],
      },
    },
  });

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Nevalidní manifest nesmí být root failure — izoluje jen dotčenou appku.
  expect(failures).toEqual([]);
  expect(warnings.some((warning) => warning.includes("invalid app manifest"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("companyascode.app.company musí být test-company"))).toBe(true);
  expect(apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0]).toMatchObject({
    id: "stale-app-v1",
    company: "test-company",
    manifest_state: "invalid_manifest",
    package_path: "organizations/TestCompany/modules/stale/app/v1/package.json",
  });
  expect(invalid_apps[0].manifest_issues.length).toBeGreaterThan(0);
});

test("discovery izoluje app.id bez lowercase Organization prefixu", async () => {
  const root = await createCompaniesWorkspaceFixture({
    appOverrides: {
      id: "lazurio-website-v1",
      company: "test-company",
    },
  });

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toEqual([]);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0]).toMatchObject({
    id: "lazurio-website-v1",
    company: "test-company",
    manifest_state: "invalid_manifest",
  });
  expect(invalid_apps[0].manifest_issues).toContain(
    "organizations/TestCompany/modules/demo/app/v1/package.json: companyascode.app.id musí začínat Organization prefixem test-company-",
  );
  expect(warnings.some((warning) => warning.includes("invalid app manifest"))).toBe(true);
});

test("deklarovaný port overlap zachová obě auto-discovered Organizace", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OmegaCo_GEN3",
    company: "OmegaCo",
    appDir: "mission-control/app/v3",
    appId: "omegaco-mission-control-v3",
    port: 5392, // stejný stabilní port jako BetaCo mission-control v2 z registry
  });
  await writeGenerationOrg({
    root,
    path: "organizations/Zeta_GEN3",
    company: "Zeta",
    appDir: "mission-control/app/v1",
    appId: "zeta-mission-control-v1",
    port: 5393,
  });

  const { apps, failures, organizations, port_overlaps: portOverlaps } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(
    organizations.some(
      (organization) => organization.slug === "OmegaCo" && organization.discovery_source === "filesystem",
    ),
  ).toBe(true);
  expect(apps.map((app) => app.id)).toContain("omegaco-mission-control-v3");
  const overlap = portOverlaps.find((item) => item.port === 5392);
  expect(overlap?.owners.map((owner) => owner.app_id).sort()).toEqual([
    "betaco-mission-control-v2",
    "omegaco-mission-control-v3",
  ]);
  expect(overlap?.owners.map((owner) => owner.package_path)).toContain(
    "organizations/OmegaCo_GEN3/mission-control/app/v3/package.json",
  );
  expect(portOverlaps.some((item) => item.port === 5393)).toBe(false);
  expect(apps.find((app) => app.id === "omegaco-mission-control-v3")?.shared_port_owners).toEqual([]);
});

test("intra-Organization port collision zachová oba moduly a vrátí warning evidence", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/BetaCo_GEN3",
    company: "BetaCo",
    appDir: "warehouse/app/v1",
    appId: "betaco-warehouse-v1",
    port: 5392,
  });

  const { apps, failures, port_overlaps: portOverlaps } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.some((app) => app.id === "betaco-mission-control-v2")).toBe(true);
  expect(apps.some((app) => app.id === "betaco-warehouse-v1")).toBe(true);
  expect(portOverlaps.find((overlap) => overlap.port === 5392)).toMatchObject({
    classification: "legacy-overlap",
    conflict: true,
  });
});

test("lazurio.runtime.v1 discovers one entrypoint and auxiliary listeners", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const packagePath = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1", "package.json");
  const packageJson = await Bun.file(packagePath).json();
  delete packageJson.companyascode;
  packageJson.scripts.api = "bun api.mjs";
  packageJson.lazurio = {
    runtime: {
      schema_version: "lazurio.runtime.v1",
      id: "test-company-demo-v1",
      title: "Demo",
      company: "test-company",
      module: "demo",
      surface: "internal",
      dev_script: "dev",
      tags: ["demo"],
      listeners: [
        {
          id: "web",
          role: "entrypoint",
          lease: "web",
          protocol: "http",
          health: { kind: "http", path: "/health" },
        },
        {
          id: "api",
          role: "auxiliary",
          lease: "api",
          protocol: "http",
          health: { kind: "http", path: "/api/health" },
        },
      ],
    },
  };
  await writeJson(packagePath, packageJson);
  await writeJson(join(root, "organizations", "TestCompany", "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [{
      path: "modules/demo",
      slug: "demo",
      git: { url: "git@github.com:TestCompany/demo.git", branch: "main" },
    }],
  });
  const organizationManifestPath = join(root, "organizations", "TestCompany", "company.gen3.json");
  const organizationManifest = await Bun.file(organizationManifestPath).json();
  organizationManifest.module_port_pool = { start: 4300, end: 4399 };
  await writeJson(organizationManifestPath, organizationManifest);
  await writeJson(join(root, "organizations", "TestCompany", "modules", "demo", "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "demo",
    company: "test-company",
    tcp_port_policy: {
      mode: "exception",
      reason: "Fixture exercises an explicit split listener runtime contract.",
    },
    port_leases: [
      { id: "web", host: "127.0.0.1", port: 4350 },
      { id: "api", host: "127.0.0.1", port: 4351 },
    ],
  });

  const result = await discoverLaunchpadApps(root);
  expect(result.failures).toEqual([]);
  expect(result.apps[0]).toMatchObject({
    port: 4350,
    health_path: "/health",
    runtime_contract: { schema_version: "lazurio.runtime.v1", legacy: false },
  });
  expect(result.apps[0].listeners.map((listener) => listener.id)).toEqual(["web", "api"]);
  expect(result.listener_owners.map((owner) => [owner.listener_id, owner.port])).toEqual([
    ["web", 4350],
    ["api", 4351],
  ]);

  const nestedModulePath = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1", "lazurio.module.json");
  await writeJson(nestedModulePath, {
    schema_version: "lazurio.module.v1",
    id: "demo",
    company: "test-company",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "web", host: "127.0.0.1", port: 4352 }],
  });
  const shadowed = await discoverLaunchpadApps(root);
  expect(shadowed.failures.join("\n")).toContain(
    "nested lazurio.module.json nesmí zastínit module-root lease",
  );
  await rm(nestedModulePath);

  const runtimeSourcePath = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1", "server.mjs");
  await writeFile(runtimeSourcePath, "Bun.serve({ port: 4351 });\n", "utf8");
  const sourceDrift = await discoverLaunchpadApps(root);
  expect(sourceDrift.invalid_apps).toHaveLength(0);
  expect(sourceDrift.failures).toEqual([]);
  expect(sourceDrift.warnings.join("\n")).toContain(
    "server.mjs: runtime source kopíruje module lease port 4351",
  );
  expect(sourceDrift.warnings.join("\n")).toContain("bounded legacy source diagnostic");

  await writeFile(
    runtimeSourcePath,
    "Bun.serve({ port: Number(process.env.PORT ?? 5281) });\n",
    "utf8",
  );
  const staleFallback = await discoverLaunchpadApps(root);
  expect(staleFallback.invalid_apps).toHaveLength(0);
  expect(staleFallback.warnings.join("\n")).toContain(
    "server.mjs: runtime source obsahuje číselný port fallback 5281",
  );

  await writeFile(
    runtimeSourcePath,
    "Bun.serve({ port: Number(process.env.PORT) || 5282 });\n",
    "utf8",
  );
  const coercedFallback = await discoverLaunchpadApps(root);
  expect(coercedFallback.invalid_apps).toHaveLength(0);
  expect(coercedFallback.warnings.join("\n")).toContain(
    "server.mjs: runtime source obsahuje číselný port fallback 5282",
  );

  await writeFile(
    runtimeSourcePath,
    'const manifest = await Bun.file("../../lazurio.module.json").json();\nconst listener = manifest.port_leases.find(({ id }) => id === "web");\nBun.serve({ port: listener.port, hostname: listener.host });\n',
    "utf8",
  );
  const envDirectory = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const inactiveEnvPath = join(envDirectory, ".env.test");
  const activeEnvPath = join(envDirectory, ".env.development");
  const envSource = "SECRET=value\nPORT=5283\nLAZURIO_RUNTIME_LISTENER_WEB_HOST=0.0.0.0\n";
  await writeFile(inactiveEnvPath, envSource, "utf8");
  const inactiveEnv = await discoverLaunchpadApps(root);
  expect(inactiveEnv.invalid_apps).toHaveLength(0);
  expect(inactiveEnv.failures.join("\n")).not.toContain(".env.test");

  await writeFile(activeEnvPath, envSource, "utf8");
  const envAuthority = await discoverLaunchpadApps(root);
  expect(envAuthority.invalid_apps).toHaveLength(1);
  expect(envAuthority.failures.join("\n")).toContain(
    ".env.development: PORT nesmí být per-machine port autorita",
  );
  expect(envAuthority.failures.join("\n")).toContain(
    ".env.development: LAZURIO_RUNTIME_LISTENER_WEB_HOST nesmí být per-machine port autorita",
  );
  expect(envAuthority.failures.join("\n")).not.toContain("SECRET=value");
  await rm(activeEnvPath);
  await rm(inactiveEnvPath);

  const dottedModeEnvPath = join(envDirectory, ".env.staging.prod");
  await writeFile(dottedModeEnvPath, envSource, "utf8");
  packageJson.scripts.dev = "NODE_ENV=staging.prod bun server.mjs";
  await writeJson(packagePath, packageJson);
  const dottedModeAuthority = await discoverLaunchpadApps(root);
  expect(dottedModeAuthority.invalid_apps).toHaveLength(1);
  expect(dottedModeAuthority.failures.join("\n")).toContain(
    ".env.staging.prod: PORT nesmí být per-machine port autorita",
  );
  await rm(dottedModeEnvPath);

  const shorthandModeEnvPath = join(envDirectory, ".env.shortcut");
  await writeFile(shorthandModeEnvPath, envSource, "utf8");
  packageJson.scripts.dev = 'concurrently "npm:dev:web"';
  packageJson.scripts["dev:web"] = "vite --mode shortcut";
  await writeJson(packagePath, packageJson);
  const shorthandModeAuthority = await discoverLaunchpadApps(root);
  expect(shorthandModeAuthority.invalid_apps).toHaveLength(1);
  expect(shorthandModeAuthority.failures.join("\n")).toContain(
    ".env.shortcut: PORT nesmí být per-machine port autorita",
  );
  await rm(shorthandModeEnvPath);
  delete packageJson.scripts["dev:web"];

  const nestedEnvDirectory = join(envDirectory, "config");
  const nestedEnvPath = join(nestedEnvDirectory, "runtime.env");
  await mkdir(nestedEnvDirectory, { recursive: true });
  await writeFile(nestedEnvPath, envSource, "utf8");
  packageJson.scripts.dev = "bun --env-file=config/runtime.env server.mjs";
  await writeJson(packagePath, packageJson);
  const explicitNestedEnv = await discoverLaunchpadApps(root);
  expect(explicitNestedEnv.invalid_apps).toHaveLength(1);
  expect(explicitNestedEnv.failures.join("\n")).toContain(
    "config/runtime.env: PORT nesmí být per-machine port autorita",
  );
  await rm(nestedEnvDirectory, { recursive: true });

  packageJson.scripts.dev = "bun --env-file=../../../outside.env server.mjs";
  await writeJson(packagePath, packageJson);
  const escapedExplicitEnv = await discoverLaunchpadApps(root);
  expect(escapedExplicitEnv.invalid_apps).toHaveLength(1);
  expect(escapedExplicitEnv.failures.join("\n")).toContain(
    "--env-file \"../../../outside.env\" uniká mimo owning Module",
  );

  packageJson.scripts.dev = "vite --port 5281";
  await writeJson(packagePath, packageJson);
  const drift = await discoverLaunchpadApps(root);
  expect(drift.invalid_apps).toHaveLength(1);
  expect(drift.failures.join("\n")).toContain(
    "scripts.dev obsahuje číselný port 5281",
  );
  expect(drift.invalid_apps[0].manifest_issues.join("\n")).toContain(
    "scripts.dev obsahuje číselný port 5281",
  );

  packageJson.scripts.dev = "bun server.mjs";
  delete packageJson.lazurio.runtime.title;
  await writeJson(packagePath, packageJson);
  const appLocalIssue = await discoverLaunchpadApps(root);
  expect(appLocalIssue.failures).toEqual([]);
  expect(appLocalIssue.invalid_apps[0].manifest_issues.join("\n")).toContain(
    "lazurio.runtime.title chybí",
  );

  packageJson.lazurio.runtime.title = "Demo";
  packageJson.lazurio.runtime.listeners[0].port = 4350;
  await writeJson(packagePath, packageJson);
  const inlinePort = await discoverLaunchpadApps(root);
  expect(inlinePort.failures.join("\n")).toContain(
    "lazurio.runtime.listeners[0].port není povolené pole",
  );
});

test("runtime env gate follows the declared dev script closure and exact selected files", () => {
  const packageJson = {
    scripts: {
      dev: "concurrently \"bun run dev:web\" \"bun run dev:api\"",
      "dev:web": "NODE_ENV=staging.prod vite --mode local.offline --env-file=config/runtime.env",
      "dev:api": "bun server.ts",
      test: "vite --mode test",
    },
  };
  const selection = runtimeLoadedEnvFileSelection({
    packageJson,
    runtime: { dev_script: "dev" },
  });
  for (const expected of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.staging.prod",
    ".env.staging.prod.local",
    ".env.local.offline",
    ".env.local.offline.local",
    "config/runtime.env",
  ]) {
    expect(selection.paths.has(expected)).toBe(true);
  }
  expect(selection.paths.has("runtime.env")).toBe(false);
  expect(selection.paths.has(".env.test")).toBe(false);
  expect(selection.issues).toEqual([]);

  const shorthandSelection = runtimeLoadedEnvFileSelection({
    packageJson: {
      scripts: {
        dev: 'concurrently "npm:dev:web" "bun:worker:*"',
        "dev:web": "vite --mode shortcut",
        "worker:api": "NODE_ENV=worker.api bun server.ts",
        "worker:web": "vite --env-file=config/worker.env",
      },
    },
    runtime: { dev_script: "dev" },
  });
  expect(shorthandSelection.paths.has(".env.shortcut")).toBe(true);
  expect(shorthandSelection.paths.has(".env.worker.api")).toBe(true);
  expect(shorthandSelection.paths.has("config/worker.env")).toBe(true);
  expect(shorthandSelection.issues).toEqual([]);

  const unsafe = runtimeLoadedEnvFileSelection({
    packageJson: {
      scripts: {
        dev: "bun --env-file=$ENV_FILE --env-file=/tmp/runtime.env server.ts",
      },
    },
    runtime: { dev_script: "dev" },
  });
  expect(unsafe.issues).toHaveLength(2);
  expect(unsafe.issues.join("\n")).toContain("statická literal cesta");
  expect(unsafe.issues.join("\n")).toContain("relativní k runtime package");

  const unsafeModes = runtimeLoadedEnvFileSelection({
    packageJson: {
      scripts: {
        dev: "NODE_ENV=$RUNTIME_MODE vite --mode=staging..prod",
      },
    },
    runtime: { dev_script: "dev" },
  });
  expect(unsafeModes.issues).toHaveLength(2);
  expect(unsafeModes.issues.join("\n")).toContain('NODE_ENV "$RUNTIME_MODE"');
  expect(unsafeModes.issues.join("\n")).toContain('--mode "staging..prod"');
});

test("runtime script gate checks only the selected dev script closure", () => {
  const packageJson = {
    scripts: {
      dev: 'concurrently "bun run dev:web" "bun run worker"',
      "dev:web": 'vite --host "$HOST" --port "$PORT"',
      worker: "bun server.mjs",
      preview: "vite preview --host %HOST% --port %PORT%",
      "start:windows": "bun --port $env:PORT server.mjs",
      test: 'bun -e "console.log(process.env.PORT)"',
    },
  };
  const issues = runtimeScriptPortAuthorityIssues({
    packageJson,
    packagePath: "app/v1/package.json",
    module: { port_leases: [{ id: "main", host: "127.0.0.1", port: 5693 }] },
    runtime: { dev_script: "dev" },
  });

  expect(issues.join("\n")).toContain("scripts.dev:web používá obecné HOST/PORT");
  expect(issues.join("\n")).not.toContain("scripts.preview používá obecné HOST/PORT");
  expect(issues.join("\n")).not.toContain("scripts.start:windows používá obecné HOST/PORT");
  expect(issues.join("\n")).not.toContain("scripts.test používá obecné HOST/PORT");
});

test("runtime source gate distinguishes its own listener fallback from a named legacy dependency", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "lazurio-runtime-source-"));
  tempRoots.push(packageDirectory);
  await writeFile(
    join(packageDirectory, "server.mjs"),
    "const DEFAULT_PORT = 5693;\nconst WIKI_APP_PORT = 5691;\n",
    "utf8",
  );

  const issues = await runtimeSourcePortAuthorityIssues({
    packageDirectory,
    packagePath: "app/v1/package.json",
    module: { port_leases: [{ id: "main", host: "127.0.0.1", port: 5693 }] },
  });

  expect(issues.join("\n")).toContain("číselný port fallback 5693");
  expect(issues.join("\n")).not.toContain("číselný port fallback 5691");
});

test("duplicitní app id izoluje druhý manifest, první zůstává platný (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const dupAppRoot = join(root, "organizations", "TestCompany", "modules", "dup", "app", "v1");
  await mkdir(dupAppRoot, { recursive: true });
  await writeJson(join(dupAppRoot, "package.json"), {
    name: "dup-app",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-demo-v1", // koliduje s modules/demo
        title: "Duplicate id app",
        company: "test-company",
        module: "dup",
        surface: "internal",
        port: 4360,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["dup"],
      },
    },
  });

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Kolize id nesmí shodit root (decision 0043) — druhý manifest se izoluje.
  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(apps[0].package_path).toBe("organizations/TestCompany/modules/demo/app/v1/package.json");
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0].package_path).toBe("organizations/TestCompany/modules/dup/app/v1/package.json");
  expect(invalid_apps[0].manifest_issues[0]).toContain("koliduje");
  // Response nikdy nenese dvě položky se stejným id.
  expect(invalid_apps[0].id).toBe("invalid-manifest:organizations/TestCompany/modules/dup/app/v1/package.json");
  expect(warnings.some((warning) => warning.includes("koliduje"))).toBe(true);
});

test("obsahová chyba pluginu izoluje appku, read-only violace zůstává hard failure (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "", // prázdný title = kvalita manifestu, ne security
    },
  });

  const { apps, invalid_apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toHaveLength(0);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0].manifest_issues.some((issue) => issue.includes("title"))).toBe(true);
});

test("Synchronizovat flow: nový lokální mount se objeví bez editace root manifestu (decision 0042)", async () => {
  const root = await createGenerationMountFixture();

  const before = await discoverLaunchpadApps(root);
  expect(before.organizations.some((organization) => organization.slug === "OmegaCo")).toBe(false);

  // Simulace „GitHub přístup → git clone / doctor sync" nového mountu:
  await writeGenerationOrg({
    root,
    path: "organizations/OmegaCo_GEN3",
    company: "OmegaCo",
    appDir: "mission-control/app/v3",
    appId: "omegaco-mission-control-v3",
    port: 5293,
  });

  // „Synchronizovat" = nový průchod discovery bez restartu a bez root editace.
  const after = await discoverLaunchpadApps(root);
  expect(after.failures).toEqual([]);
  expect(after.organizations.some(
    (organization) => organization.slug === "OmegaCo" && organization.discovery_source === "filesystem",
  )).toBe(true);
  expect(after.apps.some((app) => app.id === "omegaco-mission-control-v3")).toBe(true);
});

test("discovery nenačítá productionspace app manifesty jako lifecycle aplikace", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const productionAppRoot = join(root, "organizations", "TestCompany", "productionspace", "critical", "app", "v1");
  await mkdir(productionAppRoot, { recursive: true });
  await writeJson(join(productionAppRoot, "package.json"), {
    name: "production-critical-app",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-production-critical-v1",
        title: "Critical production app",
        company: "test-company",
        module: "critical",
        surface: "productionspace",
        port: 4244,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["productionspace"],
      },
    },
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
});

test("discovery odmítne plugin s akčním polem", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Nebezpečný plugin",
      actions: [
        {
          label: "Run",
          command: "bun run write",
        },
      ],
    },
  });
  const { failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("actions není povolené pole"))).toBe(true);
});

test("discovery odmítne Windows drive-qualified plugin cestu mimo Organization boundary", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
    appOverrides: {
      plugin: "D:outside.json",
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(apps).toEqual([]);
  expect(failures.some((failure) => failure.includes("D:outside.json") && failure.includes("uvnitř"))).toBe(true);
});

test("Organization prefix chyba nikdy nezakryje plugin boundary violation", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
    appOverrides: {
      id: "rozjedeme-ai-demo-v1",
      plugin: "D:outside.json",
    },
  });

  const { apps, invalid_apps, failures } = await discoverLaunchpadApps(root);

  expect(apps).toEqual([]);
  expect(invalid_apps).toEqual([]);
  expect(failures.some((failure) => failure.includes("D:outside.json") && failure.includes("uvnitř"))).toBe(true);
});

test("template mount (organization_kind=template) je validovaný, ale mimo organizations, apps i counts", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5999,
    organizationKind: "template",
  });

  const { apps, organizations, template_mounts, template_apps, failures } = await discoverLaunchpadApps(root);

  // Template mount se nepočítá mezi Organizace ani nespouští appky.
  expect(failures).toEqual([]);
  expect(organizations.some((organization) => organization.slug === "OrganizationTemplate")).toBe(false);
  expect(apps.some((app) => app.organization_path === "organizations/OrganizationTemplate_GEN3")).toBe(false);
  // Je ale validovaný a viditelný v oddělených template polích.
  expect(template_mounts.map((mount) => [mount.slug, mount.path, mount.organization_kind])).toContainEqual([
    "OrganizationTemplate",
    "organizations/OrganizationTemplate_GEN3",
    "template",
  ]);
  expect(template_apps.map((app) => [app.id, app.organization_path, app.manifest_state, app.organization_kind])).toContainEqual([
    "organizationtemplate-mission-control-v1",
    "organizations/OrganizationTemplate_GEN3",
    "template",
    "template",
  ]);
});

test("mount bez markeru zůstává běžná Organizace i s jménem OrganizationTemplate (zpětná kompatibilita)", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5998,
  });

  const { apps, organizations, template_mounts, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  // Chybějící organization_kind = organization: dřívější hardcoded filtr na jméno je pryč.
  expect(organizations.some((organization) => organization.slug === "OrganizationTemplate")).toBe(true);
  expect(apps.some((app) => app.id === "organizationtemplate-mission-control-v1")).toBe(true);
  expect(template_mounts).toEqual([]);
});

test("template app manifest s duplicitním portem uvnitř Organizace je izolovaný warning", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5297,
    organizationKind: "template",
  });
  // Druhá template appka stejné Organizace porušuje intra-org unikátnost.
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "warehouse/app/v1",
    appId: "organizationtemplate-warehouse-v1",
    port: 5297,
    organizationKind: "template",
  });

  const { apps, template_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Template chyba nikdy neshodí runtime reálných firem, ale druhý manifest
  // je nevalidní stejně jako v budoucím Organization forku.
  expect(failures).toEqual([]);
  expect(apps.length).toBeGreaterThan(0);
  expect(warnings.some((warning) => warning.includes("template port 5297"))).toBe(true);
  expect(template_apps.filter((app) => app.port === 5297)).toHaveLength(2);
  expect(template_apps.filter((app) => app.manifest_state === "template")).toHaveLength(1);
  expect(template_apps.filter((app) => app.manifest_state === "invalid_manifest")).toHaveLength(1);
});

test("template mount s placeholder slugem se objeví, slug se bere z adresáře mountu", async () => {
  const root = await createGenerationMountFixture();
  // Reálný OrganizationTemplate má v company.gen3.json placeholder slug; marker
  // organization_kind=template ho přesto zpřístupní (slug spadne na jméno adresáře).
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "vyplnit-company-slug",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5990,
    organizationKind: "template",
  });

  const { organizations, template_mounts, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  // Placeholder slug se nikdy neobjeví jako reálná Organizace…
  expect(organizations.some((organization) => organization.slug === "vyplnit-company-slug")).toBe(false);
  // …ale jako template mount se stabilním slugem odvozeným z adresáře.
  expect(template_mounts.map((mount) => [mount.slug, mount.path, mount.organization_kind])).toContainEqual([
    "OrganizationTemplate",
    "organizations/OrganizationTemplate_GEN3",
    "template",
  ]);
});

test("module šablony se objeví informačně skenem templates/*/*, chybějící = prázdný seznam bez failure", async () => {
  const root = await createGenerationMountFixture();
  await mkdir(join(root, "templates", "TemplatesBetaCo", "MissionControlTemplate"), { recursive: true });
  await mkdir(join(root, "templates", "TemplatesBetaCo", "KnowledgebaseTemplate"), { recursive: true });

  const { module_templates, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(module_templates.map((template) => [template.slug, template.path])).toEqual([
    ["KnowledgebaseTemplate", "templates/TemplatesBetaCo/KnowledgebaseTemplate"],
    ["MissionControlTemplate", "templates/TemplatesBetaCo/MissionControlTemplate"],
  ]);
});

test("vadný template package.json je izolovaný — discovery reálných firem přežije", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5995,
    organizationKind: "template",
  });
  // Rozbij template package.json po vygenerování validní struktury.
  await writeFile(
    join(root, "organizations", "OrganizationTemplate_GEN3", "mission-control", "app", "v1", "package.json"),
    "{ not valid json",
    "utf8",
  );

  const { apps, template_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Selhání template package.json se nikdy nepromítne do global failures.
  expect(failures).toEqual([]);
  expect(apps.length).toBeGreaterThan(0);
  expect(warnings.some((warning) => warning.includes("template package.json nejde přečíst"))).toBe(true);
  expect(template_apps.some((app) => app.manifest_state === "invalid_manifest")).toBe(true);
});

test("per-machine local_surfaces se načtou z launchpad.gen3.local.json", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const localGuideRoot = join(root, "local-guide");
  await mkdir(localGuideRoot, { recursive: true });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    local_surfaces: [
      {
        path: "local-guide",
        kind: "shared-guide",
        authority: "local-machine",
      },
    ],
  });
  await writeJson(join(localGuideRoot, "package.json"), {
    name: "local-machine-guide",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "local-machine-guide",
        title: "Local Machine Guide",
        company: "test-companies",
        module: "local-guide",
        surface: "manual",
        port: 5299,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["guide", "local"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("local-machine-guide");
});

test("per-machine local_surfaces stay rooted in canonical machine context for a selected worktree", async () => {
  const selectedRoot = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Selected root" },
  });
  const machineRoot = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Machine root" },
  });
  const machineGuideRoot = join(machineRoot, "machine-guide");
  await mkdir(machineGuideRoot, { recursive: true });
  await writeJson(join(machineRoot, "launchpad.gen3.local.json"), {
    local_surfaces: [{ path: "machine-guide", kind: "shared-guide", authority: "local-machine" }],
  });
  await writeJson(join(machineGuideRoot, "package.json"), {
    name: "canonical-machine-guide",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "canonical-machine-guide",
        title: "Canonical Machine Guide",
        company: "test-companies",
        module: "machine-guide",
        surface: "manual",
        port: 5300,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["guide", "local"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(selectedRoot, {
    machine_context_root: machineRoot,
  });

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("canonical-machine-guide");
});

test("planned sloty se čtou z per-machine launchpad.gen3.local.json, namountovaný slug vyhrává (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    planned_organizations: [
      { slug: "future-org", display_name: "Future Org", git_url: "git@github.com:example/FutureOrg_GEN3.git" },
      { slug: "test-company", display_name: "Duplikát mountnuté" },
      { slug: "<organization-slug>" },
    ],
  });

  const { apps, organizations, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  const planned = organizations.find((organization) => organization.slug === "future-org");
  expect(planned).toMatchObject({ status: "planned", discovery_source: "local_override", path: null });
  // Namountovaná Organizace se stejným slugem vyhrává nad planned slotem.
  const mounted = organizations.filter((organization) => organization.slug === "test-company");
  expect(mounted).toHaveLength(1);
  expect(mounted[0].status).toBe("mounted");
  // Placeholder řádek z .example se tiše přeskočí; planned slot nemá spustitelné appky.
  expect(organizations.some((organization) => organization.slug.includes("<"))).toBe(false);
  expect(apps).toHaveLength(1);
});

test("nečitelný company.gen3.json marker přítomného mountu je hard failure, ne tichý skip (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  // Marker existuje, ale je to rozbitý JSON — mount nesmí zmizet z discovery.
  await writeFile(join(root, "organizations", "TestCompany", "company.gen3.json"), "{ rozbité", "utf8");

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("legacy_projection_unreadable"))).toBe(true);
  expect(apps).toEqual([]);
});

test("scoped runtime discovery neparsuje rozbitý marker jiné Organizace", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const brokenRoot = join(root, "organizations", "BrokenCompany");
  await mkdir(brokenRoot, { recursive: true });
  await writeFile(join(brokenRoot, "company.gen3.json"), "{ rozbité", "utf8");

  const global = await discoverLaunchpadApps(root);
  const scoped = await discoverLaunchpadApps(root, {
    organization: "test-company",
    organization_path: "organizations/TestCompany",
  });

  expect(global.failures.some((failure) => failure.includes("BrokenCompany") && failure.includes("legacy_projection_unreadable"))).toBe(true);
  expect(scoped.failures).toEqual([]);
  expect(scoped.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
});

test("namountovaná Organizace bez povinné GEN3 struktury je hard failure a její balíčky se neprocházejí (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  // Mount existuje (company.gen3.json marker), ale povinná hranice je rozbitá.
  await rm(join(root, "organizations", "TestCompany", "modules.manifest.json"));
  await rm(join(root, "organizations", "TestCompany", "company", "colleagues"), { recursive: true });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("modules_manifest_missing"))).toBe(true);
  // Appka z nezvalidované hranice se nesmí stát spustitelnou.
  expect(apps).toEqual([]);
});

test("Organization identity remains fatal without promoting slot-local Team/Git errors to more org failures", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  const companyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  companyConfig.company.github_org = "CorrectGithubOrg";
  companyConfig.teams = [{ slug: "workspace", display_name: "Hlavní Team", default: true }];
  await writeJson(join(companyRoot, "company.gen3.json"), companyConfig);
  await mkdir(join(companyRoot, "workspace", "no-git"), { recursive: true });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "WrongCompany",
    github_org: "WrongGithubOrg",
    module_slots: [
      {
        path: "modules/demo",
        teams: ["missing-team"],
        git: { url: "git@github.com:vyplnit-github-org/demo.git", branch: "main" },
      },
      {
        path: "workspace/no-git",
        teams: ["workspace"],
      },
    ],
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("organization_modules_identity_conflict"))).toBe(true);
  expect(warnings).toEqual([]);
  expect(failures.some((failure) => failure.includes('neexistující Team "missing-team"'))).toBe(false);
  expect(failures.some((failure) => failure.includes("git URL"))).toBe(false);
  // Mount s rozbitým Organization kontraktem nesmí dodat spustitelnou appku.
  expect(apps).toEqual([]);
});

test("legacy modules/* mount zůstane během incremental rollout načtený s warningem", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      {
        path: "modules/demo",
        git: { url: "git@github.com:TestCompany/demo.git", branch: "main" },
      },
    ],
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("test-company-demo-v1");
  expect(warnings.some((warning) => warning.includes('path "modules/demo"') && warning.includes("incremental rollout"))).toBe(true);
});

test("case-only Organization identity drift je incremental warning, ne mount blocker", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "TEST-COMPANY",
    github_org: "testcompany",
    module_slots: [],
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("test-company-demo-v1");
  expect(warnings.filter((warning) => warning.includes("canonical casing")).length).toBe(2);
});

test("legacy-only Module warning popisuje ignorovaný compatibility vstup, ne casing", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyPath = join(root, "organizations", "TestCompany", "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.modules = [...(company.modules ?? []), { slug: "orphan", path: "workspace/orphan" }];
  await writeJson(companyPath, company);

  const { failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toContainEqual(expect.stringContaining("z normalizovaného inventáře byl ignorován"));
  expect(warnings.some((warning) => warning.includes("legacy_modules_block_ignored") && warning.includes("canonical casing")))
    .toBe(false);
});

test("Organization cross-file identity gate failuje i při chybějícím poli na kterékoli straně", async () => {
  const missingManifestRoot = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const missingManifestCompanyRoot = join(missingManifestRoot, "organizations", "TestCompany");
  const manifest = await Bun.file(join(missingManifestCompanyRoot, "modules.manifest.json")).json();
  manifest.schema_version = "modules.manifest.v3";
  delete manifest.company;
  await writeJson(join(missingManifestCompanyRoot, "modules.manifest.json"), manifest);
  const strictCompany = await Bun.file(join(missingManifestCompanyRoot, "company.gen3.json")).json();
  strictCompany.schema_version = "company.gen3.v3";
  await writeJson(join(missingManifestCompanyRoot, "company.gen3.json"), strictCompany);

  const missingManifestResult = await discoverLaunchpadApps(missingManifestRoot);
  expect(
    missingManifestResult.failures.some(
      (failure) => failure.includes("modules_manifest_company_missing"),
    ),
  ).toBe(true);
  expect(missingManifestResult.apps).toEqual([]);

  const missingCompanyRoot = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const missingCompanyConfigRoot = join(missingCompanyRoot, "organizations", "TestCompany");
  const companyConfig = await Bun.file(join(missingCompanyConfigRoot, "company.gen3.json")).json();
  companyConfig.schema_version = "company.gen3.v3";
  delete companyConfig.company.github_org;
  await writeJson(join(missingCompanyConfigRoot, "company.gen3.json"), companyConfig);
  const strictManifest = await Bun.file(join(missingCompanyConfigRoot, "modules.manifest.json")).json();
  strictManifest.schema_version = "modules.manifest.v3";
  await writeJson(join(missingCompanyConfigRoot, "modules.manifest.json"), strictManifest);

  const missingCompanyResult = await discoverLaunchpadApps(missingCompanyRoot);
  expect(
    missingCompanyResult.failures.some(
      (failure) => failure.includes("legacy_organization_identity_invalid"),
    ),
  ).toBe(true);
  expect(missingCompanyResult.apps).toEqual([]);
});

test("conflicting Organization root remote and branch aliases block only that Organization", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo" },
  });
  const companyPath = join(root, "organizations", "TestCompany", "company.gen3.json");
  const company = JSON.parse(await Bun.file(companyPath).text());
  company.company.repository = "git@github.com:TestCompany/TestCompany_GEN3.git";
  company.company.git_url = "git@github.com:ForeignCo/Shadow_GEN3.git";
  company.company.default_branch = "main";
  company.default_branch = "develop";
  await writeJson(companyPath, company);

  const { apps, failures, organization_issues: organizationIssues } = await discoverLaunchpadApps(root);

  expect(apps).toEqual([]);
  expect(failures.some((failure) => failure.includes("organization_root_remote_conflict"))).toBe(true);
  expect(failures.some((failure) => failure.includes("organization_root_branch_conflict"))).toBe(true);
  expect(organizationIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      organization: "TestCompany",
      scope: "organization",
      blocks_subordinate_projection: true,
    }),
  ]));
});

test("scaffold forge binding and governance participate in Organization discovery authority", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo" },
  });
  const companyPath = join(root, "organizations", "TestCompany", "company.gen3.json");
  const company = JSON.parse(await Bun.file(companyPath).text());
  company.company.repository = "git@github.com:LegacyCo/LegacyCo_GEN3.git";
  company.company.root_repository = "LegacyCo/LegacyCo_GEN3";
  company.company.github_org = "TestCompany";
  company.company.default_branch = "main";
  company.forge_binding = {
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: { id: "123", asserted_login: "TestCompany" },
    repository: {
      id: "456",
      asserted_full_name: "TestCompany/TestCompany_GEN3",
      default_branch: "main",
    },
  };
  company.governance = { default_branch: "develop" };
  await writeJson(companyPath, company);

  const { apps, failures, organization_issues: organizationIssues } = await discoverLaunchpadApps(root);

  expect(apps).toEqual([]);
  expect(failures.some((failure) => failure.includes("organization_root_remote_conflict")))
    .toBe(true);
  expect(failures.some((failure) => failure.includes("organization_root_branch_conflict")))
    .toBe(true);
  expect(organizationIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      organization: "TestCompany",
      scope: "organization",
      blocks_subordinate_projection: true,
    }),
  ]));
});

test("foreign governance access authority is Organization-fatal while sibling discovery remains usable", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/BlockedCo_GEN3",
    company: "blocked-co",
    appDir: "mission-control/app/v1",
    appId: "blocked-demo-v1",
    port: 5990,
  });
  const companyPath = join(root, "organizations", "BlockedCo_GEN3", "company.gen3.json");
  const company = JSON.parse(await Bun.file(companyPath).text());
  company.governance = { default_branch: "main", access_authority: "not-github" };
  await writeJson(companyPath, company);

  const { apps, organization_issues: organizationIssues } = await discoverLaunchpadApps(root);

  expect(apps.some((app) => app.company === "DemoCo")).toBe(true);
  expect(apps.some((app) => app.company === "blocked-co")).toBe(false);
  expect(organizationIssues).toContainEqual(expect.objectContaining({
    organization: "BlockedCo",
    scope: "organization",
    blocks_subordinate_projection: true,
    code: "organization_manifest_conflict",
    message: expect.stringContaining("organization_root_access_authority_invalid"),
  }));
});

test("template placeholder varianty jsou incremental warning, ne runtime blocker", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "vyplnit-company-slug",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5991,
    organizationKind: "template",
  });
  const templateRoot = join(root, "organizations", "OrganizationTemplate_GEN3");
  const companyConfig = await Bun.file(join(templateRoot, "company.gen3.json")).json();
  companyConfig.company.github_org = "vyplnit-github-org";
  await writeJson(join(templateRoot, "company.gen3.json"), companyConfig);
  await writeJson(join(templateRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "<VYPLNIT_COMPANY_NAME>",
    github_org: "<VYPLNIT_GITHUB_ORG>",
    module_slots: [
      {
        path: "modules/knowledgebase",
        status: "planned_slot",
        teams: ["workspace"],
      },
    ],
  });

  const { template_apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("OrganizationTemplate_GEN3") && failure.includes("company.slug"))).toBe(false);
  expect(warnings.some((warning) => warning.includes("OrganizationTemplate_GEN3") && warning.includes("organization.slug"))).toBe(true);
  expect(failures.some((failure) => failure.includes("OrganizationTemplate_GEN3") && failure.includes("company.github_org"))).toBe(false);
  expect(warnings.some((warning) => warning.includes("OrganizationTemplate_GEN3") && warning.includes("organization.forge_binding.locator"))).toBe(true);
  expect(
    warnings.some(
      (warning) =>
        warning.includes("OrganizationTemplate_GEN3") &&
        warning.includes('path "modules/knowledgebase"') &&
        warning.includes("deprecated modules/*"),
    ),
  ).toBe(true);
  expect(template_apps.some((app) => app.organization_path === "organizations/OrganizationTemplate_GEN3")).toBe(true);
});

test("placeholder Organization identita bez markeru template je hard failure", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/Scaffold_GEN3",
    company: "vyplnit-company-slug",
    appDir: "mission-control/app/v1",
    appId: "scaffold-mission-control-v1",
    port: 5992,
  });

  const { organizations, failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("Scaffold_GEN3") && failure.includes("placeholder") && failure.includes("organization.slug"))).toBe(true);
  expect(organizations.some((organization) => organization.path === "organizations/Scaffold_GEN3")).toBe(false);
});

test("placeholder company.github_org bez markeru template je hard failure", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/Scaffold_GEN3",
    company: "Scaffold",
    appDir: "mission-control/app/v1",
    appId: "scaffold-mission-control-v1",
    port: 5992,
  });
  const companyRoot = join(root, "organizations", "Scaffold_GEN3");
  const companyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  companyConfig.company.github_org = "vyplnit-github-org";
  await writeJson(join(companyRoot, "company.gen3.json"), companyConfig);
  const modulesManifest = await Bun.file(join(companyRoot, "modules.manifest.json")).json();
  modulesManifest.github_org = "vyplnit-github-org";
  await writeJson(join(companyRoot, "modules.manifest.json"), modulesManifest);

  const { organizations, failures } = await discoverLaunchpadApps(root);

  expect(
    failures.some(
      (failure) =>
        failure.includes("Scaffold_GEN3") &&
        failure.includes("organization.forge_binding.locator") &&
        failure.includes("placeholder"),
    ),
  ).toBe(true);
  expect(organizations.some((organization) => organization.path === "organizations/Scaffold_GEN3")).toBe(false);
});

test("opravený OrganizationTemplate placeholder kontrakt projde bez false failure", async () => {
  const root = await createGenerationMountFixture();
  const templateRoot = join(root, "organizations", "OrganizationTemplate_GEN3");
  await mkdir(join(templateRoot, "manual"), { recursive: true });
  await mkdir(join(templateRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(templateRoot, "workspace"), { recursive: true });
  // Infra je v template jen plánovaný scaffold. Jeho existence proto nesmí
  // aktivovat materialized-active Git URL gate.
  await mkdir(join(templateRoot, "infra"), { recursive: true });
  await writeJson(join(templateRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    organization_kind: "template",
    company: {
      slug: "vyplnit-company-slug",
      display_name: "<VYPLNIT_COMPANY_NAME>",
      github_org: "vyplnit-github-org",
    },
    teams: [
      { slug: "workspace", display_name: "<VYPLNIT_DEFAULT_TEAM_NAME>", default: true },
    ],
  });
  await writeJson(join(templateRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "vyplnit-company-slug",
    github_org: "vyplnit-github-org",
    workspace_path: "workspace",
    teams: [
      { slug: "workspace", display_name: "<VYPLNIT_DEFAULT_TEAM_NAME>", default: true },
    ],
    module_slots: [
      {
        path: "workspace/knowledgebase",
        teams: ["workspace"],
        git: { url: "git@github.com:vyplnit-github-org/knowledgebase.git", branch: "main" },
      },
      {
        path: "infra",
        status: "planned_slot",
        git: { url: "git@github.com:vyplnit-github-org/infra.git", branch: "main" },
      },
    ],
  });

  const { template_mounts, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(template_mounts.some((mount) => mount.path === "organizations/OrganizationTemplate_GEN3")).toBe(true);
});

test("Organization path gate rejects POSIX, drive, UNC and mixed-separator escapes but allows a future child", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  for (const path of [
    "../ForeignOrg/workspace/shared",
    "workspace\\..\\ForeignOrg\\shared",
    "/tmp/foreign",
    "C:\\ForeignOrg\\shared",
    "C:ForeignOrg\\shared",
    "\\\\server\\share\\module",
    " workspace/demo",
  ]) {
    expect(organizationRelativePathIssue({ organizationRoot, path })).toContain("uniká mimo Organization root");
  }
  expect(organizationRelativePathIssue({ organizationRoot, path: "workspace/future-module" })).toBeNull();
  expect(organizationRelativePathIssue({ organizationRoot, path: "workspace\\future-mixed" })).toBeNull();
});

test("Organization path gate compares the exact declared and observed repository casing", () => {
  expect(organizationRepositoryPathCasingIssue({
    declaredPath: "productionspace/Buddy_GEN2",
    observedPath: "productionspace/Buddy_GEN2",
  })).toBeNull();
  expect(organizationRepositoryPathCasingIssue({
    declaredPath: "productionspace/buddy_gen2",
    observedPath: "productionspace/Buddy_GEN2",
  })).toContain("přesnému psaní");
});

test("Organization path gate finds a differently-cased existing checkout on case-sensitive filesystems", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  await mkdir(join(organizationRoot, "productionspace", "Buddy_GEN2"), { recursive: true });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [{
      slug: "buddy-gen2",
      path: "productionspace/buddy_gen2",
      git: { url: "git@github.com:TestCompany/Buddy_GEN2.git", branch: "main" },
    }],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.apps).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.organization_issues).toContainEqual(expect.objectContaining({
    scope: "module_slot",
    code: "slot_path_casing_mismatch",
    module: "buddy-gen2",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("Organization path gate rejects a differently-cased existing prefix for a planned checkout", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  await mkdir(join(organizationRoot, "Workspace"), { recursive: true });

  expect(organizationRelativePathIssue({
    organizationRoot,
    path: "workspace/future",
  })).toContain(
    '"workspace/future" neodpovídá přesnému psaní existující cesty "Workspace/future"',
  );
});

test("Organization path gate rejects two case-folded siblings on case-sensitive hosts", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  const productionRoot = join(organizationRoot, "productionspace");
  await mkdir(join(productionRoot, "Buddy_GEN2"), { recursive: true });
  await mkdir(join(productionRoot, "buddy_gen2"), { recursive: true });
  const siblings = await readdir(productionRoot);
  if (siblings.filter((entry) => entry.toLowerCase() === "buddy_gen2").length < 2) return;

  expect(organizationRelativePathIssue({
    organizationRoot,
    path: "productionspace/Buddy_GEN2",
  })).toContain("více case-insensitive protějšků");
});

test("invalid case-preserving mount ID quarantines only that declared slot", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { path: "productionspace/Buddy_GEN2", git: { url: "git@github.com:TestCompany/Buddy_GEN2.git" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.apps).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.organization_issues).toContainEqual(expect.objectContaining({
    scope: "module_slot",
    code: "slot_identity_invalid",
    path: "productionspace/Buddy_GEN2",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("repository rename drift quarantines only its slot and keeps a healthy sibling discoverable", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git" } },
      { slug: "buddy-gen2", path: "workspace/Buddy_GEN2", git: { url: "git@github.com:TestCompany/Other.git" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(result.organization_issues).toEqual([
    expect.objectContaining({
      status: "quarantined",
      code: "repository_location_mismatch",
      organization: "test-company",
      module: "buddy-gen2",
      path: "workspace/Buddy_GEN2",
      expected_path: "workspace/Other",
      next_action: expect.objectContaining({
        kind: "repair_module_location",
        command: "lazurio repair module-location --org test-company --module buddy-gen2",
      }),
    }),
  ]);
});

test("stable Team and missing-remote errors quarantine only their modules with an Agent review", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  const company = await Bun.file(join(organizationRoot, "company.gen3.json")).json();
  company.teams = [{ slug: "workspace", path: "workspace", default: true }];
  await writeJson(join(organizationRoot, "company.gen3.json"), company);
  for (const module of ["bad-team", "no-git"]) {
    const moduleRoot = join(organizationRoot, "workspace", module);
    await mkdir(moduleRoot, { recursive: true });
    await writeJson(join(moduleRoot, "lazurio.module.json"), {
      schema_version: "lazurio.module.v1",
      id: module,
      company: "test-company",
    });
  }
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", teams: ["workspace"], git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "bad-team", path: "workspace/bad-team", teams: ["missing"], git: { url: "git@github.com:TestCompany/bad-team.git", branch: "main" } },
      { slug: "no-git", path: "workspace/no-git", teams: ["workspace"] },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(result.organization_issues).toHaveLength(2);
  expect(result.organization_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "slot_team_invalid",
      module: "bad-team",
      status: "quarantined",
      next_action: expect.objectContaining({ kind: "agent_review" }),
    }),
    expect.objectContaining({
      code: "slot_remote_missing",
      module: "no-git",
      status: "quarantined",
      next_action: expect.objectContaining({ kind: "agent_review" }),
    }),
  ]));
  expect(result.organization_issues.every((issue) =>
    issue.next_action.prompt.includes("ostatní zdravé moduly zůstávají použitelné")
  )).toBe(true);
});

test("a foreign GitHub remote quarantines only its module access boundary", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "foreign", path: "workspace/foreign", git: { url: "git@github.com:ForeignCo/foreign.git", branch: "main" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(result.organization_issues).toContainEqual(expect.objectContaining({
    scope: "module_slot",
    code: "slot_remote_owner_mismatch",
    module: "foreign",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("a cross-Organization remote dominates a simultaneous repository rename", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "transferred", path: "workspace/old-name", git: { url: "git@github.com:OtherCompany/new-name.git", branch: "main" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);
  const transferred = result.organization_issues.filter((issue) => issue.module === "transferred");

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(transferred).toEqual([
    expect.objectContaining({
      code: "slot_remote_owner_mismatch",
      expected_path: null,
      next_action: expect.objectContaining({
        kind: "agent_review",
        prompt: expect.stringContaining("správné Organization access hranici"),
      }),
    }),
  ]);
  expect(JSON.stringify(transferred)).not.toContain("repair_module_location");
});

test("conflicting remote and branch aliases quarantine one slot without choosing an action authority", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      {
        slug: "conflicted",
        path: "workspace/conflicted",
        repo: "git@github.com:ForeignCo/conflicted.git",
        branch: "feature",
        git: { url: "git@github.com:TestCompany/conflicted.git", branch: "main" },
      },
    ],
  });

  const result = await discoverLaunchpadApps(root);
  const conflicts = result.organization_issues.filter((issue) => issue.module === "conflicted");

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(conflicts.map((issue) => issue.code).sort()).toEqual([
    "slot_branch_conflict",
    "slot_remote_conflict",
  ]);
  expect(conflicts.every((issue) => issue.next_action?.kind === "agent_review")).toBe(true);
  expect(JSON.stringify(conflicts)).not.toContain("repair_module_location");
});

test("published canonical path discovers the old stable-slug checkout, prevents duplicate discovery and offers relocation", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  const legacyRoot = join(organizationRoot, "workspace", "legacy-name");
  await mkdir(legacyRoot, { recursive: true });
  await writeJson(join(legacyRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "renamed",
    company: "test-company",
  });
  await writeJson(join(legacyRoot, "package.json"), {
    name: "test-company-renamed-v1",
    private: true,
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-renamed-v1",
        title: "Renamed",
        company: "test-company",
        module: "renamed",
        surface: "internal",
        port: 4243,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
      },
    },
  });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "renamed", path: "workspace/canonical-name", git: { url: "git@github.com:TestCompany/canonical-name.git", branch: "main" } },
    ],
  });
  const company = await Bun.file(join(organizationRoot, "company.gen3.json")).json();
  company.modules = [
    { slug: "demo", path: "modules/demo", repo: "git@github.com:TestCompany/demo.git" },
    { slug: "renamed", path: "workspace/canonical-name", repo: "git@github.com:TestCompany/canonical-name.git" },
  ];
  await writeJson(join(organizationRoot, "company.gen3.json"), company);

  const result = await discoverLaunchpadApps(root);

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(result.organization_issues).toEqual([
    expect.objectContaining({
      code: "repository_location_mismatch",
      module: "renamed",
      path: "workspace/legacy-name",
      expected_path: "workspace/canonical-name",
      next_action: expect.objectContaining({
        command: "lazurio repair module-location --org test-company --module renamed",
      }),
    }),
  ]);
});

test("a stable-slug Git checkout with an unverifiable marker remains quarantined on every discovery", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await mkdir(join(organizationRoot, "workspace", "renamed", ".git"), { recursive: true });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "renamed", path: "workspace/canonical-name", git: { url: "git@github.com:TestCompany/canonical-name.git", branch: "main" } },
    ],
  });

  for (const result of [await discoverLaunchpadApps(root), await discoverLaunchpadApps(root)]) {
    expect(result.failures).toEqual([]);
    expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
    expect(result.organization_issues.filter((issue) => issue.module === "renamed")).toEqual([
      expect.objectContaining({
        code: "repository_transition_unverified",
        path: "workspace/renamed",
        expected_path: "workspace/canonical-name",
        next_action: expect.objectContaining({
          kind: "repair_module_location",
          prompt: expect.stringContaining("marker_missing"),
        }),
      }),
    ]);
  }
});

test("two authorized checkout paths collapse to one non-repairable ambiguity blocker", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  for (const basename of ["renamed", "canonical-name"]) {
    const checkout = join(organizationRoot, "workspace", basename);
    await mkdir(checkout, { recursive: true });
    await writeJson(join(checkout, "lazurio.module.json"), {
      schema_version: "lazurio.module.v1",
      id: "renamed",
      company: "test-company",
    });
  }
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "renamed", path: "workspace/renamed", git: { url: "git@github.com:TestCompany/canonical-name.git", branch: "main" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);
  const issues = result.organization_issues.filter((issue) => issue.module === "renamed");

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(issues).toEqual([
    expect.objectContaining({
      code: "repository_location_ambiguous",
      expected_path: "workspace/canonical-name",
      observed_paths: ["workspace/canonical-name", "workspace/renamed"],
      next_action: expect.objectContaining({
        kind: "agent_review",
        prompt: expect.stringContaining("workspace/canonical-name"),
      }),
    }),
  ]);
});

test("leaf-only case rename quarantines one stable module while its healthy sibling stays discoverable", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  const observedRoot = join(organizationRoot, "workspace", "CanonicalName");
  await mkdir(observedRoot, { recursive: true });
  await writeJson(join(observedRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "renamed",
    company: "test-company",
  });
  await writeJson(join(observedRoot, "package.json"), {
    name: "test-company-renamed-v1",
    private: true,
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-renamed-v1",
        title: "Renamed",
        company: "test-company",
        module: "renamed",
        surface: "internal",
        port: 4243,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
      },
    },
  });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "renamed", path: "workspace/canonicalname", git: { url: "git@github.com:TestCompany/canonicalname.git", branch: "main" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.failures).toEqual([]);
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(result.organization_issues).toEqual([
    expect.objectContaining({
      code: "repository_location_mismatch",
      module: "renamed",
      path: "workspace/CanonicalName",
      expected_path: "workspace/canonicalname",
    }),
  ]);
});

test("case-like leaf behind a workspace symlink remains an Organization boundary failure", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  const foreignRoot = join(root, "organizations", "ForeignCompany", "CanonicalName");
  await mkdir(foreignRoot, { recursive: true });
  await writeJson(join(foreignRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "renamed",
    company: "test-company",
  });
  await symlink(join(root, "organizations", "ForeignCompany"), join(organizationRoot, "workspace"));
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git", branch: "main" } },
      { slug: "renamed", path: "workspace/canonicalname", git: { url: "git@github.com:TestCompany/canonicalname.git", branch: "main" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.apps).toEqual([]);
  expect(result.failures.join("\n")).toContain("canonical containment");
  expect(result.organization_issues).toEqual([
    expect.objectContaining({
      scope: "organization",
      code: "organization_mount_boundary_invalid",
      organization: "test-company",
    }),
  ]);
  expect(JSON.stringify(result)).not.toContain("repair module-location");
});

test("raw non-canonical repository path blocks package discovery before separator cleanup", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules\\demo", git: { url: "git@github.com:TestCompany/demo.git" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.apps).toEqual([]);
  expect(result.failures.join("\n")).toContain("modules_manifest_slot_0_path_invalid");
  expect(result.organization_issues).toContainEqual(expect.objectContaining({
    scope: "organization",
    code: "organization_manifest_conflict",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("incomplete slot declaration is an honest fatal contract error instead of disappearing", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [{ slug: "broken" }],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.apps).toEqual([]);
  expect(result.failures.join("\n")).toContain("modules_manifest_slot_0_path_invalid");
});

test("legacy compatibility projection cannot create a shadow repository identity conflict", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { slug: "demo", path: "modules/demo", git: { url: "git@github.com:TestCompany/demo.git" } },
    ],
  });
  const companyConfig = await Bun.file(join(organizationRoot, "company.gen3.json")).json();
  companyConfig.modules = [{ slug: "demo", path: "workspace/DemoV2" }];
  await writeJson(join(organizationRoot, "company.gen3.json"), companyConfig);

  const result = await discoverLaunchpadApps(root);

  expect(result.apps).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.organization_issues).toEqual([]);
});

test("an ambiguous markerless path stays reserved without contaminating a vacant sibling", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  const slots = [
    { slug: "a", path: "workspace/shared", git: { url: "git@github.com:TestCompany/shared.git", branch: "main" } },
    { slug: "b", path: "workspace/shared", git: { url: "git@github.com:TestCompany/shared.git", branch: "main" } },
    { slug: "c", path: "workspace/c", git: { url: "git@github.com:TestCompany/c.git", branch: "main" } },
  ];
  await mkdir(join(organizationRoot, "workspace", "shared", ".git"), { recursive: true });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: slots,
  });
  const company = await Bun.file(join(organizationRoot, "company.gen3.json")).json();
  company.modules = slots.map((slot) => ({
    slug: slot.slug,
    path: slot.path,
    repo: slot.git.url,
  }));
  await writeJson(join(organizationRoot, "company.gen3.json"), company);

  const result = await discoverLaunchpadApps(root);
  const blockedModules = new Set(result.organization_issues.map((issue) => issue.module));

  expect(result.failures).toEqual([]);
  expect(blockedModules.has("a")).toBe(true);
  expect(blockedModules.has("b")).toBe(true);
  expect(blockedModules.has("c")).toBe(false);
  expect(JSON.stringify(result.organization_issues)).not.toContain('"module":"c"');
});

test("Organization module paths fail closed on traversal and canonical symlink escapes", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  const foreignRoot = join(root, "organizations", "ForeignOrg", "workspace", "shared");
  await mkdir(foreignRoot, { recursive: true });
  await mkdir(join(organizationRoot, "workspace"), { recursive: true });
  await symlink(foreignRoot, join(organizationRoot, "workspace", "foreign-link"));
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { path: "../ForeignOrg/workspace/shared", git: { url: "git@github.com:ForeignOrg/shared.git" } },
      { path: "workspace/foreign-link", git: { url: "git@github.com:ForeignOrg/shared.git" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.failures.filter((failure) => failure.includes("modules_manifest_slot_0_path_invalid"))).toHaveLength(1);
  expect(result.organization_issues).toContainEqual(expect.objectContaining({
    scope: "organization",
    code: "organization_manifest_conflict",
  }));
});

test("a transition pair discovers one normalized Organization and one app", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Transition" },
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  await convertOrganizationFixtureToTransition(organizationRoot);

  const result = await discoverLaunchpadApps(root);

  expect(result.failures).toEqual([]);
  expect(result.organizations).toHaveLength(1);
  expect(result.organizations[0]).toMatchObject({
    slug: "test-company",
    manifest_state: "transition",
    declaration_source: "lazurio.organization.json",
  });
  expect(result.apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
});

async function createCompaniesWorkspaceFixture({ plugin, appOverrides = {} }) {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-discovery-"));
  tempRoots.push(root);
  const companyRoot = join(root, "organizations", "TestCompany");
  const appRoot = join(companyRoot, "modules", "demo", "app", "v1");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });

  // Scan-first (decision 0042): sdílený launchpad.gen3.json nese jen generický
  // kontrakt; Organizace se zjišťují skenem organizations/*/company.gen3.json.
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "test-company", display_name: "Test Company", github_org: "TestCompany" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  await writeJson(join(appRoot, "package.json"), {
    name: "test-company-demo-v1",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-demo-v1",
        title: "Demo v1",
        company: "test-company",
        module: "demo",
        surface: "internal",
        port: 4242,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        plugin: "./launchpad.plugin.json",
        tags: ["test"],
        ...appOverrides,
      },
    },
  });
  await writeJson(join(appRoot, "launchpad.plugin.json"), plugin);
  return root;
}

async function convertOrganizationFixtureToTransition(organizationRoot) {
  const legacy = await Bun.file(join(organizationRoot, "company.gen3.json")).json();
  const modules = await Bun.file(join(organizationRoot, "modules.manifest.json")).json();
  const canonical = {
    schema_version: "lazurio.organization.v1",
    kind: legacy.organization_kind ?? "organization",
    organization: {
      slug: legacy.company.slug,
      display_name: legacy.company.display_name ?? legacy.company.slug,
      forge_binding: {
        forge: "github",
        locator: legacy.company.github_org,
        binding_state: "unverified",
      },
      metadata: {},
    },
    root_repository: null,
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: {} },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: "sha256:" + "0".repeat(64),
      },
    },
  };
  canonical.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonical, modules);
  await writeJson(join(organizationRoot, "lazurio.organization.json"), canonical);
  await writeJson(
    join(organizationRoot, "company.gen3.json"),
    projectLegacyOrganizationManifest(canonical, modules),
  );
}


async function createGenerationMountFixture() {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-gen3-mounts-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  // Scan-first: root nese jen generický kontrakt, Organizace jsou na disku.
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "conglomerate",
      display_name: "Lazurio",
      root_role: "launchpad-root",
    },
  });
  await writeGenerationOrg({
    root,
    path: "organizations/BetaCo_GEN3",
    company: "BetaCo",
    appDir: "mission-control/app/v2",
    appId: "betaco-mission-control-v2",
    port: 5392,
  });
  await writeGenerationOrg({
    root,
    path: "organizations/DemoCo_GEN3",
    company: "DemoCo",
    appDir: "mission-control/app/v1",
    appId: "democo-mission-control-v1",
    port: 5693,
  });
  return root;
}

async function writeGenerationOrg({ root, path, company, appDir, appId, port, organizationKind }) {
  const companyRoot = join(root, path);
  const appRoot = join(companyRoot, appDir);
  const module = appDir.split("/")[0];
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    ...(organizationKind ? { organization_kind: organizationKind } : {}),
    company: { slug: company, display_name: company, github_org: company },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company,
    github_org: company,
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  await writeJson(join(appRoot, "package.json"), {
    name: `${appId.toLowerCase()}-fixture`,
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: appId,
        title: module === "mission-control" ? "Mission Control" : module,
        company,
        module,
        surface: "internal",
        port,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: [module],
      },
    },
  });
}

async function writeJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
