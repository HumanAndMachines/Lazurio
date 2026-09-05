import { createHash } from "node:crypto";

export const ORGANIZATION_SCAFFOLD_CONTRACT_VERSION = "lazurio.organization.scaffold.v0";
export const ORGANIZATION_FORGE_BINDING_VERSION = "lazurio.forge-binding.github.v0";

export const ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
export const ORGANIZATION_GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const organizationSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

const staticFiles = Object.freeze({
  ".github/ISSUE_TEMPLATE/agent-report.md": `---
name: Agent report
about: Sanitized technical problem in this Organization repository
title: ""
labels: ""
assignees: ""
---

<!--
Before publishing, search for duplicates and remove secrets, credentials,
Personalspace, another Organization's data, local usernames and unnecessary
absolute paths. A problem owned by one Module belongs in that Module repository.
-->

## Problem

## Environment and exact source version

## Reproduction

1.
2.
3.

## Actual result

## Expected result

## Safe workaround

## Acceptance criteria

- [ ] The owning scope and repository are verified.
- [ ] The report contains no secrets or cross-Organization data.
- [ ] The expected result is testable.
`,
  ".gitignore": `# Local dependencies, generated output and secrets
node_modules/
coverage/
dist/
.cache/
.env
.env.*
!.env.example
*.pem
*.log

# Local editor and operating-system state
.DS_Store
Thumbs.db
.idea/
.vscode/

# Lazurio task worktrees and local private overlays
.worktrees/
company/colleagues/*/archive/
company/colleagues/*/private/
company/colleagues/*/scratch/

# Nested Organization repositories are materialized locally and are never gitlinks
/workspace/*/
/productionspace/*/
/infra/
/mission-control/
/design-system/
`,
  "AGENTS.md": `# Lazurio Organization

This repository is the root of exactly one Lazurio Organization and one GitHub
access boundary. Read \`company.gen3.json\` and \`modules.manifest.json\` before
changing its source.

GitHub memberships, Teams, repository grants and branch rules are the only
access authority. Manifest roles and labels never create a second ACL. Keep
secrets, another Organization's context and every Principal's Personalspace out
of this repository.

Use a task branch and pull request for tracked changes. A draft may be prepared,
committed and pushed for review; merge, release and other publication require
the current Principal's explicit instruction and live GitHub permission.

Open technical problems and uncertainties belong in GitHub Issues of the exact
owning repository. Plans, priorities and responsibility belong in Mission
Control. Creating an issue or comment is publication: it requires the current
Principal's explicit mandate, duplicate search and sanitization. Never publish
secrets, Personalspace or another Organization's data. If no safe repository or
mandate exists, return a sanitized draft instead of creating a shadow ledger.

Workspace Modules live under \`workspace/<module>\`. Organization-wide
repositories live in their declared root or \`productionspace/\` slots. Nested
repositories are separate checkouts and must never become gitlinks in this root.
`,
  "company/colleagues/README.md": `# Colleague overlays

Git-visible Organization collaboration belongs here. Private, archived and
scratch material is local-only and ignored; Personalspace never belongs here.
`,
  "manual/README.md": `# Organization manual

Document Organization-specific operating procedures here. General Lazurio
runtime and access rules stay in the installed Lazurio source.

Activation creates no Modules and reserves no listener ports. Add one reviewed
Organization \`module_port_pool\` only with the first concrete Module lease.
`,
  "productionspace/README.md": `# Productionspace

Organization-level repositories may be materialized here only when declared in
\`modules.manifest.json\`. Each repository owns its own release contract.
`,
  "workspace/README.md": `# Workspace

Workspace Modules are separate repositories mounted flat as
\`workspace/<module>\`. Team membership is declared in Organization manifests,
not encoded in directory names.
`,
});

const scaffoldFilePaths = Object.freeze([
  ...Object.keys(staticFiles),
  "README.md",
  "company.gen3.json",
  "modules.manifest.json",
  "TODO.tasks.json",
  "DONE.tasks.json",
].sort(compareGitNames));

export function createOrganizationScaffold({ organization, repository }) {
  const normalized = normalizeInput({ organization, repository });
  const scope = {
    id: normalized.organization.slug,
    name: normalized.organization.displayName,
    path: normalized.repository.fullName,
    owner: "organization-admin",
  };
  const files = new Map(Object.entries(staticFiles));
  files.set("README.md", organizationReadme(normalized));
  files.set("company.gen3.json", json(companyManifest(normalized)));
  files.set("modules.manifest.json", json(modulesManifest(normalized)));
  files.set("TODO.tasks.json", json({
    schema_version: "companiesascode.todo_tasks.v1",
    scope,
    tasks: [],
  }));
  files.set("DONE.tasks.json", json({
    schema_version: "companiesascode.done_tasks.v1",
    scope,
    tasks: [],
  }));
  const orderedFiles = [...files]
    .map(([path, content]) => freeze({ path, content, blob_oid: gitObjectId("blob", Buffer.from(content)) }))
    .sort((left, right) => compareGitNames(left.path, right.path));

  return freeze({
    contract_version: ORGANIZATION_SCAFFOLD_CONTRACT_VERSION,
    forge_binding: forgeBinding(normalized),
    git_tree_oid: gitTreeOid(orderedFiles),
    files: orderedFiles,
  });
}

export function isValidOrganizationScaffold(value) {
  if (!isRecord(value) || value.contract_version !== ORGANIZATION_SCAFFOLD_CONTRACT_VERSION) return false;
  if (!validForgeBinding(value.forge_binding)) return false;
  if (!/^[0-9a-f]{40}$/u.test(value.git_tree_oid ?? "")) return false;
  if (!Array.isArray(value.files) || value.files.length === 0) return false;
  if (value.files.some((file) => (
    !isRecord(file)
    || typeof file.path !== "string"
    || !validRelativePath(file.path)
    || typeof file.content !== "string"
    || !/^[0-9a-f]{40}$/u.test(file.blob_oid ?? "")
    || gitObjectId("blob", Buffer.from(file.content)) !== file.blob_oid
  ))) return false;
  const paths = value.files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length
    || paths.length !== scaffoldFilePaths.length
    || paths.some((path, index) => path !== scaffoldFilePaths[index])
  ) return false;
  const companyFile = value.files.find((file) => file.path === "company.gen3.json");
  if (!companyFile) return false;
  try {
    const company = JSON.parse(companyFile.content);
    if (!sameForgeBinding(company?.forge_binding, value.forge_binding)) return false;
    return gitTreeOid(value.files) === value.git_tree_oid;
  } catch {
    return false;
  }
}

export function isValidOrganizationForgeBinding(value, {
  organizationId,
  organizationLogin,
  repositoryId,
  repositoryFullName,
} = {}) {
  if (!validForgeBinding(value)) return false;
  if (organizationId !== undefined && String(organizationId) !== value.organization.id) return false;
  if (organizationLogin !== undefined && String(organizationLogin).toLowerCase() !== value.organization.asserted_login.toLowerCase()) return false;
  if (repositoryId !== undefined && String(repositoryId) !== value.repository.id) return false;
  if (repositoryFullName !== undefined && String(repositoryFullName).toLowerCase() !== value.repository.asserted_full_name.toLowerCase()) return false;
  return true;
}

function normalizeInput({ organization, repository }) {
  if (!isRecord(organization) || !isRecord(repository)) {
    throw new TypeError("Organization scaffold requires Organization and repository facts.");
  }
  const organizationId = positiveId(organization.id, "GitHub Organization");
  const organizationLogin = requiredText(organization.login, "GitHub Organization login");
  if (!ORGANIZATION_GITHUB_LOGIN_PATTERN.test(organizationLogin)) {
    throw new TypeError("GitHub Organization login is invalid.");
  }
  const slug = requiredText(organization.slug, "Organization slug");
  if (!organizationSlugPattern.test(slug)) {
    throw new TypeError("Organization slug must be lowercase kebab-case.");
  }
  if (slug === "example" || slug.includes("vyplnit")) {
    throw new TypeError("Organization slug must not be an example or unresolved placeholder.");
  }
  const displayName = safeDisplayText(organization.displayName ?? organizationLogin, "Organization display name");

  const repositoryId = positiveId(repository.id, "GitHub repository");
  const repositoryName = requiredText(repository.name, "GitHub repository name");
  const repositoryFullName = requiredText(repository.fullName, "GitHub repository full name");
  const expectedName = `${organizationLogin}_GEN3`;
  const expectedFullName = `${organizationLogin}/${expectedName}`;
  if (repositoryName.toLowerCase() !== expectedName.toLowerCase()) {
    throw new TypeError(`Organization scaffold repository must use the current '${expectedName}' naming contract.`);
  }
  if (repositoryFullName.toLowerCase() !== expectedFullName.toLowerCase()) {
    throw new TypeError("GitHub repository full name does not match the asserted Organization login and repository name.");
  }
  if ((repository.defaultBranch ?? "main") !== "main") {
    throw new TypeError("Organization scaffold v0 requires default branch 'main'.");
  }

  return freeze({
    organization: { id: organizationId, login: organizationLogin, slug, displayName },
    repository: { id: repositoryId, name: repositoryName, fullName: repositoryFullName, defaultBranch: "main" },
  });
}

function companyManifest({ organization, repository }) {
  return {
    organization_generation: "gen3",
    organization_kind: "organization",
    company: {
      slug: organization.slug,
      display_name: organization.displayName,
      github_org: organization.login,
      repository: `git@github.com:${repository.fullName}.git`,
      root_repository: repository.fullName,
    },
    forge_binding: forgeBinding({ organization, repository }),
    governance: {
      default_branch: repository.defaultBranch,
      access_authority: "github",
    },
    teams: [{
      slug: "workspace",
      display_name: "Workspace",
      default: true,
      description: "Default Organization Team; membership and access remain authoritative on GitHub.",
    }],
    layers: [
      { path: "company", kind: "company-shell", ownership: "manual" },
      { path: "infra", kind: "infra", ownership: "manual" },
      { path: "design-system", kind: "design-system", ownership: "manual" },
      { path: "manual", kind: "manual", ownership: "manual" },
      { path: "workspace", kind: "workspace", ownership: "manual" },
      { path: "mission-control", kind: "mission-control", ownership: "manual" },
      { path: "productionspace", kind: "productionspace", ownership: "manual" },
    ],
    task_sources: [
      { slug: "organization-todo", kind: "todo-tasks-json", path: "TODO.tasks.json", authority: "source-of-truth" },
      { slug: "organization-done", kind: "done-tasks-json", path: "DONE.tasks.json", authority: "source-of-truth" },
    ],
  };
}

function modulesManifest({ organization }) {
  return {
    organization_generation: "gen3",
    company: organization.slug,
    github_org: organization.login,
    workspace_path: "workspace",
    workspace_rule: "Workspace Modules live flat under workspace/<module>; module_slots[].teams owns Team membership.",
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    module_slots: [],
    access_levels: {
      expected: "GitHub grants provide access unless a repository is explicitly restricted.",
      role_based: "GitHub Team and repository grants decide access.",
      restricted: "No access exists until GitHub grants it explicitly.",
    },
  };
}

function forgeBinding({ organization, repository }) {
  return {
    schema_version: ORGANIZATION_FORGE_BINDING_VERSION,
    provider: "github",
    organization: { id: organization.id, asserted_login: organization.login },
    repository: {
      id: repository.id,
      asserted_full_name: repository.fullName,
      default_branch: repository.defaultBranch,
    },
  };
}

function validForgeBinding(value) {
  return isRecord(value)
    && value.schema_version === ORGANIZATION_FORGE_BINDING_VERSION
    && value.provider === "github"
    && isRecord(value.organization)
    && typeof value.organization.id === "string"
    && ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.test(value.organization.id ?? "")
    && typeof value.organization.asserted_login === "string"
    && ORGANIZATION_GITHUB_LOGIN_PATTERN.test(value.organization.asserted_login ?? "")
    && isRecord(value.repository)
    && typeof value.repository.id === "string"
    && ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.test(value.repository.id ?? "")
    && typeof value.repository.asserted_full_name === "string"
    && value.repository.asserted_full_name.toLowerCase() === `${value.organization.asserted_login}/${value.organization.asserted_login}_GEN3`.toLowerCase()
    && value.repository.default_branch === "main";
}

function organizationReadme({ organization, repository }) {
  return `# ${organization.login}\n\nLazurio Organization root for GitHub Organization \`${organization.login}\`.\n\nThe immutable GitHub Organization and repository binding is recorded in\n\`company.gen3.json#forge_binding\`. Renameable provider locators are asserted\ndisplay values and never replace those immutable IDs. Repository slots are\ndeclared only in \`modules.manifest.json\`; an existing repository is not a\nWorkspace Module unless its own Lazurio Module manifest declares it.\n\nRoot repository: \`${repository.fullName}\` (default branch \`main\`).\n`;
}

function gitTreeOid(files) {
  const root = { directories: new Map(), files: new Map() };
  for (const file of files) {
    const segments = file.path.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      if (current.files.has(segment)) {
        throw new TypeError(`Organization scaffold path '${file.path}' collides with file '${segment}'.`);
      }
      if (!current.directories.has(segment)) {
        current.directories.set(segment, { directories: new Map(), files: new Map() });
      }
      current = current.directories.get(segment);
    }
    const name = segments.at(-1);
    if (current.directories.has(name)) {
      throw new TypeError(`Organization scaffold path '${file.path}' collides with directory '${name}'.`);
    }
    current.files.set(name, file.blob_oid);
  }
  return treeObjectId(root);
}

function treeObjectId(node) {
  const entries = [
    ...[...node.files].map(([name, oid]) => ({ name, mode: "100644", oid, directory: false })),
    ...[...node.directories].map(([name, child]) => ({ name, mode: "40000", oid: treeObjectId(child), directory: true })),
  ].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.name}${left.directory ? "/" : ""}`),
    Buffer.from(`${right.name}${right.directory ? "/" : ""}`),
  ));
  const body = Buffer.concat(entries.map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\0`),
    Buffer.from(entry.oid, "hex"),
  ])));
  return gitObjectId("tree", body);
}

function gitObjectId(type, body) {
  return createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
}

function compareGitNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function validRelativePath(path) {
  return path !== ""
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
    && path.split("/").every((segment) => (
      segment !== ""
      && segment !== "."
      && segment !== ".."
      && !isReservedGitSegment(segment)
    ));
}

function isReservedGitSegment(segment) {
  const windowsCanonical = segment.replace(/[. ]+$/u, "");
  return /^\.?git(?:~[1-9][0-9]*)?$/iu.test(windowsCanonical);
}

function positiveId(value, label) {
  const id = String(value ?? "").trim();
  if (!ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.test(id)) throw new TypeError(`${label} ID must be a positive immutable provider ID.`);
  return id;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function safeDisplayText(value, label) {
  const text = requiredText(value, label);
  if (
    text.length > 120
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(text)
  ) {
    throw new TypeError(`${label} contains unsupported characters.`);
  }
  return text;
}

function sameForgeBinding(left, right) {
  return validForgeBinding(left)
    && validForgeBinding(right)
    && left.schema_version === right.schema_version
    && left.provider === right.provider
    && left.organization.id === right.organization.id
    && left.organization.asserted_login === right.organization.asserted_login
    && left.repository.id === right.repository.id
    && left.repository.asserted_full_name === right.repository.asserted_full_name
    && left.repository.default_branch === right.repository.default_branch;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
