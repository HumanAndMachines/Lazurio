import { createFixtureWorkspace } from "./fixture.test-support.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { describe, expect, test } from "bun:test";
import { readCheckoutRepositoryObservation } from "./checkout-observation.mjs";
import { prepareOrganizationCompilation } from "./compiler-core.mjs";
import {
  OrganizationCompilerError,
  WorkspaceCompilerError,
  buildCompanyTargets,
  compileCompanyWorkspace,
  compileOrganization,
  formatCompilerReport,
} from "./index.mjs";
const offlineRepositoryObservation = { status: "offline" };

describe("organization compiler", () => {
  test("dry-run builds derived targets without writing files", async () => {
    const workspace = await createFixtureWorkspace();

    const report = await compileOrganization({
      organizationRoot: workspace,
      repositoryObservation: offlineRepositoryObservation,
    });

    expect(report.mode).toBe("dry-run");
    expect(report.organization_root).toBe(workspace);
    expect(report.target_count).toBe(4);
    expect(report.changed_target_count).toBe(4);
    expect(report.ownership_summary.managed).toBe(0);
    expect(report.ownership_summary.derived).toBe(4);
    expect(report.ownership_summary.override).toBe(1);
    expect(report.ownership_summary.manual).toBe(2);
    expect(report.validation_warnings).toContain(
      "company.gen3.json/modules: workspace/deals drží deprecated app manifest registry; canonical je package.json#companyascode.app",
    );
    expect(await Bun.file(join(workspace, "generated", "company-summary.json")).exists()).toBe(false);

    await rm(workspace, { recursive: true, force: true });
  });

  test("programmatic local-first write fails without checkout evidence", async () => {
    const workspace = await createFixtureWorkspace();

    try {
      await compileOrganization({
        organizationRoot: workspace,
        write: true,
      });
      throw new Error(
        "Compiler write měl bez checkout evidence selhat zavřeně",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationCompilerError);
      expect(error.message).toContain(
        "vyžaduje kanonickým readerem důvěryhodně zjištěný checkout",
      );
    }

    await rm(workspace, { recursive: true, force: true });
  });

  test("manifest template marker nemůže sám obejít trusted checkout write gate", async () => {
    const workspace = await createFixtureWorkspace();
    const companyPath = join(workspace, "company.gen3.json");
    const company = await Bun.file(companyPath).json();
    company.organization_kind = "template";
    await Bun.write(
      companyPath,
      `${JSON.stringify(company, null, 2)}\n`,
    );
    initializeLocalFirstCheckout(workspace);

    await expect(
      compileOrganization({
        organizationRoot: workspace,
        write: true,
      }),
    ).rejects.toMatchObject({
      name: "OrganizationCompilerError",
      message:
        "Write requires a linked review worktree on a non-canonical branch",
    });
    await rm(workspace, { recursive: true, force: true });
  });

  test("caller callback nemůže zfalšovat checkout evidence pro write", async () => {
    const workspace = await createFixtureWorkspace();

    await expect(
      compileOrganization({
        organizationRoot: workspace,
        write: true,
        repositoryObservationReader: () => ({
          status: "absent",
          remoteContract: {
            originRoutingReady: true,
          },
        }),
      }),
    ).rejects.toThrow(
      "nepřijímá callerem dodaný repositoryObservationReader",
    );

    await rm(workspace, { recursive: true, force: true });
  });

  test("write creates generated company files", async () => {
    // Deprecated API aliases (compileCompanyWorkspace + workspaceRoot +
    // workspace_generation) musí dál fungovat (CAC-0016).
    const workspace = await createFixtureWorkspace({ generationKey: "workspace_generation" });
    initializeLocalFirstCheckout(workspace);

    const compatibilityReport = await compileCompanyWorkspace({
      workspaceRoot: workspace,
      repositoryObservation: offlineRepositoryObservation,
    });
    expect(compatibilityReport.mode).toBe("dry-run");

    const report = await compileCanonicalFixtureCheckout({
      workspaceRoot: workspace,
      write: true,
    });

    expect(report.mode).toBe("write");
    const summary = await Bun.file(join(workspace, "generated", "company-summary.json")).json();
    expect(summary.company.slug).toBe("fixture-company");
    expect(await Bun.file(join(workspace, "generated", "business-context.md")).text()).toContain(
      "Co firmu živí",
    );
    const modulesIndex = await Bun.file(join(workspace, "generated", "modules.index.json")).json();
    expect(modulesIndex.schema_version).toBe("companiesascode.modules_index.v2");
    expect(modulesIndex.company_slug).toBe("fixture-company");
    expect(modulesIndex.teams[0]).toMatchObject({ slug: "workspace", default: true });
    expect(modulesIndex.modules[0].workspace).toBe("workspace");
    expect(modulesIndex.modules[0].space).toBe("workspace");
    expect(modulesIndex.modules[1].workspace).toBeNull();
    expect(modulesIndex.modules[1].space).toBe("productionspace");
    expect(
      modulesIndex.manifest_slots.find((slot) => slot.path === "design-system"),
    ).toMatchObject({
      space: "root",
      teams: [],
      workspace: null,
    });
    expect("app_manifests" in modulesIndex.modules[0]).toBe(false);
    expect(await Bun.file(join(workspace, "generated", "generation-policy.md")).text()).toContain(
      "Generační pravidla",
    );

    await rm(workspace, { recursive: true, force: true });
  });

  test("write binds root_repository to the trusted physical checkout basename", async () => {
    const workspace = await createFixtureWorkspace();
    const companyPath = join(workspace, "company.gen3.json");
    const company = await Bun.file(companyPath).json();
    company.company.root_repository =
      "FixtureOrg/FixtureCompany_GEN3";
    company.company.repository =
      "git@github.com:FixtureOrg/FixtureCompany_GEN3.git";
    await Bun.write(
      companyPath,
      `${JSON.stringify(company, null, 2)}\n`,
    );
    initializeRemoteActiveCheckout(workspace);

    try {
      await compileCanonicalFixtureCheckout({
        organizationRoot: workspace,
        expectedStatus: "valid",
        write: true,
      });
      throw new Error(
        "Compiler měl odlišný physical checkout basename odmítnout",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationCompilerError);
      expect(error.details.failures).toContain(
        "company.gen3.json/company: basename fyzického checkout rootu musí odpovídat repository komponentě root_repository",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("report includes a small diff preview for changed outputs", async () => {
    const workspace = await createFixtureWorkspace();
    await mkdir(join(workspace, "generated"), { recursive: true });
    await writeFile(join(workspace, "generated", "business-context.md"), "stale\n");

    const report = await compileOrganization({
      organizationRoot: workspace,
      repositoryObservation: offlineRepositoryObservation,
    });
    const target = report.targets.find((item) => item.path === "generated/business-context.md");

    expect(target.status).toBe("update");
    expect(target.diff_preview.join("\n")).toContain("-stale");
    expect(formatCompilerReport(report)).toContain("Organization Compiler Report");

    await rm(workspace, { recursive: true, force: true });
  });

  test("uses the declared default Team slug for modules without an explicit declaration", async () => {
    const workspace = await createFixtureWorkspace({ defaultWorkspace: "launchpad" });
    initializeLocalFirstCheckout(workspace);

    await compileCanonicalFixtureCheckout({
      organizationRoot: workspace,
      write: true,
    });
    const modulesIndex = await Bun.file(join(workspace, "generated", "modules.index.json")).json();

    expect(modulesIndex.modules[0].workspace).toBe("launchpad");
    expect(modulesIndex.modules[1].workspace).toBeNull();

    await rm(workspace, { recursive: true, force: true });
  });

  test("write refuses compiler targets outside derived ownership", async () => {
    const workspace = await createFixtureWorkspace({
      managed: ["generated/**"],
      derived: [],
    });
    initializeLocalFirstCheckout(workspace);

    await expect(
      compileCanonicalFixtureCheckout({
        organizationRoot: workspace,
        write: true,
      }),
    ).rejects.toThrow("mimo derived ownership");
    expect(WorkspaceCompilerError).toBe(OrganizationCompilerError);

    await rm(workspace, { recursive: true, force: true });
  });

  test("rejects an ownership path matching more than one classification", async () => {
    const workspace = await createFixtureWorkspace({
      managed: ["generated/**"],
      derived: ["generated/**"],
    });

    try {
      await compileOrganization({
        organizationRoot: workspace,
        repositoryObservation: offlineRepositoryObservation,
      });
      throw new Error("Compiler měl překryv ownership klasifikací odmítnout");
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationCompilerError);
      expect(error.message).toContain("schema/semantic validací");
      expect(error.details.failures).toContain(
        'company.gen3.json/governance/file_ownership: patterny "generated/**" (managed) a "generated/**" (derived) se překrývají; jedna cesta smí mít právě jednu ownership klasifikaci',
      );
    }

    await rm(workspace, { recursive: true, force: true });
  });

  test("rejects an unclassified compiler target even in dry-run", async () => {
    const workspace = await createFixtureWorkspace({ derived: [] });

    await expect(
      compileOrganization({
        organizationRoot: workspace,
        repositoryObservation: offlineRepositoryObservation,
      }),
    ).rejects.toThrow("právě jednu ownership klasifikaci");

    await rm(workspace, { recursive: true, force: true });
  });

  test("CLI vypíše konkrétní ownership_issues při fail-closed klasifikaci", async () => {
    const workspace = await createFixtureWorkspace({ derived: [] });
    const companyPath = join(workspace, "company.gen3.json");
    const company = await Bun.file(companyPath).json();
    company.organization_kind = "template";
    await Bun.write(
      companyPath,
      `${JSON.stringify(company, null, 2)}\n`,
    );
    const result = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "compile-company.mjs"),
        "--organization",
        workspace,
      ],
      {
        env: isolatedGitEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain(
      'FAIL: ownership generated/company-summary.json: očekávána právě jedna klasifikace, matches=[]',
    );

    await rm(workspace, { recursive: true, force: true });
  });

  test("classifies leading globstars with the same semantics as overlap validation", async () => {
    const workspace = await createFixtureWorkspace({
      derived: ["**/generated/*.json", "**/generated/*.md"],
      override: ["company/launchpad/plugins/README.md"],
    });

    const report = await compileOrganization({
      organizationRoot: workspace,
      repositoryObservation: offlineRepositoryObservation,
    });

    expect(report.ownership_summary.derived).toBe(4);
    expect(report.ownership_summary.unclassified).toBe(0);
    expect(report.ownership_summary.ambiguous).toBe(0);

    await rm(workspace, { recursive: true, force: true });
  });

  test("sanitized Organization fixture has complete derived ownership", async () => {
    const exampleRoot = await createFixtureWorkspace();

    await expect(
      compileOrganization({ organizationRoot: exampleRoot }),
    ).rejects.toThrow("schema/semantic validací");
    await expect(
      compileOrganization({
        organizationRoot: exampleRoot,
        repositoryObservation: { status: "offline" },
        write: true,
      }),
    ).rejects.toThrow(
      "Offline repository validace je pouze read-only/dry-run",
    );

    const report = await compileOrganization({
      organizationRoot: exampleRoot,
      repositoryObservation: { status: "offline" },
    });

    expect(report.ownership_summary.derived).toBe(4);
    expect(report.ownership_summary.unclassified).toBe(0);
    expect(report.ownership_summary.ambiguous).toBe(0);
    expect(report.blocked_targets).toEqual([]);
  });

  test("refuses invalid organization config before generating targets", async () => {
    const workspace = await createFixtureWorkspace();
    const companyPath = join(workspace, "company.gen3.json");
    const company = await Bun.file(companyPath).json();
    delete company.business_context.customer_segments;
    await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

    try {
      await compileOrganization({
        organizationRoot: workspace,
        repositoryObservation: offlineRepositoryObservation,
      });
      throw new Error("Compiler měl invalidní config odmítnout");
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationCompilerError);
      expect(error.details.failures.join("\n")).toContain("customer_segments");
    }

    await rm(workspace, { recursive: true, force: true });
  });
});

function initializeLocalFirstCheckout(workspace) {
  for (const args of [
    ["init", "-b", "main", workspace],
    [
      "-C",
      workspace,
      "remote",
      "add",
      "template",
      "git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git",
    ],
    [
      "-C",
      workspace,
      "remote",
      "set-url",
      "--add",
      "--push",
      "template",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      env: isolatedGitEnvironment(),
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  }
}

function initializeRemoteActiveCheckout(workspace) {
  initializeLocalFirstCheckout(workspace);
  for (const args of [
    [
      "-C",
      workspace,
      "remote",
      "add",
      "origin",
      "git@github.com:FixtureOrg/FixtureCompany_GEN3.git",
    ],
    [
      "-C",
      workspace,
      "config",
      "branch.main.remote",
      "origin",
    ],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      env: isolatedGitEnvironment(),
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  }
}

function isolatedGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
}

async function compileCanonicalFixtureCheckout({
  organizationRoot,
  workspaceRoot,
  write = false,
  expectedStatus = "absent",
} = {}) {
  const root = resolve(organizationRoot ?? workspaceRoot);
  const observation = readCheckoutRepositoryObservation(root, {
    environment: {},
    knownHostsInspector: () => true,
    runGit: runFixtureGit,
    runSsh: () => ({
      ok: true,
      stdout: fixtureSshConfig(),
    }),
  });
  expect(observation).toMatchObject({
    status: expectedStatus,
    remoteContract: {
      templateRemoteState: "ready",
      templateRepositoryRemoteNames: ["template"],
    },
  });

  const prepared = await prepareOrganizationCompilation({
    organizationRoot: root,
    write,
    repositoryObservation: observation,
  });
  if (write) {
    for (const target of prepared.writes) {
      const targetPath = join(root, target.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, target.content);
    }
  }
  return prepared.report;
}

function runFixtureGit(root, args) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", root, ...args], {
    env: hermeticGitEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    ok: result.exitCode === 0,
    status: result.exitCode,
    stdout: result.stdout.toString().replace(/\r?\n$/, ""),
  };
}

function hermeticGitEnvironment() {
  const sink = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...isolatedGitEnvironment(),
    GIT_CONFIG_GLOBAL: sink,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: sink,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function fixtureSshConfig() {
  const home = process.platform === "win32"
    ? "C:\\Users\\operator"
    : "/home/operator";
  return [
    "user git",
    "hostname github.com",
    "port 22",
    "canonicalizehostname false",
    "permitlocalcommand no",
    "controlmaster false",
    "controlpersist no",
    "stricthostkeychecking ask",
    `userknownhostsfile ${home}/.ssh/known_hosts`,
    "globalknownhostsfile none",
  ].join("\n");
}


describe("N:M grouping (revize 0041, Team naming 2026-07-11)", () => {
  test("generated index preserves lowercase slug and case-sensitive mount path independently", () => {
    const targets = buildCompanyTargets({
      companyConfig: {
        company: { name: "Mount identity test" },
        modules: [
          {
            slug: "buddy-gen2",
            path: "productionspace/Buddy_GEN2",
            repo: "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git",
          },
        ],
      },
    });
    const { modules } = JSON.parse(
      targets.find((target) => target.kind === "modules-index").content,
    );

    expect(modules[0]).toMatchObject({
      slug: "buddy-gen2",
      path: "productionspace/Buddy_GEN2",
      repo: "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git",
    });
  });

  test("kanonický plurál teams[] se zachová; deprecated singular workspace je alias; default fallback; deprecated workspaces[] roster carry", () => {
    const targets = buildCompanyTargets({
      companyConfig: {
        company: { name: "N:M Test" },
        teams: [
          { slug: "workspace", display_name: "Default", default: true },
          { slug: "sales", display_name: "Sales" },
          { slug: "marketing", display_name: "Marketing" },
        ],
        modules: [
          { slug: "deals", path: "workspace/deals", teams: ["sales", "marketing"] },
          { slug: "old", path: "workspace/old", workspace: "sales" },
          { slug: "plain", path: "workspace/plain" },
          { slug: "firmware", path: "productionspace/firmware" },
        ],
      },
    });
    const index = targets.find((t) => t.kind === "modules-index");
    const { modules, teams } = JSON.parse(index.content);
    expect(modules[0].teams).toEqual(["sales", "marketing"]);
    expect(modules[0].workspace).toBe("sales"); // kompatibilní kopie = první Team
    expect(modules[0]).not.toHaveProperty("workspaces");
    expect(modules[1].teams).toEqual(["sales"]);
    expect(modules[2].teams).toEqual(["workspace"]); // default fallback
    expect(modules[3].teams).toEqual([]); // productionspace není Team
    expect(modules[3].workspace).toBeNull();
    expect(teams.map((t) => t.slug)).toEqual(["workspace", "sales", "marketing"]);
  });

  test("deprecated workspaces[] roster stále nese členství (union rosteru)", () => {
    const targets = buildCompanyTargets({
      companyConfig: {
        // Reálné manifesty používají deprecated workspaces[] roster + singular workspace.
        workspaces: [
          { slug: "workspace", display_name: "Default", default: true },
          { slug: "sales", display_name: "Sales" },
        ],
        modules: [{ slug: "deals", path: "workspace/deals", workspace: "sales" }],
      },
    });
    const { modules } = JSON.parse(targets.find((t) => t.kind === "modules-index").content);
    expect(modules[0].teams).toEqual(["sales"]);
  });

  test("odmítne neexistující Team slug", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: {
          teams: [{ slug: "workspace", display_name: "Default", default: true }],
          modules: [{ slug: "deals", path: "workspace/deals", teams: ["sales"] }],
        },
      }),
    ).toThrow("odkazuje na neexistující Team 'sales'");
  });


  test("odmítne Team memberships u productionspace repa", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: {
          teams: [{ slug: "workspace", display_name: "Default", default: true }],
          modules: [
            { slug: "firmware", path: "productionspace/firmware", teams: ["workspace"] },
          ],
        },
      }),
    ).toThrow("je productionspace repo a nesmí mít Team memberships");
  });
});

describe("Greptile PR #149 — dedupe unionu a přechodový plurál", () => {
  test("stejný slug v teams[] i deprecated workspaces[] → jeden záznam, vyhrává teams[]", () => {
    const targets = buildCompanyTargets({
      companyConfig: {
        company: { name: "Dedupe Test" },
        teams: [{ slug: "sales", display_name: "Sales (canonical)", default: false }],
        workspaces: [
          { slug: "sales", display_name: "Sales (stale copy)", default: true },
          { slug: "ops", display_name: "Ops" },
        ],
        modules: [],
      },
    });
    const index = targets.find((t) => t.kind === "modules-index");
    const { teams } = JSON.parse(index.content);
    const sales = teams.filter((t) => t.slug === "sales");
    expect(sales).toHaveLength(1);
    expect(sales[0].display_name).toBe("Sales (canonical)");
    expect(teams.map((t) => t.slug).sort()).toEqual(["ops", "sales"]);
  });

  test("přechodový plurál modules[].workspaces se čte (manifest psaný proti 0041-mezistavu neztratí skupiny)", () => {
    const targets = buildCompanyTargets({
      companyConfig: {
        company: { name: "Transitional Test" },
        teams: [{ slug: "sales", display_name: "Sales" }, { slug: "marketing", display_name: "Marketing" }],
        modules: [
          { slug: "deals", path: "workspace/deals", workspaces: ["sales", "marketing"] },
        ],
      },
    });
    const index = targets.find((t) => t.kind === "modules-index");
    const { modules } = JSON.parse(index.content);
    expect(modules[0].teams).toEqual(["sales", "marketing"]);
  });
});

describe("module_slots normalizace (Greptile round 2)", () => {
  test("slot s přechodovým workspaces[] dostane kanonické teams v indexu", () => {
    const targets = buildCompanyTargets({
      companyConfig: { company: { name: "Slots Test" }, modules: [] },
      modulesManifest: {
        module_slots: [
          { slug: "deals", path: "workspace/deals", workspaces: ["sales", "marketing"] },
          { slug: "old", path: "workspace/old", workspace: "sales" },
          { slug: "plain", path: "workspace/plain" },
        ],
      },
    });
    const index = targets.find((t) => t.kind === "modules-index");
    const { manifest_slots } = JSON.parse(index.content);
    expect(manifest_slots[0].teams).toEqual(["sales", "marketing"]);
    expect(manifest_slots[1].teams).toEqual(["sales"]);
    expect(manifest_slots[2].teams).toEqual(["workspace"]);
  });
});

describe("productionspace sloty (Greptile round 3)", () => {
  test("productionspace slot bez deklarace → teams [], žádný default", () => {
    const targets = buildCompanyTargets({
      companyConfig: { company: { name: "PS Slots" }, modules: [] },
      modulesManifest: {
        module_slots: [{ slug: "firmware", path: "productionspace/firmware" }],
      },
    });
    const index = targets.find((t) => t.kind === "modules-index");
    const { manifest_slots } = JSON.parse(index.content);
    expect(manifest_slots[0].teams).toEqual([]);
    expect(manifest_slots[0].workspace).toBeNull();
  });

  test("productionspace slot s explicitní Team membership → chyba", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: { company: { name: "PS Slots" }, modules: [] },
        modulesManifest: {
          module_slots: [{ slug: "firmware", path: "productionspace/firmware", teams: ["sales"] }],
        },
      }),
    ).toThrow(/productionspace a nesmí mít Team memberships/);
  });
});

describe("Organization root sloty", () => {
  test("primární Design System se materializuje mimo Teamy", () => {
    const targets = buildCompanyTargets({
      companyConfig: {
        company: { name: "Root Slots" },
        teams: [{ slug: "workspace", display_name: "Default", default: true }],
        modules: [],
      },
      modulesManifest: {
        module_slots: [
          {
            slug: "design-system",
            path: "design-system",
            git: { url: "git@github.com:Example/design-system.git", branch: "main" },
          },
        ],
      },
    });
    const index = targets.find((target) => target.kind === "modules-index");
    const { manifest_slots: manifestSlots } = JSON.parse(index.content);

    expect(manifestSlots[0]).toMatchObject({
      path: "design-system",
      space: "root",
      teams: [],
      workspace: null,
    });
  });

  test("root slot odmítne i prázdné Team membership pole", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: {
          teams: [{ slug: "workspace", display_name: "Default", default: true }],
          modules: [],
        },
        modulesManifest: {
          module_slots: [
            { slug: "design-system", path: "design-system", teams: [] },
          ],
        },
      }),
    ).toThrow("je root a nesmí mít Team memberships");
  });

  test("root slot odmítne legacy checkout souřadnice vedle git objektu", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: { modules: [] },
        modulesManifest: {
          module_slots: [
            {
              slug: "design-system",
              path: "design-system",
              repo: "git@github.com:WrongOrg/wrong-design-system.git",
              branch: "legacy",
              git: {
                url: "git@github.com:Example/design-system.git",
                branch: "main",
              },
            },
          ],
        },
      }),
    ).toThrow(
      "nesmí deklarovat legacy checkout souřadnice (repo, branch)",
    );
  });

  test("aktivní nested repo bez checkout údajů odmítne", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: { modules: [] },
        modulesManifest: {
          module_slots: [{ slug: "design-system", path: "design-system" }],
        },
      }),
    ).toThrow("musí mít git.url a git.branch");
  });

  test("planned nested repo smí čekat na checkout údaje", () => {
    const targets = buildCompanyTargets({
      companyConfig: { modules: [] },
      modulesManifest: {
        module_slots: [
          { slug: "design-system", path: "design-system", status: "planned_slot" },
        ],
      },
    });
    const index = targets.find((target) => target.kind === "modules-index");
    const { manifest_slots: manifestSlots } = JSON.parse(index.content);

    expect(manifestSlots[0]).toMatchObject({
      path: "design-system",
      status: "planned_slot",
      space: "root",
      teams: [],
      workspace: null,
    });
  });

  test("planned nested repo nesmí současně deklarovat git", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: { modules: [] },
        modulesManifest: {
          module_slots: [
            {
              slug: "design-system",
              path: "design-system",
              status: "planned_slot",
              git: {
                url: "git@github.com:Example/design-system.git",
                branch: "main",
              },
            },
          ],
        },
      }),
    ).toThrow("Planned nested repo slot 'design-system' nesmí deklarovat git");
  });

  test("Mission Control app/code i data se materializují jako root sloty", () => {
    const targets = buildCompanyTargets({
      companyConfig: { modules: [] },
      modulesManifest: {
        module_slots: [
          {
            path: "mission-control",
            space: "root",
            git: {
              url: "git@github.com:Example/mission-control.git",
              branch: "main",
            },
          },
          {
            path: "mission-control/db",
            space: "root",
            git: {
              url: "git@github.com:Example/mission-control-data.git",
              branch: "v3",
            },
          },
        ],
      },
    });
    const index = targets.find((target) => target.kind === "modules-index");
    const { manifest_slots: manifestSlots } = JSON.parse(index.content);

    expect(manifestSlots).toEqual([
      expect.objectContaining({
        path: "mission-control",
        space: "root",
        teams: [],
        workspace: null,
      }),
      expect.objectContaining({
        path: "mission-control/db",
        space: "root",
        teams: [],
        workspace: null,
      }),
    ]);
  });

  test("aktivní Mission Control data odmítnou planned parent app/code slot", () => {
    expect(() =>
      buildCompanyTargets({
        companyConfig: { modules: [] },
        modulesManifest: {
          module_slots: [
            {
              path: "mission-control",
              space: "root",
              status: "planned_slot",
            },
            {
              path: "mission-control/db",
              space: "root",
              git: {
                url: "git@github.com:Example/mission-control-data.git",
                branch: "v3",
              },
            },
          ],
        },
      }),
    ).toThrow(
      "Aktivní mission-control/db vyžaduje aktivní parent mission-control s git.url a git.branch",
    );
  });

  test("planned Mission Control data dovolí active i planned parent app/code slot", () => {
    for (const appSlot of [
      {
        path: "mission-control",
        space: "root",
        git: {
          url: "git@github.com:Example/mission-control.git",
          branch: "main",
        },
      },
      {
        path: "mission-control",
        space: "root",
        status: "planned_slot",
      },
    ]) {
      const targets = buildCompanyTargets({
        companyConfig: { modules: [] },
        modulesManifest: {
          module_slots: [
            appSlot,
            {
              path: "mission-control/db",
              space: "root",
              status: "planned_slot",
            },
          ],
        },
      });
      const index = targets.find((target) => target.kind === "modules-index");
      const { manifest_slots: manifestSlots } = JSON.parse(index.content);
      expect(manifestSlots).toHaveLength(2);
    }
  });
});
