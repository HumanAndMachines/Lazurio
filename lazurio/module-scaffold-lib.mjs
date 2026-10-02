// Pure plan of a new Lazurio Module (manual/module-create.md, DEV-6634 W4,
// Lazurio Module Standard kap. 13). This is the single generator of a new
// Module: `lazurio module create` writes its plan to disk and the Dashboard
// "Nový Modul" (DEV-6634 task 407) commits the same plan to a new GitHub
// repository and the slot to an Organization PR. No I/O happens here: the
// caller reads templates, the Organization manifest and the existing leases,
// and decides where the plan goes.

import { createHash } from "node:crypto";
import { posix } from "node:path";

export const MODULE_SCAFFOLD_PLAN_VERSION = "lazurio.module_scaffold.plan.v1";
export const SCAFFOLD_LISTENER_ID = "app";
export const SCAFFOLD_LEASE_ID = "main";
export const SCAFFOLD_APP_PACKAGE = "app/v1/package.json";

/** Versions the scaffold pins besides Bun (which comes from lazurio/package.json). */
export const DEFAULT_SCAFFOLD_VERSIONS = Object.freeze({
  module_kit: "0.2.0",
  uv: "0.11.6",
});

const STACKS = Object.freeze({
  "vite-react": { layers: ["_common", "_bun", "vite-react"], toolchain: "bun", category: "application" },
  astro: { layers: ["_common", "_bun", "astro"], toolchain: "bun", category: "publishing" },
  "astro-starlight": { layers: ["_common", "_bun", "astro-starlight"], toolchain: "bun", category: "knowledge" },
  "bun-service": { layers: ["_common", "_bun", "bun-service"], toolchain: "bun", category: "engineering" },
  "python-uv": { layers: ["_common", "python-uv"], toolchain: "uv", category: "engineering" },
  none: { layers: ["_common", "none"], toolchain: null, category: "workspace" },
});

export const MODULE_SCAFFOLD_STACKS = Object.freeze(Object.keys(STACKS));
/** Template layer directories under lazurio/templates/module/. */
export const MODULE_SCAFFOLD_LAYERS = Object.freeze([...new Set(Object.values(STACKS).flatMap((stack) => stack.layers))]);

/** Slugs that name Organization or root boundaries, never a workspace Module. */
export const RESERVED_MODULE_SLUGS = Object.freeze([
  "productionspace",
  "personalspace",
  "mission-control",
  "mission-control-data",
  "launchpad",
  "design-system",
  "infra",
  "workspace",
  "modules",
  "organizations",
]);

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 50;
const TEAM_PATTERN = /^(?!productionspace$)[a-z0-9][a-z0-9-]*$/;
const ORGANIZATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const RUNTIME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DISPLAY_NAME_FORBIDDEN = /["\\<>{}`\u0000-\u001f\u007f]/;
const DISPLAY_NAME_MAX_LENGTH = 80;
const PLACEHOLDER = /\{\{([A-Za-z0-9_]*)\}\}/g;

export class ModuleScaffoldError extends Error {
  /** @param {string} code stable machine code, @param {string} message, @param {string} [action] */
  constructor(code, message, action = undefined) {
    super(message);
    this.name = "ModuleScaffoldError";
    this.code = code;
    if (action) this.action = action;
  }
}

/**
 * Plans a new Module. Deterministic: the same input gives the same output and
 * the same `tree_hash`. Throws `ModuleScaffoldError` with a stable `code`:
 * `unknown_stack`, `invalid_slug`, `reserved_slug`, `invalid_display_name`,
 * `invalid_team`, `unknown_team`, `invalid_organization`, `invalid_versions`,
 * `slot_exists`, `pool_missing`, `port_not_allowed`, `port_outside_pool`,
 * `port_taken`, `pool_exhausted`, `template_invalid`. (`directory_exists` and
 * the Git/branch refusals belong to the caller that writes.)
 *
 * @param {object} input
 * @param {{slug: string, github_org: string, module_port_pool: {start: number, end: number} | null,
 *   existing_slots?: Array<{path?: string, slug?: string}>,
 *   existing_leases?: Array<{company?: string, module?: string, port: number}>,
 *   teams?: string[] | null}} input.organization  `existing_leases` are every
 *   lease the caller can see (all Organizations on the Machine), `teams` the
 *   Team roster when known (then an undeclared Team is refused).
 * @param {string} input.slug  lowercase kebab slug of the Module and its repository
 * @param {string} [input.display_name]  defaults to the slug in sentence case
 * @param {string} input.stack  one of MODULE_SCAFFOLD_STACKS
 * @param {string[]} [input.teams]  Team slugs for `module_slots[].teams`; empty = default Team
 * @param {number | null} [input.port]  explicit pool port; default is `moduleScaffoldDefaultPort`
 * @param {{layers: Record<string, Array<{path: string, content: string, mode?: string}>>}} input.templates
 * @param {{bun: string, module_kit: string, uv?: string}} input.versions
 * @returns {{schema_version: string, organization: string, module: string, stack: string,
 *   module_path: string, files: Array<{path: string, content: string, mode?: string}>,
 *   generated_by_install: string[], slot: object, lease: {id: string, host: string, port: number} | null,
 *   tree_hash: string, warnings: string[]}}
 */
export function planModuleScaffold({
  organization,
  slug,
  display_name: displayNameInput = undefined,
  stack,
  teams = [],
  port = null,
  templates,
  versions,
}) {
  const stackSpec = Object.hasOwn(STACKS, stack ?? "") ? STACKS[stack] : null;
  if (!stackSpec) {
    throw new ModuleScaffoldError(
      "unknown_stack",
      `Stack ${JSON.stringify(stack)} neexistuje; povolené jsou ${MODULE_SCAFFOLD_STACKS.join(", ")}.`,
      "Zvol stack podle Lazurio Module Standardu kap. 6; jiný stack je rozhodnutí Principála.",
    );
  }
  assertSlug(slug);
  const displayName = normalizeDisplayName(displayNameInput, slug);
  const teamList = normalizeTeams(teams, organization?.teams ?? null);
  const org = normalizeOrganization(organization);
  const pinned = normalizeVersions(versions);
  assertSlotFree(slug, org.existing_slots);

  const lease = stackSpec.toolchain === null
    ? assertNoPort(port)
    : { id: SCAFFOLD_LEASE_ID, host: "127.0.0.1", port: choosePort(port, org, slug) };

  const values = {
    slug,
    display_name: displayName,
    organization: org.slug,
    github_org: org.github_org,
    stack,
    listener_id: SCAFFOLD_LISTENER_ID,
    listener_env_prefix: `LAZURIO_RUNTIME_LISTENER_${SCAFFOLD_LISTENER_ID.toUpperCase().replaceAll("-", "_")}`,
    runtime_id: runtimeId(org.slug, slug),
    python_package: slug.replaceAll("-", "_"),
    port: lease ? String(lease.port) : "",
    bun_version: pinned.bun,
    module_kit_version: pinned.module_kit,
    uv_version: pinned.uv,
  };

  const files = new Map();
  for (const layer of stackSpec.layers) {
    const entries = templates?.layers?.[layer];
    if (!Array.isArray(entries)) {
      throw new ModuleScaffoldError("template_invalid", `Šablona nemá vrstvu ${layer}.`);
    }
    for (const entry of entries) {
      const path = templateTargetPath(substitute(String(entry?.path ?? ""), values, `${layer}: cesta ${entry?.path}`));
      assertRelativePath(path, `${layer}/${entry?.path}`);
      const content = substitute(String(entry?.content ?? ""), values, `${layer}/${entry.path}`);
      files.set(path, { path, content, ...(entry.mode ? { mode: entry.mode } : {}) });
    }
  }
  files.set("lazurio.module.json", {
    path: "lazurio.module.json",
    content: `${JSON.stringify(moduleManifest({ organization: org.slug, slug, lease }), null, 2)}\n`,
  });
  const sorted = [...files.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const file of sorted) {
    if (!file.path.endsWith(".json")) continue;
    try {
      JSON.parse(file.content);
    } catch (error) {
      throw new ModuleScaffoldError("template_invalid", `${file.path} po dosazení není platný JSON: ${error.message}`);
    }
  }
  if (lease && !files.has(SCAFFOLD_APP_PACKAGE)) {
    throw new ModuleScaffoldError("template_invalid", `Stack ${stack} nemá ${SCAFFOLD_APP_PACKAGE}.`);
  }

  const warnings = [];
  if (stackSpec.toolchain === "uv") {
    warnings.push(
      "Python App: MS-04 a MS-08 zůstanou warn, dokud Platforma nemá adaptér uv (DEV-6634 W0-5); do té doby ji ověř ručně uv run --no-sync " + slug + ".",
    );
  }

  return {
    schema_version: MODULE_SCAFFOLD_PLAN_VERSION,
    organization: org.slug,
    module: slug,
    stack,
    module_path: `workspace/${slug}`,
    files: sorted,
    generated_by_install: stackSpec.toolchain === "bun"
      ? ["app/v1/bun.lock"]
      : stackSpec.toolchain === "uv" ? ["app/v1/uv.lock"] : [],
    slot: moduleSlot({ slug, displayName, stack, category: stackSpec.category, teams: teamList, githubOrg: org.github_org }),
    lease,
    tree_hash: moduleScaffoldTreeHash(sorted),
    warnings,
  };
}

/**
 * Default port lease of a new Module: the first port not in `taken`, walking
 * forward with wrap-around from `pool.start + (h mod poolSize)`, where `h` is
 * the first 4 bytes (big-endian uint32) of sha256 over the UTF-8 slug. Returns
 * null when the whole pool is taken.
 *
 * Why not the lowest free port: a work branch cannot see a Module created in
 * a sibling branch before it is merged, so "lowest free" gave two concurrent
 * creations the same port every time. Starting at a slug-derived offset keeps
 * the choice pure and deterministic while making such collisions coincidental.
 * There is deliberately no registry or cross-branch scan (the exact port is
 * Module-owned); a coincidental collision surfaces as MS-01 in
 * `lazurio module setup` once both Modules are present, and is fixed by moving
 * one lease to a free pool port in its lazurio.module.json.
 *
 * @param {string} slug
 * @param {{start: number, end: number}} pool
 * @param {Set<number>} [taken]
 * @returns {number | null}
 */
export function moduleScaffoldDefaultPort(slug, pool, taken = new Set()) {
  const size = pool.end - pool.start + 1;
  const offset = createHash("sha256").update(slug, "utf8").digest().readUInt32BE(0) % size;
  for (let step = 0; step < size; step += 1) {
    const candidate = pool.start + ((offset + step) % size);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** sha256 over the files sorted by path (path, mode and content of each). */
export function moduleScaffoldTreeHash(files) {
  const hash = createHash("sha256");
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.mode ?? "");
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Template file name → Module file name: `dot-x` segments become `.x`, a
 * trailing `.tmpl` is dropped. */
export function templateTargetPath(path) {
  const segments = String(path).split("/").map((segment) => (segment.startsWith("dot-") ? `.${segment.slice(4)}` : segment));
  const last = segments.length - 1;
  if (segments[last].endsWith(".tmpl")) segments[last] = segments[last].slice(0, -".tmpl".length);
  return segments.join("/");
}

/**
 * Inserts `slot` into the text of a `modules.manifest.json` without touching
 * any other byte: the new entry goes after the last `workspace/` slot (or at
 * the end), indented like its neighbours. The result is parsed back and must
 * equal the original document with exactly this slot added.
 */
export function insertModuleSlotText(manifestText, slot) {
  let document;
  try {
    document = JSON.parse(manifestText);
  } catch (error) {
    throw new ModuleScaffoldError("manifest_invalid", `modules.manifest.json není platný JSON: ${error.message}`);
  }
  if (!Array.isArray(document?.module_slots)) {
    throw new ModuleScaffoldError("manifest_invalid", "modules.manifest.json nemá pole module_slots.");
  }
  const scanner = jsonScanner(manifestText);
  const root = scanner.object(scanner.skipWhitespace(0));
  const entry = root.entries.find((item) => item.key === "module_slots");
  const elements = scanner.array(entry.valueStart);
  const lastWorkspace = document.module_slots.findLastIndex(
    (item) => typeof item?.path === "string" && item.path.startsWith("workspace/"),
  );
  const index = lastWorkspace >= 0 ? lastWorkspace : document.module_slots.length - 1;
  let next;
  if (elements.length === 0) {
    const keyIndent = lineIndent(manifestText, entry.keyStart);
    const indent = `${keyIndent}  `;
    next = `${manifestText.slice(0, entry.valueStart)}[\n${indent}${indentJson(slot, indent)}\n${keyIndent}]${manifestText.slice(entry.valueEnd)}`;
  } else {
    const anchor = elements[index];
    const indent = lineIndent(manifestText, elements[0].start);
    next = `${manifestText.slice(0, anchor.end)},\n${indent}${indentJson(slot, indent)}${manifestText.slice(anchor.end)}`;
  }
  const expected = structuredClone(document);
  expected.module_slots.splice(elements.length === 0 ? 0 : index + 1, 0, slot);
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected)) {
    throw new ModuleScaffoldError("manifest_insert_failed", "Vložení slotu do modules.manifest.json se neověřilo; soubor zůstal beze změny.");
  }
  return next;
}

function assertSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    throw new ModuleScaffoldError(
      "invalid_slug",
      `Slug ${JSON.stringify(slug)} není lowercase kebab-case (${SLUG_PATTERN.source}, nejvýše ${SLUG_MAX_LENGTH} znaků).`,
      "Použij malá písmena, číslice a pomlčky, na začátku písmeno, například customer-portal.",
    );
  }
  if (RESERVED_MODULE_SLUGS.includes(slug)) {
    throw new ModuleScaffoldError(
      "reserved_slug",
      `Slug ${slug} je rezervovaný pro hranici Organizace nebo rootu.`,
      "Zvol jiný slug Modulu.",
    );
  }
}

function normalizeDisplayName(value, slug) {
  const name = value === undefined || value === null
    ? `${slug.charAt(0).toUpperCase()}${slug.slice(1).replaceAll("-", " ")}`
    : String(value).trim();
  if (name === "" || name.length > DISPLAY_NAME_MAX_LENGTH || DISPLAY_NAME_FORBIDDEN.test(name) || name.includes("{{")) {
    throw new ModuleScaffoldError(
      "invalid_display_name",
      `Název ${JSON.stringify(value)} není použitelný (1–${DISPLAY_NAME_MAX_LENGTH} znaků, bez " \\ < > { } \` a řídicích znaků).`,
      "Zadej prostý název, například Zákaznický portál.",
    );
  }
  return name;
}

function normalizeTeams(teams, roster) {
  if (!Array.isArray(teams)) {
    throw new ModuleScaffoldError("invalid_team", "teams musí být pole slugů Teamů.");
  }
  const seen = new Set();
  for (const team of teams) {
    if (typeof team !== "string" || !TEAM_PATTERN.test(team) || seen.has(team)) {
      throw new ModuleScaffoldError("invalid_team", `Team ${JSON.stringify(team)} není platný nebo je uvedený dvakrát.`);
    }
    seen.add(team);
  }
  if (Array.isArray(roster)) {
    const unknown = teams.filter((team) => !roster.includes(team));
    if (unknown.length > 0) {
      throw new ModuleScaffoldError(
        "unknown_team",
        `Organizace nedeklaruje Team ${unknown.join(", ")}.`,
        `Použij Team z lazurio.organization.json#teams (${roster.join(", ") || "žádný"}); nový Team zakládá Organization Admin.`,
      );
    }
  }
  return [...teams];
}

function normalizeOrganization(organization) {
  const slug = organization?.slug;
  const githubOrg = organization?.github_org;
  if (typeof slug !== "string" || !ORGANIZATION_PATTERN.test(slug)) {
    throw new ModuleScaffoldError("invalid_organization", `Organizace nemá platný slug (${JSON.stringify(slug)}).`);
  }
  if (typeof githubOrg !== "string" || !GITHUB_LOGIN_PATTERN.test(githubOrg)) {
    throw new ModuleScaffoldError("invalid_organization", `Organizace ${slug} nemá platný GitHub login (${JSON.stringify(githubOrg)}).`);
  }
  const pool = organization.module_port_pool ?? null;
  if (pool !== null && !(Number.isInteger(pool?.start) && Number.isInteger(pool?.end) && pool.start >= 1024 && pool.end <= 65_535 && pool.start <= pool.end)) {
    throw new ModuleScaffoldError("invalid_organization", `module_port_pool Organizace ${slug} není platný rozsah portů.`);
  }
  return {
    slug,
    github_org: githubOrg,
    module_port_pool: pool,
    existing_slots: Array.isArray(organization.existing_slots) ? organization.existing_slots : [],
    existing_leases: Array.isArray(organization.existing_leases) ? organization.existing_leases : [],
  };
}

function normalizeVersions(versions) {
  const pinned = {
    bun: versions?.bun,
    module_kit: versions?.module_kit ?? DEFAULT_SCAFFOLD_VERSIONS.module_kit,
    uv: versions?.uv ?? DEFAULT_SCAFFOLD_VERSIONS.uv,
  };
  for (const [name, value] of Object.entries(pinned)) {
    if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
      throw new ModuleScaffoldError("invalid_versions", `Verze ${name} ${JSON.stringify(value)} není přesná semver verze.`);
    }
  }
  return pinned;
}

function assertSlotFree(slug, slots) {
  const wanted = slug.toLowerCase();
  for (const slot of slots) {
    const path = typeof slot?.path === "string" ? slot.path : "";
    const names = [slot?.slug, posix.basename(path), path === "" ? null : path]
      .filter((name) => typeof name === "string" && name !== "")
      .map((name) => name.toLowerCase());
    if (names.includes(wanted) || names.includes(`workspace/${wanted}`)) {
      throw new ModuleScaffoldError(
        "slot_exists",
        `Organizace už má slot ${path || slot?.slug}, který se se slugem ${slug} kryje (i bez ohledu na velikost písmen).`,
        "Zvol jiný slug nebo pracuj v existujícím Modulu.",
      );
    }
  }
}

function assertNoPort(port) {
  if (port !== null && port !== undefined) {
    throw new ModuleScaffoldError("port_not_allowed", "Stack none nemá App ani port lease; --port k němu nepatří.");
  }
  return null;
}

function choosePort(port, organization, slug) {
  const pool = organization.module_port_pool;
  if (!pool) {
    throw new ModuleScaffoldError(
      "pool_missing",
      `Organizace ${organization.slug} nemá module_port_pool; Modul s App nemá odkud vzít lease.`,
      "Organization Admin doplní module_port_pool (100 portů disjunktních s ostatními Organizacemi).",
    );
  }
  const taken = new Set(organization.existing_leases.map((lease) => lease?.port).filter(Number.isInteger));
  if (port !== null && port !== undefined) {
    if (!Number.isInteger(port) || port < pool.start || port > pool.end) {
      throw new ModuleScaffoldError(
        "port_outside_pool",
        `Port ${port} neleží v module_port_pool ${pool.start}-${pool.end} Organizace ${organization.slug}.`,
        "Vynech --port (scaffold vybere volný port poolu odvozený ze slugu) nebo zvol port z poolu.",
      );
    }
    if (taken.has(port)) {
      throw new ModuleScaffoldError("port_taken", `Port ${port} už drží jiný Modul.`, "Vynech --port nebo zvol volný port poolu.");
    }
    return port;
  }
  const chosen = moduleScaffoldDefaultPort(slug, pool, taken);
  if (chosen !== null) return chosen;
  throw new ModuleScaffoldError(
    "pool_exhausted",
    `module_port_pool ${pool.start}-${pool.end} Organizace ${organization.slug} je vyčerpaný.`,
    "Organization Admin rozhodne o rozšíření poolu nebo úklidu nepoužívaných leasů.",
  );
}

function runtimeId(organization, slug) {
  const id = `${organization.toLowerCase().replace(/-+/g, "-").replace(/^-|-$/g, "")}-${slug}-v1`;
  if (!RUNTIME_ID_PATTERN.test(id)) {
    throw new ModuleScaffoldError("invalid_organization", `Z Organizace ${organization} nejde odvodit runtime id (${id}).`);
  }
  return id;
}

function moduleManifest({ organization, slug, lease }) {
  return lease
    ? {
        schema_version: "lazurio.module.v1",
        id: slug,
        company: organization,
        tcp_port_policy: { mode: "single" },
        port_leases: [lease],
        apps: [SCAFFOLD_APP_PACKAGE],
        default_app: SCAFFOLD_APP_PACKAGE,
      }
    : {
        schema_version: "lazurio.module.v1",
        id: slug,
        company: organization,
        tcp_port_policy: { mode: "none" },
        port_leases: [],
        apps: [],
      };
}

function moduleSlot({ slug, displayName, stack, category, teams, githubOrg }) {
  return {
    path: `workspace/${slug}`,
    slug,
    space: "workspace",
    ...(teams.length > 0 ? { teams } : {}),
    category,
    default_access: "expected",
    required_roles: ["*"],
    source_of_truth: "git-native",
    status: "active",
    notes: `${displayName}: Modul založený příkazem lazurio module create (stack ${stack}).`,
    git: { url: `git@github.com:${githubOrg}/${slug}.git`, branch: "main" },
  };
}

function substitute(text, values, label) {
  return text.replace(PLACEHOLDER, (match, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new ModuleScaffoldError("template_invalid", `${label}: neznámý placeholder ${match}.`);
    }
    return values[name];
  });
}

function assertRelativePath(path, label) {
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ModuleScaffoldError("template_invalid", `${label}: cesta ${JSON.stringify(path)} není bezpečná relativní cesta.`);
  }
}

function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

function indentJson(value, indent) {
  return JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`);
}

// Minimal JSON scanner: offsets of object entries and array elements, so the
// slot can be inserted without re-serializing (and reformatting) the file.
function jsonScanner(text) {
  const skipWhitespace = (index) => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    return index;
  };
  const stringEnd = (index) => {
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\") cursor += 1;
      else if (text[cursor] === "\"") return cursor + 1;
    }
    throw new ModuleScaffoldError("manifest_invalid", "modules.manifest.json má neukončený řetězec.");
  };
  const valueEnd = (index) => {
    const character = text[index];
    if (character === "\"") return stringEnd(index);
    if (character === "{") return object(index).end;
    if (character === "[") return array(index).end;
    let cursor = index;
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
    return cursor;
  };
  function object(start) {
    const entries = [];
    let cursor = skipWhitespace(start + 1);
    if (text[cursor] === "}") return { entries, end: cursor + 1 };
    while (cursor < text.length) {
      const keyStart = cursor;
      const keyEnd = stringEnd(cursor);
      cursor = skipWhitespace(keyEnd);
      cursor = skipWhitespace(cursor + 1);
      const valueStart = cursor;
      const end = valueEnd(cursor);
      entries.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, valueStart, valueEnd: end });
      cursor = skipWhitespace(end);
      if (text[cursor] === "}") return { entries, end: cursor + 1 };
      cursor = skipWhitespace(cursor + 1);
    }
    throw new ModuleScaffoldError("manifest_invalid", "modules.manifest.json má neukončený objekt.");
  }
  function array(start) {
    const elements = [];
    let cursor = skipWhitespace(start + 1);
    if (text[cursor] === "]") return Object.assign(elements, { end: cursor + 1 });
    while (cursor < text.length) {
      const end = valueEnd(cursor);
      elements.push({ start: cursor, end });
      cursor = skipWhitespace(end);
      if (text[cursor] === "]") return Object.assign(elements, { end: cursor + 1 });
      cursor = skipWhitespace(cursor + 1);
    }
    throw new ModuleScaffoldError("manifest_invalid", "modules.manifest.json má neukončené pole.");
  }
  return { skipWhitespace, object, array };
}
