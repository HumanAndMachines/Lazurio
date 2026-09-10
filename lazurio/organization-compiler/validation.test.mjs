import { describe, expect, test } from "bun:test";
import {
  repositoryObservationAuthorizesTemplateWrite,
  validateOrganizationDocuments,
} from "./validation.mjs";
import {
  githubRepositoryUrlIdentity,
} from "./repository-identity.mjs";

describe("organization config validation", () => {
  test("accepts flat workspace and productionspace paths", async () => {
    const documents = createValidDocuments();
    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("accepts a stable lowercase slug with an exact case-preserving repository mount", async () => {
    const documents = createValidDocuments();
    const module = documents.companyConfig.modules[1];
    const slot = documents.modulesManifest.module_slots[1];
    module.slug = "buddy-gen2";
    module.path = "productionspace/Buddy_GEN2";
    module.repo = "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git";
    slot.slug = "buddy-gen2";
    slot.path = "productionspace/Buddy_GEN2";
    slot.git.url = "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("requires an explicit manifest slug when the mount basename cannot be the stable id", async () => {
    const documents = createValidDocuments();
    const module = documents.companyConfig.modules[1];
    const slot = documents.modulesManifest.module_slots[1];
    module.slug = "buddy-gen2";
    module.path = "productionspace/Buddy_GEN2";
    module.repo = "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git";
    slot.path = "productionspace/Buddy_GEN2";
    slot.git.url = "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots/productionspace/Buddy_GEN2: slug je povinný, protože stabilní identita nejde bezpečně odvodit z basename cesty",
    );
  });

  test("keeps matching lowercase legacy slots valid without a repeated manifest slug", async () => {
    const result = await validateOrganizationDocuments(createValidDocuments());

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("requires an explicit stable slug for the mission-control data mount", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots.push({
      path: "mission-control/db",
      space: "root",
      category: "planning-data",
      default_access: "restricted",
      required_roles: ["steward"],
      source_of_truth: "repository-db:v3",
      status: "planned_slot",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots/mission-control/db: slug je povinný, protože stabilní identita nejde bezpečně odvodit z basename cesty",
    );
  });

  test("rejects a different slug for the mission-control data mount", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots.push({
      slug: "other-data",
      path: "mission-control/db",
      space: "root",
      category: "planning-data",
      default_access: "restricted",
      required_roles: ["steward"],
      source_of_truth: "repository-db:v3",
      status: "planned_slot",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots/mission-control/db: slug musí být mission-control-data",
    );
    expect(result.failures).toContain(
      "modules.manifest.json/: $.module_slots[3].slug: hodnota musí být \"mission-control-data\"",
    );
  });

  test("does not report duplicate undefined slugs beside missing-slug schema failures", async () => {
    const documents = createValidDocuments();
    delete documents.companyConfig.modules[0].slug;
    delete documents.companyConfig.modules[1].slug;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).not.toContain(
      "company.gen3.json/modules: duplicitní slug undefined",
    );
  });

  test("rejects duplicate stable module slugs even when mount paths differ", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules[1].slug = "knowledgebase";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/modules: duplicitní slug knowledgebase",
    );
  });

  test("rejects duplicate declared manifest slot slugs", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots[0].slug = "shared-module";
    documents.modulesManifest.module_slots[1].slug = "shared-module";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots: duplicitní slug shared-module",
    );
  });

  test("rejects a declared slug that collides with a legacy slot basename", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots.push({
      slug: "knowledgebase",
      path: "productionspace/Other_GEN2",
      category: "operations",
      default_access: "restricted",
      required_roles: ["founder"],
      source_of_truth: "git-native",
      status: "planned_slot",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots: duplicitní slug knowledgebase",
    );
  });

  test("rejects a declared manifest slug that disagrees with the company module", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots[1].slug = "other-firmware";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      'Module kontrakt productionspace/firmware/slug se rozchází: company="firmware", manifest="other-firmware"',
    );
  });

  test("rejects mount paths that collide on case-insensitive filesystems", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules.push({
      ...documents.companyConfig.modules[0],
      slug: "knowledgebase-shadow",
      path: "workspace/Knowledgebase",
      repo: "git@github.com:FixtureOrg/Knowledgebase.git",
    });
    documents.modulesManifest.module_slots.push({
      ...documents.modulesManifest.module_slots[0],
      path: "workspace/Knowledgebase",
      git: {
        ...documents.modulesManifest.module_slots[0].git,
        url: "git@github.com:FixtureOrg/Knowledgebase.git",
      },
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/modules: path workspace/Knowledgebase koliduje po case-foldingu s workspace/knowledgebase",
    );
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots: path workspace/Knowledgebase koliduje po case-foldingu s workspace/knowledgebase",
    );
  });

  test("reports a targeted cross-file error when matching mount paths differ only by case", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots[1].path = "productionspace/Firmware";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Module path se mezi company a manifestem liší pouze velikostí písmen: company=productionspace/firmware, manifest=productionspace/Firmware",
    );
    expect(result.failures).not.toContain(
      "company.gen3.json/modules: chybí deklarace pro manifest slot productionspace/Firmware",
    );
    expect(result.failures).not.toContain(
      "modules.manifest.json/module_slots/productionspace/Firmware: slug je povinný, protože stabilní identita nejde bezpečně odvodit z basename cesty",
    );
  });

  test.each([
    "productionspace/Buddy GEN2",
    "productionspace/.Buddy_GEN2",
    "productionspace/Buddy_GEN2.",
    "productionspace/Nested/Buddy_GEN2",
  ])("rejects unsafe repository mount path %s", async (path) => {
    const documents = createValidDocuments();
    documents.companyConfig.modules[1].path = path;
    documents.modulesManifest.module_slots[1].path = path;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.some((failure) => failure.includes("path"))).toBe(true);
  });

  test("local-first consumer requires trusted checkout evidence outside explicit offline dry-run", async () => {
    const documents = createValidDocuments();
    delete documents.repositoryObservation;

    const unchecked = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: null,
    });
    expect(unchecked.valid).toBe(false);
    expect(unchecked.failures).toContain(
      "company.gen3.json/template_sync_role: consumer Organizace vyžaduje důvěryhodné pozorování checkoutu; bez něj je povolený pouze explicitní offline dry-run",
    );

    const unavailable = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: { status: "unavailable" },
    });
    expect(unavailable.valid).toBe(false);
    expect(unavailable.failures).toContain(
      "company.gen3.json/template_sync_role: consumer Organizace vyžaduje důvěryhodné pozorování checkoutu; bez něj je povolený pouze explicitní offline dry-run",
    );

    const observed = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: {
        status: "absent",
        remoteContract: {
          originRoutingReady: false,
          templateRemoteState: "ready",
          templateRepositoryRemoteNames: ["template"],
          allRemoteUrlsSafeGithub: false,
        },
      },
    });
    expect(observed.valid).toBe(true);
  });

  test("template source authorization stays outside the public consumer compiler", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.template_sync_role = "source";
    documents.companyConfig.template_sync_authorization = { source_repository_id: 123, source_repository: "FixtureOrg/FixtureCompany_GEN3", decision_ref: "fixture-decision" };
    const result = await validateOrganizationDocuments(documents);
    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("separate template publisher");
  });

  test("binds consumer remote-active coordinates to the observed checkout origin", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.company.repository =
      "git@github.com:FixtureOrg/FixtureCompany_GEN3.git";
    documents.companyConfig.company.root_repository =
      "FixtureOrg/FixtureCompany_GEN3";
    const mismatch = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation:
        consumerRepositoryObservation("other/Other_GEN3"),
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.failures).toContain(
      "company.gen3.json/company: checkout origin musí odpovídat deklarované repository identitě",
    );

    const absent = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: {
        status: "absent",
        remoteContract: {
          originRoutingReady: false,
          templateRemoteState: "ready",
          templateRepositoryRemoteNames: ["template"],
          allRemoteUrlsSafeGithub: false,
        },
      },
    });
    expect(absent.valid).toBe(false);
    expect(absent.failures).toContain(
      "company.gen3.json/company: remote-active deklarace vyžaduje přítomný bezpečně čitelný checkout origin",
    );

    const unavailable = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: { status: "unavailable" },
    });
    expect(unavailable.valid).toBe(false);
    expect(unavailable.failures).toContain(
      "company.gen3.json/company: remote-active deklarace vyžaduje důvěryhodné pozorování checkout rootu a originu",
    );

    const unchecked = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: null,
    });
    expect(unchecked.valid).toBe(false);
    expect(unchecked.failures).toContain(
      "company.gen3.json/company: remote-active deklarace vyžaduje důvěryhodné pozorování checkout rootu a originu",
    );

    const offline = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: { status: "offline" },
    });
    expect(offline.valid).toBe(true);

    const unknown = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: { status: "unchecked" },
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.failures).toContain(
      "company.gen3.json/company: neznámý stav repository pozorování nesmí obejít checkout identity gate",
    );

    const matching = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: consumerRepositoryObservation(
        "fixtureorg/FixtureCompany_GEN3",
      ),
    });
    expect(matching.valid).toBe(true);

    for (const templateRemoteState of ["missing", "invalid"]) {
      const observation = consumerRepositoryObservation(
        "fixtureorg/FixtureCompany_GEN3",
      );
      observation.remoteContract.templateRemoteState =
        templateRemoteState;
      const unsafeTemplate = await validateOrganizationDocuments({
        ...documents,
        repositoryObservation: observation,
      });
      expect(unsafeTemplate.valid).toBe(false);
      expect(unsafeTemplate.failures).toContain(
        "company.gen3.json/template_sync_role: consumer checkout vyžaduje přesný fetch-only OrganizationTemplate remote s OS-native push sinkem",
      );
    }

    const unsafeOrigin = consumerRepositoryObservation(
      "fixtureorg/FixtureCompany_GEN3",
    );
    unsafeOrigin.remoteContract.originRoutingReady = false;
    const unsafeOriginResult = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: unsafeOrigin,
    });
    expect(unsafeOriginResult.valid).toBe(false);
    expect(unsafeOriginResult.failures).toContain(
      "company.gen3.json/company: remote-active checkout vyžaduje bezpečný origin fetch/push routing a všechen branch push routing na origin včetně branch.main.remote=origin",
    );

    delete documents.companyConfig.company.repository;
    delete documents.companyConfig.company.root_repository;
    const falseLocalFirst = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: consumerRepositoryObservation(
        "fixtureorg/FixtureCompany_GEN3",
      ),
    });
    expect(falseLocalFirst.valid).toBe(false);
    expect(falseLocalFirst.failures).toContain(
      "company.gen3.json/company: checkout s přítomným nebo nečitelným originem nesmí předstírat local-first stav",
    );
  });

  test("rejects source authorization on a consumer Organization", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.template_sync_authorization = {
      decision_ref:
        "docs/decisions/0032-organization-template-derived-from-FixtureSource.md",
      source_repository_id: 123456789,
      source_repository: "FixtureSource/FixtureSource_GEN3",
    };

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/template_sync_authorization: smí být přítomná pouze pro template_sync_role=source",
    );
  });

  test("template checkout odmítne explicitní consumer/source roli", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.organization_kind = "template";
    documents.companyConfig.template_sync_role = "consumer";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/template_sync_role: organization_kind=template nesmí deklarovat Organization consumer/source roli",
    );
  });

  test("template checkout může deklarovat vlastní repository bez Organization root souřadnice", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.organization_kind = "template";
    documents.companyConfig.company.repository =
      "git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git";
    delete documents.companyConfig.company.root_repository;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("template write autorizuje jen canonical trusted checkout observation", () => {
    const canonical = {
      immutableTemplateIdentityVerified: true,
      status: "valid",
      identity:
        "templatesrozjedeme-ai/OrganizationTemplate_GEN3",
      remoteContract: {
        originRoutingReady: true,
        templateRemoteState: "missing",
        templateRepositoryRemoteNames: ["origin"],
        allRemoteUrlsSafeGithub: true,
      },
    };
    expect(
      repositoryObservationAuthorizesTemplateWrite(canonical),
    ).toBe(true);
    for (const unsafe of [
      { ...canonical, identity: "fixtureorg/FixtureCompany_GEN3" },
      {
        ...canonical,
        remoteContract: {
          ...canonical.remoteContract,
          originRoutingReady: false,
        },
      },
      {
        ...canonical,
        remoteContract: {
          ...canonical.remoteContract,
          templateRemoteState: "ready",
          templateRepositoryRemoteNames: ["template"],
        },
      },
    ]) {
      expect(
        repositoryObservationAuthorizesTemplateWrite(unsafe),
      ).toBe(false);
    }
  });

  test("binds remote-active repository coordinates to one GitHub identity", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.company.root_repository =
      "FixtureOrg/FixtureCompany_GEN3";
    documents.companyConfig.company.repository =
      "git@github.com:FixtureOrg/OtherCompany_GEN3.git";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/company: repository a root_repository musí označovat stejné GitHub owner/repo",
    );
  });

  test("SSH repository URL vyžaduje přesně lowercase user git", () => {
    for (const value of [
      "GIT@github.com:FixtureOrg/FixtureCompany_GEN3.git",
      "Git@github.com:FixtureOrg/FixtureCompany_GEN3.git",
      "ssh://GIT@github.com/FixtureOrg/FixtureCompany_GEN3.git",
    ]) {
      expect(githubRepositoryUrlIdentity(value)).toBeNull();
    }
    expect(
      githubRepositoryUrlIdentity(
        "git@GitHub.com:FixtureOrg/FixtureCompany_GEN3.git",
      ),
    ).toBe("fixtureorg/FixtureCompany_GEN3");
    expect(
      githubRepositoryUrlIdentity(
        "SSH://git@GitHub.com/FixtureOrg/FixtureCompany_GEN3.git",
      ),
    ).toBe("fixtureorg/FixtureCompany_GEN3");
  });

  test("normalizes only the GitHub owner while preserving exact repository casing", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.company.root_repository =
      "FixtureOrg/FixtureCompany_GEN3";
    documents.companyConfig.company.repository =
      "git@github.com:fixtureorg/fixtureCompany_GEN3.git";

    const coordinateMismatch = await validateOrganizationDocuments(
      documents,
    );
    expect(coordinateMismatch.valid).toBe(false);
    expect(coordinateMismatch.failures).toContain(
      "company.gen3.json/company: repository a root_repository musí označovat stejné GitHub owner/repo",
    );

    documents.companyConfig.company.repository =
      "git@github.com:fixtureorg/FixtureCompany_GEN3.git";
    const originCaseMismatch = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: consumerRepositoryObservation(
        "fixtureorg/fixtureCompany_GEN3",
      ),
    });
    expect(originCaseMismatch.valid).toBe(false);
    expect(originCaseMismatch.failures).toContain(
      "company.gen3.json/company: checkout origin musí odpovídat deklarované repository identitě",
    );

    const matching = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: consumerRepositoryObservation(
        "fixtureorg/FixtureCompany_GEN3",
      ),
    });
    expect(matching.valid).toBe(true);
    expect(matching.failures).toEqual([]);
  });

  test("allows an explicit root repository name distinct from the Organization slug", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.company.root_repository =
      "FixtureOrg/Fixture-Holding_GEN3";
    documents.companyConfig.company.repository =
      "git@github.com:FixtureOrg/Fixture-Holding_GEN3.git";
    documents.repositoryObservation =
      consumerRepositoryObservation(
        "fixtureorg/Fixture-Holding_GEN3",
        {
          checkoutRoot:
            "/organizations/Fixture-Holding_GEN3",
        },
      );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("binds root_repository to the canonical physical checkout basename", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.company.root_repository =
      "FixtureOrg/FixtureCompany_GEN3";
    documents.companyConfig.company.repository =
      "git@github.com:FixtureOrg/FixtureCompany_GEN3.git";

    const missingRoot = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: {
        ...consumerRepositoryObservation(
          "fixtureorg/FixtureCompany_GEN3",
        ),
        checkoutRoot: undefined,
      },
    });
    expect(missingRoot.valid).toBe(false);
    expect(missingRoot.failures).toContain(
      "company.gen3.json/company: důvěryhodné pozorování checkoutu neobsahuje kanonický fyzický checkout root",
    );

    const posixCaseMismatch = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: consumerRepositoryObservation(
        "fixtureorg/FixtureCompany_GEN3",
        {
          checkoutRoot:
            "/organizations/fixturecompany_gen3",
        },
      ),
    });
    expect(posixCaseMismatch.valid).toBe(false);
    expect(posixCaseMismatch.failures).toContain(
      "company.gen3.json/company: basename fyzického checkout rootu musí odpovídat repository komponentě root_repository",
    );

    const windowsCaseVariant = await validateOrganizationDocuments({
      ...documents,
      repositoryObservation: consumerRepositoryObservation(
        "fixtureorg/FixtureCompany_GEN3",
        {
          checkoutRoot:
            "C:\\organizations\\FIXTURECOMPANY_GEN3",
          checkoutPlatform: "win32",
        },
      ),
    });
    expect(windowsCaseVariant.valid).toBe(true);
    expect(windowsCaseVariant.failures).toEqual([]);
  });

  test("rejects repository coordinates with trailing line terminators", async () => {
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
      const repositoryDocuments = createValidDocuments();
      repositoryDocuments.companyConfig.company.repository += terminator;
      const repositoryResult =
        await validateOrganizationDocuments(repositoryDocuments);
      expect(repositoryResult.valid).toBe(false);

      const coordinateDocuments = createValidDocuments();
      coordinateDocuments.companyConfig.company.root_repository += terminator;
      const coordinateResult =
        await validateOrganizationDocuments(coordinateDocuments);
      expect(coordinateResult.valid).toBe(false);
    }
  });

  test("keeps modules paths as explicit migration compatibility with warnings", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules[0].path = "modules/knowledgebase";
    documents.modulesManifest.module_slots[0].path = "modules/knowledgebase";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      "company.gen3.json/modules: modules/knowledgebase používá deprecated GEN2 path",
      "modules.manifest.json/module_slots: modules/knowledgebase používá deprecated GEN2 path",
    ]);
  });

  test("rejects productionspace modeled as a Team", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules[1].teams = ["productionspace"];
    documents.modulesManifest.module_slots[1].teams = ["productionspace"];

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("hodnota odpovídá zakázané 'not' větvi");
    expect(result.failures.join("\n")).toContain("productionspace repo nesmí mít Team memberships");
  });

  test("does not bypass required business and governance fields", async () => {
    const documents = createValidDocuments();
    delete documents.companyConfig.business_context.customer_segments;
    delete documents.companyConfig.governance.file_ownership;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("customer_segments");
    expect(result.failures.join("\n")).toContain("file_ownership");
  });

  test("keeps legacy three-class ownership readable only as a migration warning", async () => {
    const documents = createValidDocuments();
    delete documents.companyConfig.governance.file_ownership.derived;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      "company.gen3.json/governance/file_ownership: chybí derived; legacy GEN3 konfigurace zůstává čitelná pro migraci, ale compiler closeout vyžaduje explicitní derived klasifikaci",
    );
  });

  test("rejects ownership patterns that overlap across classifications", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.governance.file_ownership.managed = [
      "company/generated/**",
    ];
    documents.companyConfig.governance.file_ownership.override = ["company/**"];

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      'company.gen3.json/governance/file_ownership: patterny "company/generated/**" (managed) a "company/**" (override) se překrývají; jedna cesta smí mít právě jednu ownership klasifikaci',
    );
  });

  test("rejects ordinary wildcard ownership overlaps with exact paths", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.governance.file_ownership.managed = [
      "company/*.json",
    ];
    documents.companyConfig.governance.file_ownership.override = [
      "company/config.json",
    ];

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      'company.gen3.json/governance/file_ownership: patterny "company/*.json" (managed) a "company/config.json" (override) se překrývají; jedna cesta smí mít právě jednu ownership klasifikaci',
    );
  });

  test("schema-invalid ownership buckets return failures instead of throwing", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.governance.file_ownership.managed = 1;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "company.gen3.json/: $.governance.file_ownership.managed: očekáváno pole",
    );
  });

  test("allows additional ignored local paths while still requiring archive and private", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.colleague_overlays.gitignored_local_paths.push("scratch/", ".vscode/settings.json");

    const valid = await validateOrganizationDocuments(documents);
    expect(valid.valid).toBe(true);

    documents.companyConfig.colleague_overlays.gitignored_local_paths = ["archive/", "scratch/"];
    const missingPrivate = await validateOrganizationDocuments(documents);
    expect(missingPrivate.valid).toBe(false);
    expect(missingPrivate.failures.join("\n")).toContain("pole neobsahuje žádnou položku odpovídající 'contains'");
  });

  test("requires company and manifest Team memberships to agree", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots[0].teams = ["sales"];

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      'Team deklarace workspace/knowledgebase se rozchází: company=["workspace"], manifest=["sales"]',
    );
  });

  test("canonical Team memberships override both deprecated aliases", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules[0].teams = ["sales"];
    documents.companyConfig.modules[0].workspaces = ["workspace"];
    documents.companyConfig.modules[0].workspace = "workspace";
    documents.modulesManifest.module_slots[0].teams = ["sales"];
    documents.modulesManifest.module_slots[0].workspaces = ["workspace"];
    documents.modulesManifest.module_slots[0].workspace = "workspace";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("accepts the transitional plural membership alias without losing N:M intent", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules[0].workspaces = ["sales", "workspace"];
    documents.modulesManifest.module_slots[0].workspaces = ["workspace", "sales"];

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("binds manifest identity only to canonical company.slug", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.company = documents.companyConfig.company.display_name;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      'modules.manifest.json/company: "Fixture Company" neodpovídá canonical company.slug "FixtureCompany"',
    );
  });

  test("rejects productionspace category, source, access, roles and repository drift", async () => {
    const documents = createValidDocuments();
    const slot = documents.modulesManifest.module_slots[1];
    slot.category = "operations";
    slot.source_of_truth = "external-system";
    slot.default_access = "expected";
    slot.required_roles = ["*"];
    slot.git.url = "git@github.com:FixtureOrg/other-firmware.git";

    const result = await validateOrganizationDocuments(documents);
    const failures = result.failures.join("\n");

    expect(result.valid).toBe(false);
    expect(failures).toContain("productionspace/firmware/category se rozchází");
    expect(failures).toContain("productionspace/firmware/source_of_truth se rozchází");
    expect(failures).toContain("productionspace/firmware/access.default se rozchází");
    expect(failures).toContain("productionspace/firmware/access.roles se rozchází");
    expect(failures).toContain("productionspace/firmware/repo se rozchází");
  });

  test("accepts equivalent GitHub SSH and HTTPS repository identities", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots[0].git.url =
      "https://github.com/FixtureOrg/knowledgebase.git";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("requires the canonical root modules manifest even for an empty Organization", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.modules = [];

    const result = await validateOrganizationDocuments({
      companyConfig: documents.companyConfig,
      modulesManifest: null,
    });

    expect(result.valid).toBe(false);
    expect(result.failures).toContain("modules.manifest.json: chybí canonical root deskriptor Organizace");
  });

  test("allows a planned manifest slot before it becomes an active company module", async () => {
    const documents = createValidDocuments();
    documents.modulesManifest.module_slots.push({
      path: "workspace/brainstorm",
      category: "innovation",
      default_access: "role_based",
      required_roles: ["founder"],
      source_of_truth: "git-native",
      status: "planned_slot",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
  });

  test("accepts the primary Design System as an Organization root nested repo", async () => {
    const documents = createValidDocuments();

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
    expect(
      documents.modulesManifest.module_slots.find((slot) => slot.path === "design-system"),
    ).toMatchObject({
      space: "root",
      git: { url: "git@github.com:FixtureOrg/design-system.git", branch: "main" },
    });
  });

  test("rejects Team membership on an Organization root slot", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    designSystem.teams = ["workspace"];

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "modules.manifest.json/module_slots/design-system: Organization root slot nesmí mít Team memberships",
    );
  });

  test("rejects legacy checkout aliases on an Organization root slot", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    designSystem.repo = "git@github.com:WrongOrg/wrong-design-system.git";
    designSystem.repository = "WrongOrg/wrong-design-system";
    designSystem.branch = "legacy";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "Organization root slot nesmí deklarovat legacy checkout souřadnice (repo, repository, branch)",
    );
  });

  test("rejects an active Design System without checkout coordinates", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    delete designSystem.git;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "aktivní nested repo musí mít git.url a git.branch; bez checkout údajů použij status planned_slot",
    );
  });

  test("allows a planned Design System slot without checkout coordinates", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    delete designSystem.git;
    designSystem.status = "planned_slot";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
  });

  test("rejects checkout coordinates on a planned Design System slot", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    designSystem.status = "planned_slot";
    designSystem.git = {
      url: "git@github.com:FixtureOrg/design-system.git",
      branch: "main",
    };

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "planned nested repo nesmí deklarovat git; s checkout souřadnicemi už jde o aktivní nebo missing-access slot",
    );
  });

  test("requires every declared nested root layer to have a manifest slot", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.layers.push({
      path: "infra",
      kind: "infra",
      ownership: "manual",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "modules.manifest.json/module_slots: root vrstva infra z company.gen3.json/layers nemá manifest slot",
    );
  });

  test("requires every primary root manifest slot to have a declared layer", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.layers = documents.companyConfig.layers.filter(
      (layer) => layer.path !== "design-system",
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/layers: root slot design-system z modules.manifest.json nemá deklarovanou root vrstvu",
    );
  });

  test("requires the canonical kind for every primary root layer", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.layers.find(
      (layer) => layer.path === "design-system",
    ).kind = "guide";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/layers: root vrstva design-system musí používat kind design-system; nalezeno guide",
    );
  });

  test("rejects duplicate primary root layer declarations", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.layers.push({
      path: "design-system",
      kind: "design-system",
      ownership: "manual",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/layers: root vrstva design-system musí mít právě jeden záznam; nalezeno 2",
    );
  });

  test("accepts Mission Control app/code and data as separate active root repos", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    useActiveMissionControlTaskSources(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        git: {
          url: "git@github.com:FixtureOrg/mission-control.git",
          branch: "main",
        },
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        git: {
          url: "git@github.com:FixtureOrg/mission-control-data.git",
          branch: "v3",
        },
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
  });

  test("requires active Mission Control data to own TODO and DONE task truth", async () => {
    const documents = createValidDocuments();
    declareActiveMissionControl(documents);

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/task_sources: aktivní mission-control/db vyžaduje právě jeden todo-tasks-json source-of-truth na cestě mission-control/db/data/mission-control/TODO.tasks.json",
    );
    expect(result.failures).toContain(
      "company.gen3.json/task_sources: aktivní mission-control/db vyžaduje právě jeden done-tasks-json source-of-truth na cestě mission-control/db/data/mission-control/DONE.tasks.json",
    );
    expect(result.failures).toContain(
      "company.gen3.json/task_sources: root TODO.tasks.json smí být při aktivním mission-control/db pouze authority mirror",
    );
    expect(result.failures).toContain(
      "company.gen3.json/task_sources: root DONE.tasks.json smí být při aktivním mission-control/db pouze authority mirror",
    );
  });

  test("rejects duplicate task truth beside active Mission Control data", async () => {
    const documents = createValidDocuments();
    declareActiveMissionControl(documents);
    useActiveMissionControlTaskSources(documents);
    documents.companyConfig.task_sources.push({
      slug: "duplicate-todo",
      kind: "todo-tasks-json",
      path: "workspace/tasks/TODO.tasks.json",
      authority: "source-of-truth",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "company.gen3.json/task_sources: aktivní mission-control/db vyžaduje právě jeden todo-tasks-json source-of-truth na cestě mission-control/db/data/mission-control/TODO.tasks.json",
    );
  });

  test("keeps root task truth valid while Mission Control data is planned", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        status: "planned_slot",
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "repository-db:v3",
        status: "planned_slot",
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
  });

  test("requires Mission Control app/code and data declarations as a pair", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    documents.modulesManifest.module_slots.push({
      path: "mission-control",
      space: "root",
      category: "planning",
      default_access: "role_based",
      required_roles: ["steward"],
      source_of_truth: "git-native",
      git: {
        url: "git@github.com:FixtureOrg/mission-control.git",
        branch: "main",
      },
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "Mission Control app/data boundary musí deklarovat oba root sloty; chybí mission-control/db",
    );
  });

  test("allows a planned Mission Control counterpart during migration", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        git: {
          url: "git@github.com:FixtureOrg/mission-control.git",
          branch: "main",
        },
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        status: "planned_slot",
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
  });

  test("allows both Mission Control app/code and data to remain planned", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        status: "planned_slot",
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "repository-db:v3",
        status: "planned_slot",
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(true);
  });

  test("rejects active Mission Control data while the parent app/code slot is planned", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    useActiveMissionControlTaskSources(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        status: "planned_slot",
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "repository-db:v3",
        git: {
          url: "git@github.com:FixtureOrg/mission-control-data.git",
          branch: "v3",
        },
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "aktivní mission-control/db vyžaduje aktivní parent mission-control s git.url a git.branch",
    );
  });

  test("requires the v3 branch for Mission Control data", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    useActiveMissionControlTaskSources(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        git: {
          url: "git@github.com:FixtureOrg/mission-control.git",
          branch: "main",
        },
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        git: {
          url: "git@github.com:FixtureOrg/mission-control-data.git",
          branch: "main",
        },
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "Mission Control data repo musí používat větev v3",
    );
  });

  test("requires the canonical mission-control layer kind", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    documents.companyConfig.layers.find(
      (layer) => layer.path === "mission-control",
    ).kind = "root-docs";
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        status: "planned_slot",
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "repository-db:v3",
        status: "planned_slot",
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("hodnota musí být");
  });

  test("reserves the mission-control layer kind for the canonical path", async () => {
    const documents = createValidDocuments();
    documents.companyConfig.layers.push({
      path: "planning-alias",
      kind: "mission-control",
      ownership: "manual",
    });

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("hodnota musí být");
  });

  test("rejects active Mission Control app/code without checkout coordinates", async () => {
    const documents = createValidDocuments();
    declareMissionControlLayer(documents);
    documents.modulesManifest.module_slots.push(
      {
        path: "mission-control",
        space: "root",
        category: "planning",
        default_access: "role_based",
        required_roles: ["steward"],
        source_of_truth: "git-native",
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
        space: "root",
        category: "planning-data",
        default_access: "restricted",
        required_roles: ["steward"],
        source_of_truth: "git-native",
        status: "planned_slot",
      },
    );

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "modules.manifest.json/module_slots/mission-control: aktivní nested repo musí mít git.url a git.branch",
    );
  });

  test("rejects a root slot mislabeled as workspace scope", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    designSystem.space = "workspace";

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("hodnota musí být");
  });

  test("requires an explicit root scope on Organization root slots", async () => {
    const documents = createValidDocuments();
    const designSystem = documents.modulesManifest.module_slots.find(
      (slot) => slot.path === "design-system",
    );
    delete designSystem.space;

    const result = await validateOrganizationDocuments(documents);

    expect(result.valid).toBe(false);
    expect(result.failures.join("\n")).toContain("chybí povinné pole 'space'");
  });
});

function sourceRepositoryObservation(
  identity,
  {
    checkoutRoot = "/organizations/FixtureSource_GEN3",
    checkoutPlatform = "linux",
  } = {},
) {
  return {
    status: "valid",
    identity,
    checkoutRoot,
    checkoutPlatform,
    remoteContract: {
      originRoutingReady: true,
      templateRemoteState: "missing",
      templateRepositoryRemoteNames: [],
      allRemoteUrlsSafeGithub: true,
    },
  };
}

function consumerRepositoryObservation(
  identity,
  {
    checkoutRoot = "/organizations/FixtureCompany_GEN3",
    checkoutPlatform = "linux",
  } = {},
) {
  return {
    status: "valid",
    identity,
    checkoutRoot,
    checkoutPlatform,
    remoteContract: {
      originRoutingReady: true,
      templateRemoteState: "ready",
      templateRepositoryRemoteNames: ["template"],
      allRemoteUrlsSafeGithub: false,
    },
  };
}

function declareMissionControlLayer(documents) {
  documents.companyConfig.layers.push({
    path: "mission-control",
    kind: "mission-control",
    ownership: "manual",
  });
}

function declareActiveMissionControl(documents) {
  declareMissionControlLayer(documents);
  documents.modulesManifest.module_slots.push(
    {
      path: "mission-control",
      space: "root",
      category: "planning",
      default_access: "role_based",
      required_roles: ["steward"],
      source_of_truth: "git-native",
      git: {
        url: "git@github.com:FixtureOrg/mission-control.git",
        branch: "main",
      },
      },
      {
        slug: "mission-control-data",
        path: "mission-control/db",
      space: "root",
      category: "planning-data",
      default_access: "restricted",
      required_roles: ["steward"],
      source_of_truth: "repository-db:v3",
      git: {
        url: "git@github.com:FixtureOrg/mission-control-data.git",
        branch: "v3",
      },
    },
  );
}

function useActiveMissionControlTaskSources(documents) {
  documents.companyConfig.task_sources = [
    {
      slug: "org-todo",
      kind: "todo-tasks-json",
      path: "mission-control/db/data/mission-control/TODO.tasks.json",
      authority: "source-of-truth",
    },
    {
      slug: "org-done",
      kind: "done-tasks-json",
      path: "mission-control/db/data/mission-control/DONE.tasks.json",
      authority: "source-of-truth",
    },
    {
      slug: "org-todo-root-mirror",
      kind: "todo-tasks-json",
      path: "TODO.tasks.json",
      authority: "mirror",
    },
    {
      slug: "org-done-root-mirror",
      kind: "done-tasks-json",
      path: "DONE.tasks.json",
      authority: "mirror",
    },
  ];
}

function createValidDocuments() {
  return {
    repositoryObservation: { status: "offline" },
    companyConfig: {
      organization_generation: "gen3",
      company: {
        slug: "FixtureCompany",
        display_name: "Fixture Company",
        github_org: "FixtureOrg",
      },
      business_context: {
        revenue_drivers: [{ slug: "delivery", description: "Delivery." }],
        customer_segments: [{ slug: "founders", description: "Founders." }],
        value_propositions: [{ slug: "clarity", description: "Clarity." }],
        decision_rules: [{ trigger: "risk", rule: "Escalate." }],
      },
      governance: {
        default_branch: "main",
        update_model: "standalone",
        file_ownership: {
          managed: [],
          derived: ["generated/**"],
          override: [],
          manual: [],
        },
      },
      glossary_contract: {
        source: "GLOSSARY.md",
        agent_rule: "Do not guess.",
        required_term_fields: ["term"],
      },
      access_governance: {
        source_of_truth: "infra/access",
        admin_boundary: "Admins only.",
        agent_rule: "Propose, do not apply.",
      },
      colleague_overlays: {
        path: "company/colleagues",
        folder_name_rule: "OS username.",
        gitignored_local_paths: ["archive/", "private/"],
        agent_rule: "Do not read private paths.",
      },
      generation_policy: {
        prototype_rule: "Learn first.",
        application_versions: [],
        data_versions: [],
        migration_rules: [],
      },
      task_sources: [
        {
          slug: "org-todo",
          kind: "todo-tasks-json",
          path: "TODO.tasks.json",
          authority: "source-of-truth",
        },
        {
          slug: "org-done",
          kind: "done-tasks-json",
          path: "DONE.tasks.json",
          authority: "source-of-truth",
        },
      ],
      teams: [
        { slug: "workspace", display_name: "Default", default: true },
        { slug: "sales", display_name: "Sales" },
      ],
      layers: [
        { path: "workspace", kind: "workspace", ownership: "manual" },
        { path: "productionspace", kind: "productionspace", ownership: "manual" },
        { path: "design-system", kind: "design-system", ownership: "manual" },
      ],
      modules: [
        {
          slug: "knowledgebase",
          path: "workspace/knowledgebase",
          repo: "git@github.com:FixtureOrg/knowledgebase.git",
          category: "knowledge",
          source_of_truth: "git-native",
          access: { default: "expected", roles: ["*"] },
        },
        {
          slug: "firmware",
          path: "productionspace/firmware",
          repo: "git@github.com:FixtureOrg/firmware.git",
          category: "engineering",
          source_of_truth: "git-native",
          access: { default: "restricted", roles: ["cto"] },
        },
      ],
    },
    modulesManifest: {
      organization_generation: "gen3",
      company: "FixtureCompany",
      github_org: "FixtureOrg",
      module_slots: [
        {
          path: "workspace/knowledgebase",
          category: "knowledge",
          default_access: "expected",
          required_roles: ["*"],
          source_of_truth: "git-native",
          git: { url: "git@github.com:FixtureOrg/knowledgebase.git", branch: "main" },
        },
        {
          path: "productionspace/firmware",
          category: "engineering",
          default_access: "restricted",
          required_roles: ["cto"],
          source_of_truth: "git-native",
          git: { url: "git@github.com:FixtureOrg/firmware.git", branch: "main" },
        },
        {
          path: "design-system",
          slug: "design-system",
          space: "root",
          category: "brand",
          default_access: "expected",
          required_roles: ["*"],
          source_of_truth: "git-native",
          git: { url: "git@github.com:FixtureOrg/design-system.git", branch: "main" },
        },
      ],
    },
  };
}
