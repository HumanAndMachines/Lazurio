import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
export async function createFixtureWorkspace({
  managed = [],
  derived = ["generated/**"],
  override = ["company/launchpad/plugins/**"],
  generationKey = "organization_generation",
  defaultWorkspace = "workspace",
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "workspace-compiler-"));
  await Bun.write(
    join(workspace, "company.gen3.json"),
    `${JSON.stringify(
      {
        [generationKey]: "gen3",
        company: {
          slug: "fixture-company",
          display_name: "Fixture Company",
          github_org: "FixtureOrg",
        },
        business_context: {
          revenue_drivers: [
            {
              slug: "implementation-sprints",
              description: "Placené implementační sprinty.",
              priority: "high",
            },
          ],
          customer_segments: [
            {
              slug: "founders",
              description: "Foundeři malých firem.",
            },
          ],
          value_propositions: [
            {
              slug: "clarity",
              description: "Lepší rozhodování agentů díky business kontextu.",
            },
          ],
          decision_rules: [
            {
              trigger: "money or security impact",
              rule: "Eskaluj founderovi.",
              owner: "founder",
            },
          ],
          risks: [
            {
              slug: "unclear-impact",
              description: "Agent nerozumí dopadu.",
            },
          ],
          metrics: [
            {
              slug: "accepted-proposals",
              description: "Přijaté nabídky.",
            },
          ],
        },
        governance: {
          default_branch: "main",
          update_model: "standalone",
          file_ownership: {
            managed,
            derived,
            override,
            manual: ["company.gen3.json", "modules.manifest.json"],
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
          folder_name_rule: "Use OS username.",
          gitignored_local_paths: ["archive/", "private/"],
          agent_rule: "Do not read private paths.",
        },
        generation_policy: {
          prototype_rule: "v1 learns, v2 uses v1 as input.",
          application_versions: [{ version: "app/v1", purpose: "Learning." }],
          data_versions: [{ namespace: "companydata/v1", source_of_truth: "Fixture data." }],
          migration_rules: [{ rule: "Define parity before cutover." }],
        },
        workspaces: [{ slug: defaultWorkspace, display_name: "Default", default: true }],
        layers: [
          { path: "workspace", kind: "workspace", ownership: "manual" },
          { path: "productionspace", kind: "productionspace", ownership: "manual" },
          { path: "design-system", kind: "design-system", ownership: "manual" },
        ],
        modules: [
          {
            slug: "deals",
            path: "workspace/deals",
            category: "sales",
            source_of_truth: "git-native",
            repo: "git@github.com:FixtureOrg/deals.git",
            access: { default: "role_based", roles: ["sales"] },
            app_manifests: ["app/v1/package.json"],
          },
          {
            slug: "firmware",
            path: "productionspace/firmware",
            category: "engineering",
            source_of_truth: "git-native",
            repo: "git@github.com:FixtureOrg/firmware.git",
            access: { default: "restricted", roles: ["cto"] },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await Bun.write(
    join(workspace, "modules.manifest.json"),
    `${JSON.stringify(
      {
        [generationKey]: "gen3",
        company: "fixture-company",
        github_org: "FixtureOrg",
        module_slots: [
          {
            path: "workspace/deals",
            category: "sales",
            default_access: "role_based",
            required_roles: ["sales"],
            source_of_truth: "git-native",
            git: { url: "git@github.com:FixtureOrg/deals.git", branch: "main" },
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
      null,
      2,
    )}\n`,
  );
  await mkdir(join(workspace, "company", "launchpad", "plugins"), { recursive: true });
  await Bun.write(join(workspace, "company", "launchpad", "plugins", "README.md"), "plugins\n");
  return workspace;
}
