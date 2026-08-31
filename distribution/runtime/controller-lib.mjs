import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve, sep } from "node:path";

const CONTRACT_SCHEMA = "machines.resident-controller-contract.v1";
const STATUS_SCHEMA = "machines.resident-status.v1";
const INSTALLED_SCHEMA = "machines.resident-installed.v1";
const CHECKPOINT_SCHEMA = "machines.resident-checkpoint.v1";
const ZULIP_COMPOSE_COMMIT = "9e1d3cf566f3fb67e168c93f29a642eda989f6b7";
const ZULIP_COMPOSE_SHA256 = "53ad3b2f0640cc90da5fc5a2d28007b610118465082673a7ed95c56094a143b3";
const ZULIP_COMPOSE_URL =
  "https://raw.githubusercontent.com/zulip/docker-zulip/" +
  ZULIP_COMPOSE_COMMIT +
  "/compose.yaml";
const SOFTWARE_ROOT = "/opt/lazurio-machines/software";
const RUNTIME_ROOT = "/var/lib/lazurio-resident/runtime";
const CONTRACT_PATHS = Object.freeze({
  install_root: "/opt/lazurio",
  state_root: "/var/lib/lazurio-resident",
  personalspace_root: "/srv/lazurio-resident/personalspace",
  organizations_root: "/srv/lazurio-resident/organizations",
});
const CONTRACT_TOOLCHAIN = Object.freeze({
  bun: "/opt/lazurio-machines/toolchains/bun",
  uv: "/opt/lazurio-machines/toolchains/uv",
  restic: "/opt/lazurio-machines/toolchains/restic",
});
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^(?!\.{1,2}\/)(?![^/]+\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_LOGIN = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveBindingApiKey(masterKey, bindingId) {
  assertSecret(masterKey, "runtime api key", 32);
  assertSlug(bindingId, "Communication Binding ID");
  return createHmac("sha256", masterKey)
    .update("lazurio-resident-binding-v1\u0000")
    .update(bindingId)
    .digest("base64url");
}

export function bindingRuntimeIdentity(machineId, bindingId) {
  assertSlug(machineId, "Machine ID");
  assertSlug(bindingId, "Communication Binding ID");
  const suffix = sha256(machineId + "\u0000" + bindingId).slice(0, 12);
  return Object.freeze({
    group: "lzr-x-" + suffix,
    gatewayUser: "lzr-g-" + suffix,
    bridgeUser: "lzr-b-" + suffix,
    gatewayUnit: "lazurio-gateway-" + suffix + ".service",
    bridgeUnit: "lazurio-bridge-" + suffix + ".service",
  });
}

export function bindingPort(index) {
  if (!Number.isInteger(index) || index < 0 || index > 127) {
    throw new Error("Communication Binding index is outside the supported port lane");
  }
  return 17650 + index;
}

export function validateControllerContract(contract) {
  if (!plainObject(contract) || contract.schema_version !== CONTRACT_SCHEMA) {
    throw new Error("Resident controller contract schema is invalid");
  }
  assertSlug(contract.machine_id, "Machine ID");
  const profile = contract.machine_profile;
  if (!["buddy", "ai-colleague"].includes(profile)) {
    throw new Error("Resident controller Profile is invalid");
  }
  const expectedWorkload =
    profile === "buddy" ? "hosted-buddy-resident" : "ai-colleague-resident";
  if (contract.workload_id !== expectedWorkload) {
    throw new Error("Resident controller Workload does not match its Profile");
  }
  if (!/^[0-9a-f]{40,64}$/.test(contract.deployment_head || "")) {
    throw new Error("Resident deployment HEAD is invalid");
  }
  if (!/^[0-9a-f]{40,64}$/.test(contract.machines_head || "")) {
    throw new Error("Machines release HEAD is invalid");
  }
  assertExactMap(contract.paths, CONTRACT_PATHS, "Resident path");
  assertExactMap(contract.toolchain, CONTRACT_TOOLCHAIN, "Resident toolchain");

  const overlay = contract.owner_overlay;
  if (!plainObject(overlay) || overlay.runtime?.artifact?.profile !== profile) {
    throw new Error("Resident owner overlay does not match its Profile");
  }
  if (!Array.isArray(overlay.authority_compartments) ||
      !Array.isArray(overlay.communication_bindings) ||
      overlay.authority_compartments.length === 0 ||
      overlay.communication_bindings.length === 0) {
    throw new Error("Resident Authority Compartments or Communication Bindings are absent");
  }
  assertSlug(overlay.principal?.principal_id, "Resident Principal ID");
  if (!REPOSITORY.test(overlay.principal.personalspace_repository || "") ||
      (profile === "buddy" && overlay.principal.kind !== "human") ||
      (profile === "ai-colleague" &&
        (overlay.principal.kind !== "ai-colleague" ||
         !REPOSITORY.test(overlay.principal.organization_repository || "")))) {
    throw new Error("Resident Principal contract is invalid");
  }
  if (overlay.runtime?.memory?.provider !== "gbrain" ||
      overlay.runtime.memory.engine !== "pglite" ||
      overlay.runtime.memory.transport !== "stdio" ||
      !["conservative", "balanced", "tokenmax"].includes(overlay.runtime.memory.search_mode) ||
      overlay.runtime.memory.embedding !== "disabled") {
    throw new Error("Resident memory contract is unsupported");
  }
  if (overlay.runtime?.sandbox?.pids !== 256 ||
      !["none", "docker-bridge"].includes(overlay.runtime.sandbox.network) ||
      !/^.+@sha256:[0-9a-f]{64}$/.test(overlay.runtime.sandbox.terminal_image || "")) {
    throw new Error("Resident terminal sandbox contract is unsupported");
  }
  if (!Number.isInteger(overlay.runtime.quota?.max_concurrent_sessions) ||
      !Number.isInteger(overlay.runtime.quota?.max_turns_per_hour) ||
      overlay.runtime.quota.max_concurrent_sessions < overlay.communication_bindings.length ||
      overlay.runtime.quota.max_turns_per_hour < overlay.communication_bindings.length) {
    throw new Error("Resident Machine quota is invalid");
  }

  const compartments = new Map();
  const credentialPurposes = new Set();
  let personalCompartment = null;
  for (const compartment of overlay.authority_compartments) {
    assertSlug(compartment?.compartment_id, "Authority Compartment ID");
    if (compartments.has(compartment.compartment_id)) {
      throw new Error("Authority Compartment IDs are not unique");
    }
    const compartmentKeys = [
      "compartment_id",
      "credential_purposes",
      "kind",
      "repositories",
      "repository_credential_purpose",
      "schema_version",
      "tools",
      ...(compartment.kind === "organization" ? ["organization"] : []),
    ];
    if (!hasExactKeys(compartment, compartmentKeys) ||
        compartment.schema_version !== "machines.authority-compartment.v1" ||
        !["personal", "organization"].includes(compartment.kind) ||
        !Array.isArray(compartment.credential_purposes) ||
        compartment.credential_purposes.length === 0 ||
        !compartment.credential_purposes.includes(compartment.repository_credential_purpose) ||
        !Array.isArray(compartment.repositories) ||
        compartment.repositories.length === 0 ||
        !Array.isArray(compartment.tools) ||
        compartment.tools.length === 0 ||
        compartment.tools.some((tool) => !["file", "terminal"].includes(tool))) {
      throw new Error("Authority Compartment contract is unsupported");
    }
    for (const purpose of compartment.credential_purposes) {
      assertSlug(purpose, "Authority credential purpose");
      if (credentialPurposes.has(purpose)) {
        throw new Error("Authority credential purposes cross compartments");
      }
      credentialPurposes.add(purpose);
    }
    const repositoryNames = new Set();
    for (const grant of compartment.repositories) {
      if (!hasExactKeys(grant, ["repository"]) ||
          !REPOSITORY.test(grant?.repository || "") ||
          repositoryNames.has(grant.repository.toLowerCase())) {
        throw new Error("Authority Compartment repository grant is invalid");
      }
      repositoryNames.add(grant.repository.toLowerCase());
    }
    if (compartment.kind === "organization") {
      if (!GITHUB_LOGIN.test(compartment.organization?.github_login || "") ||
          !REPOSITORY.test(compartment.organization?.root_repository || "") ||
          compartment.organization.root_repository.split("/")[0].toLowerCase() !==
            compartment.organization.github_login.toLowerCase() ||
          !repositoryNames.has(compartment.organization.root_repository.toLowerCase())) {
        throw new Error("Organization Authority Compartment root is invalid");
      }
    } else {
      if (personalCompartment ||
          !repositoryNames.has(overlay.principal.personalspace_repository.toLowerCase())) {
        throw new Error("Personal Authority Compartment is invalid");
      }
      personalCompartment = compartment;
    }
    compartments.set(compartment.compartment_id, compartment);
  }
  if (!personalCompartment) throw new Error("Resident has no Personal Authority Compartment");

  const boundCompartments = new Set();
  const bindingIds = new Set();
  const realmIdentities = new Set();
  const bindingCredentialPurposes = new Set();
  for (const binding of overlay.communication_bindings) {
    assertSlug(binding?.binding_id, "Communication Binding ID");
    if (binding.schema_version !== "machines.communication-binding.v1" ||
        bindingIds.has(binding.binding_id) ||
        boundCompartments.has(binding.compartment_id)) {
      throw new Error("Communication Bindings do not map one-to-one to compartments");
    }
    const compartment = compartments.get(binding.compartment_id);
    if (!compartment) throw new Error("Communication Binding compartment is absent");
    if ((binding.realm_role === "personal-home") !== (compartment.kind === "personal")) {
      throw new Error("Communication Binding crosses its Authority Compartment");
    }
    const realmIdentity = [
      String(binding.zulip?.site || "").toLowerCase(),
      binding.zulip?.realm_id,
      binding.zulip?.identity_id,
    ].join("\u0000");
    if (!validHttpsOrigin(binding.zulip?.site) ||
        !OPAQUE_ID.test(binding.zulip?.realm_id || "") ||
        !OPAQUE_ID.test(binding.zulip?.identity_id || "") ||
        !SLUG.test(binding.zulip?.credential_purpose || "") ||
        realmIdentities.has(realmIdentity) ||
        bindingCredentialPurposes.has(binding.zulip?.credential_purpose) ||
        !Array.isArray(binding.routing?.allowed_sender_ids) ||
        binding.routing.allowed_sender_ids.length === 0 ||
        binding.routing.allowed_sender_ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(binding.routing.allowed_sender_ids).size !== binding.routing.allowed_sender_ids.length ||
        !Array.isArray(binding.routing?.allowed_stream_ids) ||
        binding.routing.allowed_stream_ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(binding.routing.allowed_stream_ids).size !== binding.routing.allowed_stream_ids.length ||
        !["direct-only", "any-in-allowed-stream"].includes(binding.routing?.topic_policy) ||
        (binding.routing.topic_policy === "direct-only" &&
          binding.routing.allowed_stream_ids.length !== 0)) {
      throw new Error("Communication Binding routing contract is invalid");
    }
    if (binding.realm_role === "personal-home" &&
        (binding.routing.topic_policy !== "direct-only" ||
         binding.routing.allowed_sender_ids.length !== 1)) {
      throw new Error("Personal home binding must admit exactly its Principal by direct message");
    }
    bindingIds.add(binding.binding_id);
    boundCompartments.add(binding.compartment_id);
    realmIdentities.add(realmIdentity);
    bindingCredentialPurposes.add(binding.zulip.credential_purpose);
  }

  if (profile === "buddy") {
    const home = overlay.communication_bindings.filter(
      (binding) => binding.realm_role === "personal-home",
    );
    if (home.length !== 1 || boundCompartments.size !== compartments.size ||
        home[0].zulip.site !== overlay.home_zulip?.origin ||
        overlay.home_zulip.compose_commit !== ZULIP_COMPOSE_COMMIT ||
        overlay.home_zulip.data_volume !== "lazurio-buddy-zulip-data") {
      throw new Error("Buddy home Zulip contract is invalid");
    }
  } else if (overlay.communication_bindings.length !== 1 ||
             overlay.communication_bindings[0].realm_role !== "organization" ||
             overlay.principal.organization_repository.toLowerCase() !==
               compartments.get(overlay.communication_bindings[0].compartment_id)
                 ?.organization?.root_repository?.toLowerCase()) {
    throw new Error("AI Colleague v1 must have exactly one Organization binding");
  }
  return contract;
}

export function validateSecretBundle(contract, secrets) {
  if (!plainObject(secrets) ||
      secrets.schema_version !== "machines.resident-secret-bundle.v1" ||
      secrets.machine_id !== contract.machine_id ||
      !Array.isArray(secrets.authority_credentials) ||
      !Array.isArray(secrets.bindings)) {
    throw new Error("Resident secret bundle identity is invalid");
  }
  const expectedBindings = contract.owner_overlay.communication_bindings.map(
    (binding) => binding.binding_id,
  );
  if (secrets.bindings.map((binding) => binding.binding_id).join("\u0000") !==
      expectedBindings.join("\u0000")) {
    throw new Error("Resident secret bundle bindings are invalid");
  }
  const apiKeys = new Set();
  for (const binding of secrets.bindings) {
    assertSecret(binding.email, "Zulip bot email");
    if (!/^[A-Za-z0-9]{32}$/.test(binding.api_key || "") ||
        apiKeys.has(binding.api_key)) {
      throw new Error("Zulip bot API key contract is invalid");
    }
    apiKeys.add(binding.api_key);
  }
  assertSecret(secrets.model?.api_key, "model credential");
  if (secrets.model.provider !== "openrouter") {
    throw new Error("Resident model credential provider is invalid");
  }
  assertSecret(secrets.runtime?.api_server_key, "runtime API key", 32);
  for (const key of ["access_key_id", "password", "secret_access_key"]) {
    assertSecret(secrets.backup?.[key], "backup credential");
  }
  const expectedAuthority = [];
  for (const compartment of contract.owner_overlay.authority_compartments) {
    for (const purpose of compartment.credential_purposes) {
      expectedAuthority.push(compartment.compartment_id + "\u0000" + purpose);
    }
  }
  const actualAuthority = [];
  for (const credential of secrets.authority_credentials) {
    assertSecret(credential?.value, "authority credential");
    actualAuthority.push(credential.compartment_id + "\u0000" + credential.purpose);
  }
  if (actualAuthority.sort().join("\u0001") !== expectedAuthority.sort().join("\u0001")) {
    throw new Error("Resident authority credential set is invalid");
  }
  if (contract.machine_profile === "buddy") {
    for (const key of [
      "administrator_password",
      "email_password",
      "memcached_password",
      "postgres_password",
      "rabbitmq_password",
      "redis_password",
      "secret_key",
    ]) {
      assertSecret(secrets.home_zulip?.[key], "home Zulip credential");
    }
  }
  return secrets;
}

export function renderHermesConfig({
  contract,
  compartment,
  scopePath,
  gbrainHome,
  gbrainCheckout,
  port,
}) {
  const runtime = contract.owner_overlay.runtime;
  // Hermes platform_toolsets names an MCP server by its configured key. Tool
  // function names receive the mcp_<server>_ prefix later during registration.
  const enabledTools = [...new Set([...compartment.tools, "gbrain"])].sort();
  return {
    model: {
      default: runtime.model.model_id,
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
    },
    max_concurrent_sessions: 1,
    database: { journal_mode: "wal" },
    approvals: {
      mode: "manual",
      timeout: 300,
      cron_mode: "deny",
      single_query_mode: "deny",
      mcp_reload_confirm: true,
      destructive_slash_confirm: true,
    },
    command_allowlist: [],
    hooks_auto_accept: false,
    security: {
      allow_private_urls: false,
      redact_secrets: true,
      allow_data_training_tiers_noninteractive: false,
      approval: { transport: "builtin", transport_fallback: "deny" },
      protected_instruction_files: true,
      protected_instruction_extra_patterns: [],
      tirith_enabled: true,
      tirith_fail_open: false,
      allow_lazy_installs: false,
    },
    tool_loop_guardrails: { hard_stop_enabled: true },
    terminal: {
      backend: "docker",
      cwd: "/workspace",
      docker_image: runtime.sandbox.terminal_image,
      container_cpu: runtime.sandbox.cpus,
      container_memory: runtime.sandbox.memory_mb,
      container_persistent: false,
      docker_persist_across_processes: false,
      docker_mount_cwd_to_workspace: false,
      docker_volumes: [scopePath + ":/workspace:rw"],
      docker_forward_env: [],
      docker_env: {},
      docker_network: runtime.sandbox.network === "docker-bridge",
      docker_extra_args: [],
    },
    gateway: {
      api_server: {
        max_concurrent_runs: 1,
      },
    },
    platforms: {
      api_server: {
        enabled: true,
        extra: {
          host: "127.0.0.1",
          port,
          model_name: "hermes",
        },
      },
    },
    platform_toolsets: {
      api_server: enabledTools,
    },
    mcp_servers: {
      gbrain: {
        command: CONTRACT_TOOLCHAIN.bun,
        args: [join(gbrainCheckout, "src", "cli.ts"), "serve"],
        env: {
          GBRAIN_HOME: gbrainHome,
          GBRAIN_SKIP_STARTUP_HOOKS: "1",
        },
        tools: {
          include: ["put_page", "search", "get_page"],
          prompts: false,
        },
      },
    },
  };
}

export function renderGatewayUnit({
  identity,
  viewRoot,
  scopePath,
  stateRoot,
  environmentFile,
  hermesExecutable,
}) {
  return [
    "[Unit]",
    "Description=Lazurio Resident Hermes gateway " + identity.gatewayUnit,
    "After=network-online.target docker.service",
    "Wants=network-online.target",
    "Requires=docker.service",
    "",
    "[Service]",
    "Type=simple",
    "User=" + identity.gatewayUser,
    "SupplementaryGroups=" + identity.group + " docker",
    "WorkingDirectory=" + join(viewRoot, "scope"),
    "EnvironmentFile=" + environmentFile,
    "ExecStart=" + hermesExecutable + " gateway run --replace --external-supervisor --no-supervise",
    "Restart=on-failure",
    "RestartSec=5s",
    "RestartPreventExitStatus=78",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectHome=yes",
    "ProtectSystem=strict",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "LockPersonality=yes",
    "RestrictSUIDSGID=yes",
    "ReadOnlyPaths=/opt/lazurio " + SOFTWARE_ROOT,
    "ReadWritePaths=" + stateRoot + " " + scopePath,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderBridgeUnit({
  identity,
  viewRoot,
  scopePath,
  queueRoot,
  environmentFile,
}) {
  return [
    "[Unit]",
    "Description=Lazurio Resident Zulip binding " + identity.bridgeUnit,
    "After=network-online.target " + identity.gatewayUnit,
    "Wants=network-online.target",
    "Requires=" + identity.gatewayUnit,
    "",
    "[Service]",
    "Type=simple",
    "User=" + identity.bridgeUser,
    "SupplementaryGroups=" + identity.group,
    "WorkingDirectory=" + join(viewRoot, "scope"),
    "EnvironmentFile=" + environmentFile,
    "ExecStart=" + CONTRACT_TOOLCHAIN.bun + " /opt/lazurio/active/bridge/run.ts",
    "Restart=on-failure",
    "RestartSec=5s",
    "RestartPreventExitStatus=78",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectHome=yes",
    "ProtectSystem=strict",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "LockPersonality=yes",
    "RestrictSUIDSGID=yes",
    "CapabilityBoundingSet=",
    "ReadOnlyPaths=/opt/lazurio " + scopePath,
    "ReadWritePaths=" + queueRoot,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderZulipOverride(homeZulip, secretFiles) {
  const host = new URL(homeZulip.origin).hostname;
  const images = homeZulip.images;
  const secretLines = Object.entries(secretFiles).flatMap(([name, path]) => [
    "  " + name + ":",
    "    file: " + jsonScalar(path),
  ]);
  return [
    "---",
    "secrets:",
    ...secretLines,
    "services:",
    "  database:",
    "    image: " + jsonScalar(images.postgresql),
    "  memcached:",
    "    image: " + jsonScalar(images.memcached),
    "  rabbitmq:",
    "    image: " + jsonScalar(images.rabbitmq),
    "  redis:",
    "    image: " + jsonScalar(images.redis),
    "  zulip:",
    "    image: " + jsonScalar(images.server),
    "    ports: !override",
    "      - " + jsonScalar("127.0.0.1:8080:80"),
    "    secrets:",
    "      - zulip__postgres_password",
    "      - zulip__memcached_password",
    "      - zulip__rabbitmq_password",
    "      - zulip__redis_password",
    "      - zulip__secret_key",
    "      - zulip__email_password",
    "      - lazurio__administrator_password",
    "      - lazurio__bot_api_key",
    "    environment:",
    "      SETTING_EXTERNAL_HOST: " + jsonScalar(host),
    "      SETTING_ZULIP_ADMINISTRATOR: " + jsonScalar(homeZulip.administrator_email),
    "      TRUST_GATEWAY_IP: " + jsonScalar("True"),
    "volumes:",
    "  zulip:",
    "    name: " + jsonScalar(homeZulip.data_volume),
    "",
  ].join("\n");
}

function jsonScalar(value) {
  return JSON.stringify(String(value));
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  return plainObject(value) &&
    Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function assertSlug(value, label) {
  if (typeof value !== "string" || value.length > 64 || !SLUG.test(value)) {
    throw new Error(label + " is invalid");
  }
}

function assertSecret(value, label, minimum = 8) {
  if (typeof value !== "string" ||
      value.length < minimum ||
      value.length > 4096 ||
      /[\u0000\r\n]/.test(value)) {
    throw new Error(label + " is invalid");
  }
}

function validHttpsOrigin(value) {
  if (typeof value !== "string" || value.length > 253) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.origin === value &&
      parsed.username === "" &&
      parsed.password === "";
  } catch {
    return false;
  }
}

function assertExactMap(actual, expected, label) {
  if (!plainObject(actual) ||
      Object.keys(actual).sort().join("\u0000") !== Object.keys(expected).sort().join("\u0000")) {
    throw new Error(label + " contract is invalid");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(label + " contract is invalid");
  }
}

export function reconcileResidentRuntime(contractInput, secretsInput) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  const secrets = validateSecretBundle(contract, secretsInput);
  const active = readActiveArtifact(contract);
  let changed = false;
  mkdirSecure(SOFTWARE_ROOT, 0o755);
  mkdirSecure(CONTRACT_PATHS.state_root, 0o711);
  mkdirSecure(RUNTIME_ROOT, 0o711);
  mkdirSecure(join(RUNTIME_ROOT, "bindings"), 0o700);
  mkdirSecure(join(RUNTIME_ROOT, "views"), 0o711);
  mkdirSecure(join(RUNTIME_ROOT, "environment"), 0o700);
  mkdirSecure(CONTRACT_PATHS.personalspace_root, 0o711);
  mkdirSecure(CONTRACT_PATHS.organizations_root, 0o711);

  const hermesCheckout = join(
    SOFTWARE_ROOT,
    "hermes-" + active.manifest.dependencies.hermes.commit,
  );
  const gbrainCheckout = join(
    SOFTWARE_ROOT,
    "gbrain-" + active.manifest.dependencies.gbrain.commit,
  );
  changed = ensurePinnedDependency({
    id: "hermes",
    repository: active.manifest.dependencies.hermes.repository,
    commit: active.manifest.dependencies.hermes.commit,
    lockFile: "uv.lock",
    lockSha256: active.manifest.dependencies.hermes.lock_sha256,
    destination: hermesCheckout,
    install: () => runChecked(
      CONTRACT_TOOLCHAIN.uv,
      ["sync", "--frozen", "--no-dev"],
      { cwd: hermesCheckout },
      "Hermes locked environment install",
    ),
    installedMarker: join(hermesCheckout, ".venv", "bin", "hermes"),
  }) || changed;
  changed = ensurePinnedDependency({
    id: "gbrain",
    repository: active.manifest.dependencies.gbrain.repository,
    commit: active.manifest.dependencies.gbrain.commit,
    lockFile: "bun.lock",
    lockSha256: active.manifest.dependencies.gbrain.lock_sha256,
    destination: gbrainCheckout,
    install: () => runChecked(
      CONTRACT_TOOLCHAIN.bun,
      ["install", "--frozen-lockfile", "--production"],
      { cwd: gbrainCheckout },
      "GBrain locked environment install",
    ),
    installedMarker: join(gbrainCheckout, "node_modules"),
  }) || changed;

  runChecked(
    "/usr/bin/docker",
    ["image", "inspect", contract.owner_overlay.runtime.sandbox.terminal_image],
    {},
    "Resident terminal image inspection",
    { allowFailure: true, onFailure: () => {
      runChecked(
        "/usr/bin/docker",
        ["pull", contract.owner_overlay.runtime.sandbox.terminal_image],
        {},
        "Resident terminal image pull",
      );
      changed = true;
    } },
  );

  const bindingByCompartment = new Map(
    contract.owner_overlay.communication_bindings.map(
      (binding) => [binding.compartment_id, binding],
    ),
  );
  const credentialMap = new Map(
    secrets.authority_credentials.map(
      (credential) => [
        credential.compartment_id + "\u0000" + credential.purpose,
        credential.value,
      ],
    ),
  );
  const compartmentState = new Map();
  for (const compartment of contract.owner_overlay.authority_compartments) {
    const binding = bindingByCompartment.get(compartment.compartment_id);
    const identity = binding
      ? bindingRuntimeIdentity(contract.machine_id, binding.binding_id)
      : null;
    if (identity) {
      changed = ensureRuntimeIdentity(identity) || changed;
    }
    const owner = identity
      ? lookupIdentity(identity.gatewayUser)
      : { uid: 0, gid: 0 };
    const group = identity
      ? lookupGroup(identity.group)
      : { gid: 0 };
    const token = credentialMap.get(
      compartment.compartment_id + "\u0000" + compartment.repository_credential_purpose,
    );
    assertSecret(token, "repository credential");
    const installed = installCompartmentRepositories({
      contract,
      compartment,
      token,
      ownerUid: owner.uid,
      ownerGid: group.gid,
    });
    changed = installed.changed || changed;
    compartmentState.set(compartment.compartment_id, {
      scopePath: installed.scopePath,
      identity,
      owner,
      group,
    });
  }

  const declaredUnits = [];
  const turnsPerBinding = Math.floor(
    contract.owner_overlay.runtime.quota.max_turns_per_hour /
      contract.owner_overlay.communication_bindings.length,
  );
  for (const [index, binding] of contract.owner_overlay.communication_bindings.entries()) {
    const compartment = contract.owner_overlay.authority_compartments.find(
      (item) => item.compartment_id === binding.compartment_id,
    );
    const state = compartmentState.get(binding.compartment_id);
    const identity = state.identity;
    const gatewayIdentity = lookupIdentity(identity.gatewayUser);
    const bridgeIdentity = lookupIdentity(identity.bridgeUser);
    const bindingRoot = join(RUNTIME_ROOT, "bindings", binding.binding_id);
    const gatewayState = join(bindingRoot, "hermes");
    const gbrainHome = join(bindingRoot, "gbrain-home");
    const queueRoot = join(bindingRoot, "bridge");
    const viewRoot = join(RUNTIME_ROOT, "views", binding.binding_id);
    for (const [path, mode, uid, gid] of [
      [bindingRoot, 0o710, gatewayIdentity.uid, state.group.gid],
      [gatewayState, 0o700, gatewayIdentity.uid, gatewayIdentity.gid],
      [gbrainHome, 0o700, gatewayIdentity.uid, gatewayIdentity.gid],
      [queueRoot, 0o700, bridgeIdentity.uid, bridgeIdentity.gid],
      [viewRoot, 0o750, gatewayIdentity.uid, state.group.gid],
    ]) {
      mkdirOwned(path, mode, uid, gid);
    }
    changed = reconcileScopeLink(join(viewRoot, "scope"), state.scopePath) || changed;
    const instructionPath = join(viewRoot, "binding-instructions.md");
    const instruction = renderBindingInstructions(active.activeRoot, contract, binding);
    changed = writeAtomic(
      instructionPath,
      instruction,
      0o440,
      0,
      state.group.gid,
    ) || changed;
    changed = initializeGbrain({
      gbrainCheckout,
      gbrainHome,
      scopePath: join(viewRoot, "scope"),
      searchMode: contract.owner_overlay.runtime.memory.search_mode,
      uid: gatewayIdentity.uid,
      gid: gatewayIdentity.gid,
    }) || changed;

    const port = bindingPort(index);
    const config = renderHermesConfig({
      contract,
      compartment,
      scopePath: state.scopePath,
      gbrainHome,
      gbrainCheckout,
      port,
    });
    changed = writeAtomic(
      join(gatewayState, "config.yaml"),
      JSON.stringify(config, null, 2) + "\n",
      0o600,
      gatewayIdentity.uid,
      gatewayIdentity.gid,
    ) || changed;
    changed = writeAtomic(
      join(gatewayState, ".managed"),
      "lazurio-machines\n",
      0o600,
      gatewayIdentity.uid,
      gatewayIdentity.gid,
    ) || changed;
    const bindingSecret = secrets.bindings.find(
      (item) => item.binding_id === binding.binding_id,
    );
    const runtimeKey = deriveBindingApiKey(
      secrets.runtime.api_server_key,
      binding.binding_id,
    );
    const gatewayEnvironmentPath = join(
      RUNTIME_ROOT,
      "environment",
      binding.binding_id + "-gateway.env",
    );
    const bridgeEnvironmentPath = join(
      RUNTIME_ROOT,
      "environment",
      binding.binding_id + "-bridge.env",
    );
    changed = writeAtomic(
      gatewayEnvironmentPath,
      renderEnvironment({
        HERMES_HOME: gatewayState,
        HERMES_MANAGED: "lazurio-machines",
        OPENROUTER_API_KEY: secrets.model.api_key,
        API_SERVER_KEY: runtimeKey,
        API_SERVER_HOST: "127.0.0.1",
        API_SERVER_PORT: String(port),
        HERMES_DISABLE_AUTO_UPDATE: "1",
      }),
      0o640,
      0,
      gatewayIdentity.gid,
    ) || changed;
    const bridgeEnvironment = {
      AGENT_RUNTIME_URL: "http://127.0.0.1:" + port + "/v1/chat/completions",
      AGENT_RUNTIME_KEY: runtimeKey,
      AGENT_RUNTIME_SESSION_HEADER: "X-Hermes-Session-Id",
      AGENT_RUNTIME_MODEL: "hermes",
      ZULIP_SITE: binding.zulip.site,
      BUDDY_BOT_EMAIL: bindingSecret.email,
      BUDDY_BOT_API_KEY: bindingSecret.api_key,
      BUDDY_NAME:
        contract.machine_profile === "buddy"
          ? "Buddy"
          : contract.owner_overlay.principal.principal_id,
      BUDDY_BRIDGE_QUEUE_DIR: queueRoot,
      BUDDY_TURNS_PER_HOUR: String(turnsPerBinding),
      LAZURIO_BINDING_ID: binding.binding_id,
      LAZURIO_BINDING_ROLE: binding.realm_role,
      LAZURIO_RUNTIME_PERSONA: contract.machine_profile,
      LAZURIO_INSTRUCTION_FILE: instructionPath,
      LAZURIO_ALLOWED_SENDER_IDS: binding.routing.allowed_sender_ids.join(","),
      LAZURIO_ALLOWED_STREAM_IDS: binding.routing.allowed_stream_ids.join(","),
      LAZURIO_TOPIC_POLICY: binding.routing.topic_policy,
    };
    if (binding.realm_role === "personal-home") {
      const profilePath = join(state.scopePath, "buddy");
      for (const name of ["CONSTITUTION.md", "MANDATES.md"]) {
        assertRegularFile(join(profilePath, name), "private Buddy profile");
      }
      bridgeEnvironment.BUDDY_PROFILE_DIR = profilePath;
    }
    changed = writeAtomic(
      bridgeEnvironmentPath,
      renderEnvironment(bridgeEnvironment),
      0o640,
      0,
      bridgeIdentity.gid,
    ) || changed;

    const gatewayUnitPath = join("/etc/systemd/system", identity.gatewayUnit);
    const bridgeUnitPath = join("/etc/systemd/system", identity.bridgeUnit);
    changed = writeAtomic(
      gatewayUnitPath,
      renderGatewayUnit({
        identity,
        viewRoot,
        scopePath: state.scopePath,
        stateRoot: bindingRoot,
        environmentFile: gatewayEnvironmentPath,
        hermesExecutable: join(hermesCheckout, ".venv", "bin", "hermes"),
      }),
      0o644,
      0,
      0,
    ) || changed;
    changed = writeAtomic(
      bridgeUnitPath,
      renderBridgeUnit({
        identity,
        viewRoot,
        scopePath: state.scopePath,
        queueRoot,
        environmentFile: bridgeEnvironmentPath,
      }),
      0o644,
      0,
      0,
    ) || changed;
    declaredUnits.push({
      binding_id: binding.binding_id,
      gateway: identity.gatewayUnit,
      bridge: identity.bridgeUnit,
      port,
      queue_root: queueRoot,
    });
  }

  const oldRegistry = readJsonOrNull(join(RUNTIME_ROOT, "units.json"));
  for (const stale of oldRegistry?.bindings || []) {
    if (!declaredUnits.some((unit) => unit.binding_id === stale.binding_id)) {
      systemctl(["disable", "--now", stale.bridge], true);
      systemctl(["disable", "--now", stale.gateway], true);
      changed = true;
    }
  }
  changed = writeAtomic(
    join(RUNTIME_ROOT, "units.json"),
    JSON.stringify(
      {
        schema_version: "machines.resident-units.v1",
        bindings: declaredUnits,
      },
      null,
      2,
    ) + "\n",
    0o600,
    0,
    0,
  ) || changed;
  systemctl(["daemon-reload"]);
  for (const unit of declaredUnits) {
    changed = convergeUnit(unit.gateway, changed) || changed;
  }
  for (const unit of declaredUnits) {
    changed = convergeUnit(unit.bridge, changed) || changed;
  }

  const installed = {
    schema_version: INSTALLED_SCHEMA,
    machine_id: contract.machine_id,
    profile: contract.machine_profile,
    workload_id: contract.workload_id,
    artifact_id: active.manifest.artifact_id,
    source_commit: active.manifest.source.commit,
    archive_sha256: contract.owner_overlay.runtime.artifact.archive_sha256,
    bun_version: active.manifest.dependencies.toolchain.bun,
    hermes_commit: active.manifest.dependencies.hermes.commit,
    gbrain_commit: active.manifest.dependencies.gbrain.commit,
    binding_ids: declaredUnits.map((unit) => unit.binding_id),
    installed_at: new Date().toISOString(),
  };
  const installedPath = join(RUNTIME_ROOT, "installed.json");
  const priorInstalled = readJsonOrNull(installedPath);
  if (priorInstalled &&
      stableInstalledIdentity(priorInstalled) === stableInstalledIdentity(installed)) {
    installed.installed_at = priorInstalled.installed_at;
  }
  changed = writeAtomic(
    installedPath,
    JSON.stringify(installed, null, 2) + "\n",
    0o600,
    0,
    0,
  ) || changed;
  return { schema_version: "lazurio.resident-controller-result.v1", operation: "runtime", changed };
}

function readActiveArtifact(contract) {
  const activeLink = join(contract.paths.install_root, "active");
  const activeRoot = realpathSync(activeLink);
  assertWithin(join(contract.paths.install_root, "versions"), activeRoot, "active Resident artifact");
  const manifest = readJsonStrict(join(activeRoot, "lazurio.resident.json"), "Resident manifest");
  const desired = contract.owner_overlay.runtime.artifact;
  if (manifest.schema_version !== "lazurio.resident.manifest.v1" ||
      manifest.profile !== contract.machine_profile ||
      manifest.artifact_id !== desired.artifact_id ||
      manifest.source?.commit !== desired.source_commit ||
      manifest.target?.os !== "linux" ||
      manifest.target?.arch !== contract.owner_overlay.host.architecture ||
      manifest.dependencies?.toolchain?.bun !== "1.4.0" ||
      manifest.dependencies?.hermes?.repository !== "Lazurio/hermes-agent" ||
      manifest.dependencies?.gbrain?.repository !== "Lazurio/gbrain") {
    throw new Error("Active Resident artifact does not match the reviewed controller contract");
  }
  return { activeRoot, manifest };
}

function ensurePinnedDependency({
  id,
  repository,
  commit,
  lockFile,
  lockSha256,
  destination,
  install,
  installedMarker,
}) {
  if (!REPOSITORY.test(repository) || !SHA40.test(commit) || !SHA256.test(lockSha256)) {
    throw new Error("Resident " + id + " pin is invalid");
  }
  let changed = false;
  const gitEnvironment = sanitizedGitEnvironment();
  if (!existsSync(destination)) {
    const temporary = destination + ".staging-" + process.pid;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSecure(temporary, 0o700);
    try {
      runChecked(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "init", "--quiet", temporary],
        { env: gitEnvironment },
        id + " checkout init",
      );
      runChecked(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "-C", temporary, "remote", "add", "origin", "https://github.com/" + repository + ".git"],
        { env: gitEnvironment },
        id + " checkout remote",
      );
      runChecked(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-C", temporary, "fetch", "--quiet", "--depth=1", "origin", commit],
        { env: gitEnvironment },
        id + " exact commit fetch",
      );
      runChecked(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "-C", temporary, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
        { env: gitEnvironment },
        id + " exact commit checkout",
      );
      renameSync(temporary, destination);
      changed = true;
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  const destinationStat = lstatSync(destination);
  const gitDirectory = join(destination, ".git");
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() ||
      !existsSync(gitDirectory) || !lstatSync(gitDirectory).isDirectory() ||
      lstatSync(gitDirectory).isSymbolicLink()) {
    throw new Error("Resident " + id + " checkout path is unsafe");
  }
  const origin = runChecked(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-C", destination, "remote", "get-url", "origin"],
    { env: gitEnvironment },
    id + " checkout origin verification",
  ).trim().replace(/\.git$/, "");
  const head = runChecked(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-C", destination, "rev-parse", "HEAD"],
    { env: gitEnvironment },
    id + " checkout verification",
  ).trim();
  const trackedDrift = runChecked(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-C", destination, "status", "--porcelain", "--untracked-files=no"],
    { env: gitEnvironment },
    id + " tracked tree verification",
  ).trim();
  assertRegularFile(join(destination, lockFile), "Resident " + id + " lockfile");
  if (origin !== "https://github.com/" + repository ||
      head !== commit ||
      trackedDrift !== "" ||
      sha256(readFileSync(join(destination, lockFile))) !== lockSha256) {
    throw new Error("Resident " + id + " checkout does not match its exact pin");
  }
  if (!existsSync(installedMarker)) {
    install();
    changed = true;
  }
  return changed;
}

function installCompartmentRepositories({
  contract,
  compartment,
  token,
  ownerUid,
  ownerGid,
}) {
  const personal = compartment.kind === "personal";
  const rootRepository = personal
    ? contract.owner_overlay.principal.personalspace_repository
    : compartment.organization.root_repository;
  if (!compartment.repositories.some(
    (grant) => grant.repository.toLowerCase() === rootRepository.toLowerCase(),
  )) {
    throw new Error("Authority Compartment primary repository is not granted");
  }
  const primaryRoot = personal
    ? join(
      CONTRACT_PATHS.personalspace_root,
      contract.owner_overlay.principal.principal_id + "_GEN3",
    )
    : join(
      CONTRACT_PATHS.organizations_root,
      compartment.organization.github_login + "_GEN3",
    );
  let changed = ensureAuthorityCheckout(
    rootRepository,
    primaryRoot,
    token,
    ownerUid,
    ownerGid,
  );
  const used = new Set([basename(primaryRoot).toLowerCase()]);
  for (const grant of compartment.repositories) {
    if (grant.repository.toLowerCase() === rootRepository.toLowerCase()) continue;
    const repoName = grant.repository.split("/")[1];
    if (used.has(repoName.toLowerCase())) {
      throw new Error("Authority Compartment repository paths collide");
    }
    used.add(repoName.toLowerCase());
    const destination = join(primaryRoot, "productionspace", repoName);
    changed = ensureAuthorityCheckout(
      grant.repository,
      destination,
      token,
      ownerUid,
      ownerGid,
    ) || changed;
  }
  runChecked(
    "/usr/bin/chown",
    ["-R", String(ownerUid) + ":" + String(ownerGid), primaryRoot],
    {},
    "Authority Compartment ownership",
  );
  runChecked(
    "/usr/bin/chmod",
    ["-R", "u+rwX,g+rX,o-rwx", primaryRoot],
    {},
    "Authority Compartment permissions",
  );
  return { changed, scopePath: primaryRoot };
}

function ensureAuthorityCheckout(repository, destination, token, uid, gid) {
  if (!REPOSITORY.test(repository)) throw new Error("Authority repository identity is invalid");
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    const gitPath = join(destination, ".git");
    if (!stat.isDirectory() || stat.isSymbolicLink() || !existsSync(gitPath) ||
        !lstatSync(gitPath).isDirectory() || lstatSync(gitPath).isSymbolicLink()) {
      throw new Error("Authority repository destination is not a Git checkout");
    }
    const origin = runChecked(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-C", destination, "remote", "get-url", "origin"],
      { env: sanitizedGitEnvironment() },
      "Authority repository origin verification",
    ).trim().replace(/\.git$/, "");
    if (origin !== "https://github.com/" + repository) {
      throw new Error("Authority repository origin does not match its grant");
    }
    return false;
  }
  const parent = dirname(destination);
  if (!existsSync(parent)) mkdirOwned(parent, 0o750, uid, gid);
  const stagingParent = join(parent, "." + basename(destination) + ".staging-" + process.pid);
  const temporary = join(stagingParent, "checkout");
  rmSync(stagingParent, { recursive: true, force: true });
  mkdirOwned(stagingParent, 0o700, uid, gid);
  const askpass = join(RUNTIME_ROOT, "git-askpass.sh");
  writeAtomic(
    askpass,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' \"$LAZURIO_GIT_USERNAME\" ;;",
      "  *) printf '%s\\n' \"$LAZURIO_GIT_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
    0o755,
    0,
    0,
  );
  const env = {
    ...sanitizedGitEnvironment(),
    HOME: join(RUNTIME_ROOT, "git-home", String(uid)),
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    LAZURIO_GIT_USERNAME: "x-access-token",
    LAZURIO_GIT_TOKEN: token,
  };
  mkdirSecure(join(RUNTIME_ROOT, "git-home"), 0o711);
  mkdirOwned(env.HOME, 0o700, uid, gid);
  try {
    runChecked(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "clone", "--quiet", "https://github.com/" + repository + ".git", temporary],
      { env, uid, gid },
      "Authority repository clone",
    );
    renameSync(temporary, destination);
    rmSync(stagingParent, { recursive: true, force: true });
  } catch (error) {
    rmSync(stagingParent, { recursive: true, force: true });
    throw error;
  }
  return true;
}

function ensureRuntimeIdentity(identity) {
  let changed = false;
  if (!commandSucceeds("/usr/bin/getent", ["group", identity.group])) {
    runChecked("/usr/sbin/groupadd", ["--system", identity.group], {}, "Resident binding group creation");
    changed = true;
  }
  for (const user of [identity.gatewayUser, identity.bridgeUser]) {
    if (!commandSucceeds("/usr/bin/id", ["-u", user])) {
      runChecked(
        "/usr/sbin/useradd",
        [
          "--system",
          "--user-group",
          "--home-dir",
          join(RUNTIME_ROOT, "identities", user),
          "--create-home",
          "--shell",
          "/usr/sbin/nologin",
          user,
        ],
        {},
        "Resident runtime identity creation",
      );
      changed = true;
    }
    runChecked(
      "/usr/sbin/usermod",
      ["--append", "--groups", identity.group, user],
      {},
      "Resident binding group membership",
    );
  }
  runChecked(
    "/usr/sbin/usermod",
    ["--append", "--groups", "docker", identity.gatewayUser],
    {},
    "Hermes Docker supervisor membership",
  );
  return changed;
}

function lookupIdentity(user) {
  const uid = Number(
    runChecked("/usr/bin/id", ["-u", user], {}, "Resident uid lookup").trim(),
  );
  const gid = Number(
    runChecked("/usr/bin/id", ["-g", user], {}, "Resident gid lookup").trim(),
  );
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new Error("Resident runtime identity lookup failed");
  }
  return { uid, gid };
}

function lookupGroup(group) {
  const line = runChecked(
    "/usr/bin/getent",
    ["group", group],
    {},
    "Resident group lookup",
  ).trim();
  const gid = Number(line.split(":")[2]);
  if (!Number.isSafeInteger(gid)) throw new Error("Resident group lookup failed");
  return { gid };
}

function initializeGbrain({
  gbrainCheckout,
  gbrainHome,
  scopePath,
  searchMode,
  uid,
  gid,
}) {
  const configPath = join(gbrainHome, ".gbrain", "config.json");
  const env = {
    ...minimalEnvironment(),
    HOME: gbrainHome,
    GBRAIN_HOME: gbrainHome,
    GBRAIN_SKIP_STARTUP_HOOKS: "1",
    NODE_ENV: "production",
  };
  let changed = false;
  if (!existsSync(configPath)) {
    runChecked(
      CONTRACT_TOOLCHAIN.bun,
      [
        join(gbrainCheckout, "src", "cli.ts"),
        "init",
        "--pglite",
        "--no-embedding",
        "--non-interactive",
        "--json",
      ],
      { cwd: scopePath, env, uid, gid },
      "Binding-scoped GBrain initialization",
    );
    changed = true;
  }
  let modeReadFailed = false;
  const currentMode = runChecked(
    CONTRACT_TOOLCHAIN.bun,
    [join(gbrainCheckout, "src", "cli.ts"), "config", "get", "search.mode"],
    { cwd: scopePath, env, uid, gid },
    "Binding-scoped GBrain search mode readback",
    { allowFailure: true, onFailure: () => { modeReadFailed = true; } },
  ).trim();
  if (modeReadFailed || currentMode !== searchMode) {
    runChecked(
      CONTRACT_TOOLCHAIN.bun,
      [
        join(gbrainCheckout, "src", "cli.ts"),
        "config",
        "set",
        "search.mode",
        searchMode,
      ],
      { cwd: scopePath, env, uid, gid },
      "Binding-scoped GBrain search mode",
    );
    changed = true;
  }
  return changed;
}

function renderBindingInstructions(activeRoot, contract, binding) {
  const rootInstructions = readFileSync(join(activeRoot, "AGENTS.md"), "utf8").trim();
  const persona =
    contract.machine_profile === "buddy"
      ? "Buddy tohoto lidského Principála"
      : "AI Kolega, který je sám Principálem";
  return [
    rootInstructions,
    "",
    "## Aktivní Communication Binding",
    "",
    "Tento proces je " + persona + ".",
    "Binding: " + binding.binding_id + ".",
    "Authority Compartment: " + binding.compartment_id + ".",
    "Realm role: " + binding.realm_role + ".",
    "",
    "Než načteš instrukce, paměť, credentials, repozitáře nebo nástroje,",
    "drž pouze tento vybraný Authority Compartment. Jiný Personalspace ani",
    "jinou Organizaci z tohoto turnu nečti, neodvozuj a nepropojuj.",
    "",
  ].join("\n");
}

function reconcileScopeLink(linkPath, targetPath) {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error("Resident binding scope projection is not a symlink");
    }
    if (resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath) return false;
    rmSync(linkPath);
  }
  symlinkSync(targetPath, linkPath, "dir");
  return true;
}

function renderEnvironment(values) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, raw]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        throw new Error("Resident environment key is invalid");
      }
      const value = String(raw);
      if (/[\u0000\r\n]/.test(value)) {
        throw new Error("Resident environment value is invalid");
      }
      return key + "=" + JSON.stringify(value);
    })
    .join("\n") + "\n";
}

function convergeUnit(unit, restart) {
  if (restart) {
    systemctl(["enable", "--now", unit]);
    systemctl(["restart", unit]);
    return true;
  }
  if (!systemctlIsActive(unit)) {
    systemctl(["enable", "--now", unit]);
    return true;
  }
  systemctl(["enable", unit]);
  return false;
}

function stableInstalledIdentity(value) {
  const copy = { ...value };
  delete copy.installed_at;
  return JSON.stringify(copy);
}

export async function reconcileResidentZulip(contractInput, secretsInput, fetchImpl = fetch) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  const secrets = validateSecretBundle(contract, secretsInput);
  if (contract.machine_profile !== "buddy") {
    throw new Error("Personal Zulip exists only on a Buddy Resident");
  }
  const home = contract.owner_overlay.home_zulip;
  const personalBinding = contract.owner_overlay.communication_bindings.find(
    (binding) => binding.realm_role === "personal-home",
  );
  const bindingSecret = secrets.bindings.find(
    (binding) => binding.binding_id === personalBinding.binding_id,
  );
  const root = join(RUNTIME_ROOT, "zulip");
  const secretsRoot = join(root, "secrets");
  mkdirSecure(root, 0o700);
  mkdirSecure(secretsRoot, 0o700);
  const response = await fetchImpl(ZULIP_COMPOSE_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Official Zulip Compose download failed");
  const composeBytes = Buffer.from(await response.arrayBuffer());
  if (sha256(composeBytes) !== ZULIP_COMPOSE_SHA256) {
    throw new Error("Official Zulip Compose digest does not match its reviewed pin");
  }
  let changed = writeAtomic(
    join(root, "compose.yaml"),
    composeBytes,
    0o600,
    0,
    0,
  );
  const secretValues = {
    zulip__postgres_password: secrets.home_zulip.postgres_password,
    zulip__memcached_password: secrets.home_zulip.memcached_password,
    zulip__rabbitmq_password: secrets.home_zulip.rabbitmq_password,
    zulip__redis_password: secrets.home_zulip.redis_password,
    zulip__secret_key: secrets.home_zulip.secret_key,
    zulip__email_password: secrets.home_zulip.email_password,
    lazurio__administrator_password: secrets.home_zulip.administrator_password,
    lazurio__bot_api_key: bindingSecret.api_key,
  };
  const secretFiles = {};
  for (const [name, value] of Object.entries(secretValues)) {
    const path = join(secretsRoot, name);
    changed = writeAtomic(path, value, 0o600, 0, 0) || changed;
    secretFiles[name] = path;
  }
  changed = writeAtomic(
    join(root, "compose.override.yaml"),
    renderZulipOverride(home, secretFiles),
    0o600,
    0,
    0,
  ) || changed;
  const host = new URL(home.origin).host;
  changed = writeAtomic(
    "/etc/caddy/Caddyfile",
    [
      host + " {",
      "  encode zstd gzip",
      "  reverse_proxy 127.0.0.1:8080",
      "}",
      "",
    ].join("\n"),
    0o644,
    0,
    0,
  ) || changed;

  compose(root, ["pull", "--quiet"]);
  compose(root, ["run", "--rm", "zulip", "app:init"]);
  const bootstrap = renderZulipBootstrapScript(home, bindingSecret.email);
  compose(root, ["run", "--rm", "-T", "zulip", "app:managepy", "shell"], {
    input: bootstrap,
  });
  compose(root, ["up", "-d", "--wait"]);
  changed = writeAtomic(
    join(root, "initialized.json"),
    JSON.stringify(
      {
        schema_version: "machines.resident-zulip.v1",
        compose_commit: ZULIP_COMPOSE_COMMIT,
        data_volume: home.data_volume,
      },
      null,
      2,
    ) + "\n",
    0o600,
    0,
    0,
  ) || changed;
  const units = readUnitRegistry();
  const homeUnit = units.bindings.find(
    (entry) => entry.binding_id === personalBinding.binding_id,
  );
  if (homeUnit) systemctl(["restart", homeUnit.bridge]);
  return { schema_version: "lazurio.resident-controller-result.v1", operation: "zulip", changed };
}

function renderZulipBootstrapScript(home, botEmail) {
  const realmName = JSON.stringify(home.realm_name);
  const adminEmail = JSON.stringify(home.administrator_email);
  const adminName = JSON.stringify(home.administrator_name);
  const genericBotEmail = JSON.stringify(botEmail);
  return [
    "from pathlib import Path",
    "from zerver.actions.create_realm import do_create_realm",
    "from zerver.actions.create_user import do_create_user",
    "from zerver.models import Realm, UserProfile",
    "",
    "realm = Realm.objects.filter(string_id='').first()",
    "realm_created = realm is None",
    "if realm_created:",
    "    realm = do_create_realm(string_id='', name=" + realmName + ")",
    "owner = UserProfile.objects.filter(realm=realm, delivery_email__iexact=" + adminEmail + ").first()",
    "admin_password = Path('/run/secrets/lazurio__administrator_password').read_text()",
    "if owner is None:",
    "    owner = do_create_user(" + adminEmail + ", admin_password, realm, " + adminName + ", role=UserProfile.ROLE_REALM_OWNER, realm_creation=realm_created, acting_user=None)",
    "else:",
    "    if owner.role != UserProfile.ROLE_REALM_OWNER:",
    "        raise RuntimeError('existing Zulip administrator is not the realm owner')",
    "    owner.set_password(admin_password)",
    "    owner.save(update_fields=['password'])",
    "bot = UserProfile.objects.filter(realm=realm, delivery_email__iexact=" + genericBotEmail + ").first()",
    "if bot is None:",
    "    bot = do_create_user(" + genericBotEmail + ", None, realm, 'Buddy', bot_type=UserProfile.DEFAULT_BOT, bot_owner=owner, acting_user=owner)",
    "elif bot.bot_type != UserProfile.DEFAULT_BOT or bot.bot_owner_id != owner.id:",
    "    raise RuntimeError('existing Zulip bot identity does not match the binding contract')",
    "bot.api_key = Path('/run/secrets/lazurio__bot_api_key').read_text()",
    "bot.save(update_fields=['api_key'])",
    "",
  ].join("\n");
}

export function prepareResidentCheckpoint(contractInput, outputPath) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  assertWithin(CONTRACT_PATHS.state_root, resolve(outputPath), "checkpoint output");
  let databaseBackup = null;
  if (contract.machine_profile === "buddy") {
    const zulipRoot = join(RUNTIME_ROOT, "zulip");
    compose(zulipRoot, ["exec", "-T", "zulip", "/sbin/entrypoint.sh", "app:backup"]);
    databaseBackup = latestZulipBackup(
      contract.owner_overlay.home_zulip.data_volume,
    );
  }
  stopResidentServices(contract);
  const installed = readJsonStrict(join(RUNTIME_ROOT, "installed.json"), "Resident installation");
  const checkpoint = {
    schema_version: CHECKPOINT_SCHEMA,
    machine_id: contract.machine_id,
    profile: contract.machine_profile,
    artifact_id: installed.artifact_id,
    deployment_head: contract.deployment_head,
    machines_head: contract.machines_head,
    binding_ids: contract.owner_overlay.communication_bindings.map(
      (binding) => binding.binding_id,
    ),
    created_at: timestamp(),
    ...(databaseBackup ? { zulip_database_backup: databaseBackup } : {}),
  };
  writeAtomic(
    outputPath,
    JSON.stringify(checkpoint, null, 2) + "\n",
    0o600,
    0,
    0,
  );
  return {
    schema_version: "lazurio.resident-controller-result.v1",
    operation: "checkpoint-prepare",
    changed: true,
  };
}

export function resumeResidentCheckpoint(contractInput) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  startResidentServices(contract);
  return {
    schema_version: "lazurio.resident-controller-result.v1",
    operation: "checkpoint-resume",
    changed: true,
  };
}

export function prepareResidentRestore(contractInput, checkpointPath) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  const checkpoint = readCheckpoint(checkpointPath, contract);
  stopResidentServices(contract);
  return {
    schema_version: "lazurio.resident-controller-result.v1",
    operation: "restore-prepare",
    changed: true,
    checkpoint_artifact_id: checkpoint.artifact_id,
  };
}

export function resumeResidentRestore(contractInput, checkpointPath) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  const checkpoint = checkpointPath
    ? readCheckpoint(checkpointPath, contract)
    : null;
  if (contract.machine_profile === "buddy" && checkpoint) {
    if (!/^[A-Za-z0-9_.-]+$/.test(checkpoint.zulip_database_backup || "")) {
      throw new Error("Resident checkpoint has no safe Zulip database backup name");
    }
    const zulipRoot = join(RUNTIME_ROOT, "zulip");
    compose(
      zulipRoot,
      [
        "run",
        "--rm",
        "zulip",
        "app:restore",
        checkpoint.zulip_database_backup,
      ],
    );
  }
  startResidentServices(contract);
  return {
    schema_version: "lazurio.resident-controller-result.v1",
    operation: "restore-resume",
    changed: true,
  };
}

function readCheckpoint(path, contract) {
  const checkpoint = readJsonStrict(path, "Resident checkpoint");
  const expectedBindings = contract.owner_overlay.communication_bindings.map(
    (binding) => binding.binding_id,
  );
  if (checkpoint.schema_version !== CHECKPOINT_SCHEMA ||
      checkpoint.machine_id !== contract.machine_id ||
      checkpoint.profile !== contract.machine_profile ||
      !Array.isArray(checkpoint.binding_ids) ||
      checkpoint.binding_ids.join("\u0000") !== expectedBindings.join("\u0000") ||
      checkpoint.artifact_id !== contract.owner_overlay.runtime.artifact.artifact_id ||
      checkpoint.deployment_head !== contract.deployment_head ||
      checkpoint.machines_head !== contract.machines_head) {
    throw new Error("Resident checkpoint is incompatible with this Machine");
  }
  return checkpoint;
}

function stopResidentServices(contract) {
  const units = readUnitRegistry();
  for (const entry of [...units.bindings].reverse()) {
    systemctl(["stop", entry.bridge], true);
  }
  for (const entry of [...units.bindings].reverse()) {
    systemctl(["stop", entry.gateway], true);
  }
  if (contract.machine_profile === "buddy") {
    compose(join(RUNTIME_ROOT, "zulip"), ["stop"]);
  }
}

function startResidentServices(contract) {
  if (contract.machine_profile === "buddy") {
    compose(join(RUNTIME_ROOT, "zulip"), ["up", "-d", "--wait"]);
  }
  const units = readUnitRegistry();
  for (const entry of units.bindings) systemctl(["start", entry.gateway]);
  for (const entry of units.bindings) systemctl(["start", entry.bridge]);
}

function latestZulipBackup(volume) {
  if (volume !== "lazurio-buddy-zulip-data") {
    throw new Error("Buddy Zulip data volume is unsupported");
  }
  const directory = join("/var/lib/docker/volumes", volume, "_data", "backups");
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^backup-[A-Za-z0-9_.-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (candidates.length === 0) throw new Error("Zulip app:backup produced no backup file");
  return candidates[candidates.length - 1];
}

export function residentStatus(contractInput, now = new Date()) {
  requireRoot();
  const contract = validateControllerContract(contractInput);
  const units = readUnitRegistry();
  const installed = readJsonOrNull(join(RUNTIME_ROOT, "installed.json"));
  const applied = readJsonOrNull(join(CONTRACT_PATHS.state_root, "applied.json"));
  const installation =
    installed?.schema_version === INSTALLED_SCHEMA &&
    installed.machine_id === contract.machine_id
      ? {
        state: "installed",
        artifact_id: installed.artifact_id,
        source_commit: installed.source_commit,
        archive_sha256: installed.archive_sha256,
        bun_version: installed.bun_version,
        hermes_commit: installed.hermes_commit,
      }
      : { state: "absent" };
  const gatewaysActive =
    units.bindings.length > 0 &&
    units.bindings.every((entry) => systemctlIsActive(entry.gateway));
  const bridgesActive =
    units.bindings.length > 0 &&
    units.bindings.every((entry) => systemctlIsActive(entry.bridge));
  let healthyBindings = 0;
  for (const entry of units.bindings) {
    const poller = readJsonOrNull(join(entry.queue_root, "state", "poller.json"));
    if (systemctlIsActive(entry.gateway) &&
        systemctlIsActive(entry.bridge) &&
        poller?.version === 1 &&
        poller.registered === true) {
      healthyBindings += 1;
    }
  }
  const backupRecord = readJsonOrNull(join(CONTRACT_PATHS.state_root, "backup.json"));
  let backup = { state: "missing", encrypted: false };
  if (backupRecord?.schema_version === "machines.resident-backup-status.v1" &&
      backupRecord.state === "fresh" &&
      backupRecord.encrypted === true &&
      typeof backupRecord.completed_at === "string") {
    const age = now.getTime() - new Date(backupRecord.completed_at).getTime();
    const maximum =
      contract.owner_overlay.runtime.backup.maximum_age_hours * 60 * 60 * 1000;
    backup = {
      state: Number.isFinite(age) && age >= 0 && age <= maximum ? "fresh" : "stale",
      encrypted: true,
      completed_at: backupRecord.completed_at,
    };
  }
  const checkpointPath = join(CONTRACT_PATHS.state_root, "checkpoint-manifest.json");
  let checkpoint = { state: "missing" };
  if (existsSync(checkpointPath) && SHA256.test(backupRecord?.checkpoint_sha256 || "")) {
    const digest = sha256(readFileSync(checkpointPath));
    const record = readJsonOrNull(checkpointPath);
    if (digest === backupRecord.checkpoint_sha256 &&
        record?.schema_version === CHECKPOINT_SCHEMA &&
        record.machine_id === contract.machine_id &&
        record.deployment_head === contract.deployment_head &&
        record.machines_head === contract.machines_head) {
      checkpoint = { state: "ready", artifact_id: record.artifact_id };
    } else {
      checkpoint = { state: "failed" };
    }
  }
  const sandboxPresent = commandSucceeds(
    "/usr/bin/docker",
    ["image", "inspect", contract.owner_overlay.runtime.sandbox.terminal_image],
  );
  const personalZulipActive =
    contract.machine_profile !== "buddy" ||
    composeIsHealthy(join(RUNTIME_ROOT, "zulip"));
  const services = [
    { service_id: "binding-workers", state: bridgesActive ? "active" : "inactive" },
    { service_id: "gateway", state: gatewaysActive ? "active" : "inactive" },
    ...(contract.machine_profile === "buddy"
      ? [{ service_id: "personal-zulip", state: personalZulipActive ? "active" : "inactive" }]
      : []),
    {
      service_id: "resident",
      state: installation.state === "installed" ? "active" : "absent",
    },
  ].sort((left, right) => left.service_id.localeCompare(right.service_id));
  return {
    schema_version: STATUS_SCHEMA,
    profile: contract.machine_profile,
    workload_id: contract.workload_id,
    applied,
    installation,
    services,
    backup,
    checkpoint,
    communications: {
      declared_bindings: contract.owner_overlay.communication_bindings.length,
      healthy_bindings: healthyBindings,
      failed_bindings:
        contract.owner_overlay.communication_bindings.length - healthyBindings,
    },
    sandbox: {
      state: sandboxPresent ? "ready" : "failed",
      no_new_privileges: true,
      docker_socket_mounted: false,
    },
  };
}

export function verifyResident(contractInput) {
  const contract = validateControllerContract(contractInput);
  const status = residentStatus(contract);
  const desired = contract.owner_overlay.runtime.artifact;
  const serviceHealthy = status.services.every((service) => service.state === "active");
  const applied = status.applied;
  const healthy =
    applied?.schema_version === "machines.resident-applied.v1" &&
    applied.machine_id === contract.machine_id &&
    applied.deployment_head === contract.deployment_head &&
    applied.machines_head === contract.machines_head &&
    status.installation.state === "installed" &&
    status.installation.artifact_id === desired.artifact_id &&
    status.installation.source_commit === desired.source_commit &&
    status.installation.archive_sha256 === desired.archive_sha256 &&
    status.backup.state === "fresh" &&
    status.backup.encrypted === true &&
    status.checkpoint.state === "ready" &&
    status.checkpoint.artifact_id === desired.artifact_id &&
    status.communications.healthy_bindings ===
      status.communications.declared_bindings &&
    status.communications.failed_bindings === 0 &&
    status.sandbox.state === "ready" &&
    serviceHealthy;
  if (!healthy) throw new Error("Resident final health gate failed");
  return {
    schema_version: "lazurio.resident-controller-result.v1",
    operation: "verify",
    changed: false,
  };
}

function composeIsHealthy(root) {
  const result = spawnSync(
    "/usr/bin/docker",
    composeArguments(root, ["ps", "--format", "json"]),
    { encoding: "utf8", env: minimalEnvironment() },
  );
  if (result.status !== 0) return false;
  try {
    const raw = result.stdout.trim();
    let services;
    try {
      const parsed = JSON.parse(raw);
      services = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      services = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
    if (services.length < 5) return false;
    return services.every((service) => {
      return service.State === "running" &&
        (!service.Health || service.Health === "healthy");
    });
  } catch {
    return false;
  }
}

function compose(root, args, options = {}) {
  return runChecked(
    "/usr/bin/docker",
    composeArguments(root, args),
    {
      cwd: root,
      env: minimalEnvironment(),
      input: options.input,
      timeout: options.timeout || 20 * 60 * 1000,
    },
    "Buddy Zulip Compose operation",
  );
}

function composeArguments(root, args) {
  return [
    "compose",
    "--project-name",
    "lazurio-buddy",
    "--file",
    join(root, "compose.yaml"),
    "--file",
    join(root, "compose.override.yaml"),
    ...args,
  ];
}

function readUnitRegistry() {
  const registry = readJsonStrict(join(RUNTIME_ROOT, "units.json"), "Resident unit registry");
  if (registry.schema_version !== "machines.resident-units.v1" ||
      !Array.isArray(registry.bindings)) {
    throw new Error("Resident unit registry is invalid");
  }
  return registry;
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function requireRoot() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("Resident controller operations require root");
  }
}

function assertWithin(root, candidate, label) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate === normalizedRoot ||
      !normalizedCandidate.startsWith(normalizedRoot + sep)) {
    throw new Error(label + " escapes its canonical root");
  }
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(label + " is not a regular file");
  }
}

function readJsonStrict(path, label) {
  assertRegularFile(path, label);
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024 || bytes.includes(0)) {
    throw new Error(label + " is invalid");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(label + " is not valid JSON");
  }
}

function readJsonOrNull(path) {
  try {
    return readJsonStrict(path, "Resident state");
  } catch {
    return null;
  }
}

function mkdirSecure(path, mode) {
  mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Resident directory path is unsafe");
  }
  chmodSync(path, mode);
}

function mkdirOwned(path, mode, uid, gid) {
  mkdirSecure(path, mode);
  chownSync(path, uid, gid);
}

function writeAtomic(path, value, mode, uid, gid) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Resident managed file path is unsafe");
    }
    if (readFileSync(path).equals(bytes) &&
        (stat.mode & 0o777) === mode &&
        stat.uid === uid &&
        stat.gid === gid) {
      return false;
    }
  }
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o755 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Resident managed file parent is unsafe");
  }
  const temporary = path + ".tmp-" + process.pid;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  chmodSync(temporary, mode);
  chownSync(temporary, uid, gid);
  renameSync(temporary, path);
  return true;
}

function minimalEnvironment() {
  return {
    HOME: "/var/lib/lazurio-resident",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/opt/lazurio-machines/toolchains:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

function sanitizedGitEnvironment() {
  return {
    ...minimalEnvironment(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runChecked(command, args, options = {}, label = "Resident command", failure = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || minimalEnvironment(),
    uid: options.uid,
    gid: options.gid,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout || 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0 || result.error) {
    if (failure.allowFailure && typeof failure.onFailure === "function") {
      failure.onFailure();
      return "";
    }
    throw new Error(label + " failed");
  }
  return result.stdout || "";
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    env: minimalEnvironment(),
    stdio: "ignore",
    shell: false,
    timeout: 30_000,
  });
  return result.status === 0;
}

function systemctl(args, allowFailure = false) {
  const result = spawnSync("/usr/bin/systemctl", args, {
    env: minimalEnvironment(),
    stdio: "ignore",
    shell: false,
    timeout: 120_000,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error("Resident systemd operation failed");
  }
  return result.status === 0;
}

function systemctlIsActive(unit) {
  return systemctl(["is-active", "--quiet", unit], true);
}
