import { expect, test } from "bun:test";
import {
  bindingPort,
  bindingRuntimeIdentity,
  deriveBindingApiKey,
  renderBridgeUnit,
  renderGatewayUnit,
  renderHermesConfig,
  renderZulipOverride,
  validateControllerContract,
  validateSecretBundle,
} from "./runtime/controller-lib.mjs";

const compartment = {
  schema_version: "machines.authority-compartment.v1",
  compartment_id: "personal",
  kind: "personal",
  repository_credential_purpose: "personal-github",
  credential_purposes: ["personal-github"],
  repositories: [{ repository: "Example/personalspace" }],
  tools: ["file", "terminal"],
};
const binding = {
  schema_version: "machines.communication-binding.v1",
  binding_id: "personal-home",
  compartment_id: "personal",
  realm_role: "personal-home",
  zulip: {
    site: "https://buddy.example.invalid",
    realm_id: "personal",
    identity_id: "buddy",
    credential_purpose: "resident-zulip-personal",
  },
  routing: {
    allowed_sender_ids: [1],
    allowed_stream_ids: [],
    topic_policy: "direct-only",
  },
};
const contract = {
  schema_version: "machines.resident-controller-contract.v1",
  machine_id: "example-resident",
  machine_profile: "buddy",
  workload_id: "hosted-buddy-resident",
  deployment_head: "a".repeat(40),
  machines_head: "b".repeat(40),
  toolchain: {
    bun: "/opt/lazurio-machines/toolchains/bun",
    uv: "/opt/lazurio-machines/toolchains/uv",
    restic: "/opt/lazurio-machines/toolchains/restic",
  },
  paths: {
    install_root: "/opt/lazurio",
    state_root: "/var/lib/lazurio-resident",
    personalspace_root: "/srv/lazurio-resident/personalspace",
    organizations_root: "/srv/lazurio-resident/organizations",
  },
  owner_overlay: {
    principal: {
      kind: "human",
      principal_id: "example",
      personalspace_repository: "Example/personalspace",
    },
    host: { architecture: "x64" },
    runtime: {
      artifact: {
        profile: "buddy",
        artifact_id: "lazurio-resident-buddy-0.1.0-linux-x64",
        source_commit: "c".repeat(40),
        archive_sha256: "d".repeat(64),
      },
      model: { provider: "openrouter", model_id: "example/model" },
      memory: {
        provider: "gbrain",
        engine: "pglite",
        transport: "stdio",
        search_mode: "balanced",
        embedding: "disabled",
      },
      sandbox: {
        terminal_image: "example/terminal@sha256:" + "e".repeat(64),
        memory_mb: 2048,
        cpus: 2,
        pids: 256,
        network: "docker-bridge",
      },
      quota: { max_concurrent_sessions: 1, max_turns_per_hour: 60 },
      backup: { maximum_age_hours: 24 },
    },
    authority_compartments: [compartment],
    communication_bindings: [binding],
    home_zulip: {
      origin: "https://buddy.example.invalid",
      realm_name: "Example",
      administrator_email: "admin@example.invalid",
      administrator_name: "Example",
      compose_commit: "9e1d3cf566f3fb67e168c93f29a642eda989f6b7",
      data_volume: "lazurio-buddy-zulip-data",
      images: {
        server: "ghcr.io/zulip/zulip-server:12.2-0@sha256:" + "1".repeat(64),
        postgresql: "zulip/zulip-postgresql:14@sha256:" + "2".repeat(64),
        memcached: "memcached:alpine@sha256:" + "3".repeat(64),
        rabbitmq: "rabbitmq:4.2@sha256:" + "4".repeat(64),
        redis: "redis:alpine@sha256:" + "5".repeat(64),
      },
    },
  },
};
const secrets = {
  schema_version: "machines.resident-secret-bundle.v1",
  machine_id: "example-resident",
  authority_credentials: [
    { compartment_id: "personal", purpose: "personal-github", value: "private-token" },
  ],
  bindings: [
    {
      binding_id: "personal-home",
      email: "buddy@example.invalid",
      api_key: "1".repeat(32),
    },
  ],
  backup: {
    access_key_id: "backup-access",
    password: "backup-password",
    secret_access_key: "backup-secret",
  },
  model: { provider: "openrouter", api_key: "model-secret" },
  runtime: { api_server_key: "r".repeat(32) },
  home_zulip: {
    administrator_password: "administrator-password",
    email_password: "email-password",
    memcached_password: "memcached-password",
    postgres_password: "postgres-password",
    rabbitmq_password: "rabbitmq-password",
    redis_password: "redis-password",
    secret_key: "zulip-secret-key",
  },
};

test("managed Resident controller rejects widened paths and derives binding-local identity", () => {
  expect(validateControllerContract(structuredClone(contract))).toBeTruthy();
  expect(validateSecretBundle(contract, structuredClone(secrets))).toBeTruthy();
  const widened = structuredClone(contract);
  widened.paths.personalspace_root = "/srv";
  expect(() => validateControllerContract(widened)).toThrow("path contract");
  const shadowAcl = structuredClone(contract);
  shadowAcl.owner_overlay.authority_compartments[0].repositories[0].access = "write";
  expect(() => validateControllerContract(shadowAcl)).toThrow("repository grant");
  const sharedHome = structuredClone(contract);
  sharedHome.owner_overlay.communication_bindings[0].routing.allowed_sender_ids.push(2);
  expect(() => validateControllerContract(sharedHome)).toThrow("exactly its Principal");
  expect(deriveBindingApiKey("r".repeat(32), "personal-home"))
    .not.toBe(deriveBindingApiKey("r".repeat(32), "another-binding"));
  expect(bindingPort(0)).toBe(17650);
  expect(bindingRuntimeIdentity("example-resident", "personal-home")).toEqual(
    bindingRuntimeIdentity("example-resident", "personal-home"),
  );
});

test("Hermes configuration gives one binding one scope, one brain and no forwarded secrets", () => {
  const config = renderHermesConfig({
    contract,
    compartment,
    scopePath: "/srv/lazurio-resident/personalspace/example_GEN3",
    gbrainHome: "/var/lib/lazurio-resident/runtime/bindings/personal-home/gbrain-home",
    gbrainCheckout: "/opt/lazurio-machines/software/gbrain-pin",
    port: 17650,
  });
  expect(config.max_concurrent_sessions).toBe(1);
  expect(config.gateway.api_server.max_concurrent_runs).toBe(1);
  expect(config.terminal).toMatchObject({
    backend: "docker",
    container_persistent: false,
    docker_persist_across_processes: false,
    docker_forward_env: [],
    docker_env: {},
    docker_network: true,
  });
  expect(config.approvals).toMatchObject({
    mode: "manual",
    cron_mode: "deny",
    single_query_mode: "deny",
  });
  expect(config.security).toMatchObject({
    redact_secrets: true,
    tirith_fail_open: false,
    allow_lazy_installs: false,
  });
  expect(config.tool_loop_guardrails.hard_stop_enabled).toBe(true);
  expect(config.terminal.docker_volumes).toEqual([
    "/srv/lazurio-resident/personalspace/example_GEN3:/workspace:rw",
  ]);
  expect(config.platform_toolsets.api_server).toEqual(["file", "gbrain", "terminal"]);
  expect(config.mcp_servers.gbrain.tools.include).toEqual([
    "put_page",
    "search",
    "get_page",
  ]);
  expect(JSON.stringify(config)).not.toContain("model-secret");
});

test("systemd and Zulip renderers preserve process and ingress boundaries", () => {
  const identity = bindingRuntimeIdentity("example-resident", "personal-home");
  const gateway = renderGatewayUnit({
    identity,
    viewRoot: "/var/lib/lazurio-resident/runtime/views/personal-home",
    scopePath: "/srv/lazurio-resident/personalspace/example_GEN3",
    stateRoot: "/var/lib/lazurio-resident/runtime/bindings/personal-home",
    environmentFile: "/var/lib/lazurio-resident/runtime/environment/gateway.env",
    hermesExecutable: "/opt/lazurio-machines/software/hermes/.venv/bin/hermes",
  });
  const bridge = renderBridgeUnit({
    identity,
    viewRoot: "/var/lib/lazurio-resident/runtime/views/personal-home",
    scopePath: "/srv/lazurio-resident/personalspace/example_GEN3",
    queueRoot: "/var/lib/lazurio-resident/runtime/bindings/personal-home/bridge",
    environmentFile: "/var/lib/lazurio-resident/runtime/environment/bridge.env",
  });
  expect(gateway).toContain("SupplementaryGroups=" + identity.group + " docker");
  expect(gateway).toContain("NoNewPrivileges=yes");
  expect(bridge).not.toContain(" docker");
  expect(bridge).toContain("CapabilityBoundingSet=");

  const override = renderZulipOverride(contract.owner_overlay.home_zulip, {
    zulip__postgres_password: "/run/private/postgres",
    lazurio__administrator_password: "/run/private/admin",
  });
  expect(override).toContain("ports: !override");
  expect(override).toContain("127.0.0.1:8080:80");
  expect(override).not.toContain("published: 25");
  expect(override).toContain("name: \"lazurio-buddy-zulip-data\"");
});
