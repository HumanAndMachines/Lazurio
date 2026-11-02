import { expect, test } from "bun:test";
import {
  externalAssertions,
  parityApiUrl,
  explicitStopResponseAccepted,
  hostedMainMaintenanceProofAccepted,
  hostedTeamMaintenanceProofAccepted,
  noResurrectionProofAccepted,
  parityLoopbackProbeHosts,
  parseArgs,
  resolveParityOrganization,
  runtimePortsMatchModuleLease,
  worktreeProvenanceMatches,
} from "./workspace-parity-runner.mjs";

const organization = "ExampleOrg";
const creator = "t3-code/acme-builder";
const shared = [
  "--organization", organization,
  "--app-id", "acme-knowledgebase-v2",
  "--worktree-slug", "DEV-6439-parity",
  "--expected-worktree-created-by", creator,
];

test("workspace parity exposes only live and post-restart phases", () => {
  expect(parseArgs(["--profile", "local", "--phase", "live", ...shared])).toMatchObject({
    profile: "local",
    phase: "live",
  });
  expect(parseArgs(["--profile", "local", "--phase", "post-restart", ...shared])).toMatchObject({
    profile: "local",
    phase: "post-restart",
  });
  expect(() => parseArgs(["--phase", "expect-disabled", ...shared])).toThrow("live or post-restart");
});

test("hosted parity requires the derived URL and shared process identities", () => {
  const args = [
    "--profile", "hosted",
    "--phase", "post-restart",
    ...shared,
    "--team", "acme-builders",
    "--hosted-domain", "acme.example",
    "--machine", "builder",
    "--t3-pid", "101",
    "--codex-pid", "151",
    "--launchpad-pid", "202",
  ];
  expect(parseArgs(args)).toMatchObject({ profile: "hosted", phase: "post-restart", machine: "builder" });
  expect(() => parseArgs(args.filter((value) => value !== "builder" && value !== "--machine")))
    .toThrow("--machine is required");
  expect(() => parseArgs(args.filter((value) => value !== "151" && value !== "--codex-pid")))
    .toThrow("--codex-pid is required");
  expect(() => parseArgs(args.filter((value) => value !== "acme-builders" && value !== "--team")))
    .toThrow("--team is required");
  expect(() => parseArgs([
    "--profile", "hosted",
    ...shared,
    "--team", "acme-builders",
    "--t3-pid", "101",
    "--codex-pid", "151",
    "--launchpad-pid", "202",
  ])).toThrow("--hosted-domain is required");
});

test("post-restart hosted proof accepts cold main inventory only", () => {
  const health = {
    status: "stopped",
    managed: false,
    runtime_source: { type: "main" },
    maintenance: { status: "stopped", source: { type: "main" } },
    maintenance_alignment: "matches",
  };
  expect(hostedMainMaintenanceProofAccepted(health)).toBe(true);
  expect(hostedMainMaintenanceProofAccepted({
    ...health,
    runtime_source: { type: "worktree", slug: "old-session" },
  })).toBe(false);
  expect(hostedMainMaintenanceProofAccepted({ ...health, maintenance_alignment: "different-source" })).toBe(false);
});

test("local Stop and post-restart vacancy carry no desired-state evidence", () => {
  expect(explicitStopResponseAccepted({
    action: "stop",
    runtime: { managed: false, status: "stopped" },
  })).toBe(true);
  expect(explicitStopResponseAccepted({
    action: "stop",
    desired: { enabled: false },
    runtime: { managed: false, status: "stopped" },
  })).toBe(false);
  const health = {
    managed: false,
    status: "stopped",
    owner: "none",
    port_owner: null,
    probe: { reachable: false },
    runtime_source: { type: "worktree", slug: "DEV-6439-parity" },
  };
  expect(noResurrectionProofAccepted(health, "DEV-6439-parity", {
    profile: "local",
    rawTcpReachable: false,
  })).toBe(true);
  expect(noResurrectionProofAccepted({ ...health, desired: {} }, "DEV-6439-parity", {
    profile: "local",
    rawTcpReachable: false,
  })).toBe(false);
});

test("module lease, worktree provenance and loopback probes remain exact", () => {
  expect(runtimePortsMatchModuleLease([24_301, 24_301, 24_301, 24_301], 24_301)).toBe(true);
  expect(runtimePortsMatchModuleLease([24_301, 24_302], 24_301)).toBe(false);
  expect(worktreeProvenanceMatches({ metadata: { created_by: creator } }, creator)).toBe(true);
  expect(worktreeProvenanceMatches({ metadata: {} }, creator)).toBe(false);
  expect(parityLoopbackProbeHosts("localhost")).toEqual(["localhost", "127.0.0.1", "::1"]);
});

test("hosted evidence names the derived private development origin", () => {
  expect(externalAssertions).toContain(
    "derived Team module origin is a private development preview reachable only through the approved Tailscale/VPN access plane, never a public production endpoint",
  );
});

test("parity resolves an exact Organization slug to its discovered mount path", () => {
  const discovery = {
    organizations: [
      { slug: "ExampleOrg", path: "organizations/ExampleOrg_GEN3" },
      { slug: "Acme-Tech", path: "organizations/Acme-Tech_GEN3" },
    ],
  };
  expect(resolveParityOrganization(discovery, "Acme-Tech")).toEqual({
    slug: "Acme-Tech",
    path: "organizations/Acme-Tech_GEN3",
  });
  expect(resolveParityOrganization(discovery, "Acme-Tech_GEN3")).toBeNull();
  expect(resolveParityOrganization({
    organizations: [
      { slug: "Acme-Tech", path: "organizations/one" },
      { slug: "Acme-Tech", path: "organizations/two" },
    ],
  }, "Acme-Tech")).toBeNull();
});

test("hosted parity accepts the complete derived Team set and exact session sources", () => {
  const worktreeSlug = "DEV-6513-parity";
  const health = (source, url) => ({
    status: url.includes("knowledgebase") ? "healthy" : "stopped",
    managed: url.includes("knowledgebase"),
    url,
    runtime_source: source,
    maintenance: { status: url.includes("knowledgebase") ? "healthy" : "stopped", source },
    maintenance_alignment: "matches",
  });
  const main = { type: "main" };
  const worktree = { type: "worktree", slug: worktreeSlug };
  const evidence = [
    {
      app_id: "acme-tech-knowledgebase-v1",
      expected_url: "https://knowledgebase.technical.acme-tech.example/",
      health: health(worktree, "https://knowledgebase.technical.acme-tech.example/"),
    },
    {
      app_id: "acme-tech-wiki-v1",
      expected_url: "https://wiki.technical.acme-tech.example/",
      health: health(main, "https://wiki.technical.acme-tech.example/"),
    },
  ];
  const input = {
    healthEvidence: evidence,
    exercisedAppId: "acme-tech-knowledgebase-v1",
    phase: "live",
    worktreeSlug,
    maintenance: { total: 2, healthy: 1, stopped: 1, starting: 0, degraded: 0, skipped: 1 },
    expectedTotal: 2,
    expectedSkipped: 1,
  };
  expect(hostedTeamMaintenanceProofAccepted(input)).toBe(true);
  expect(hostedTeamMaintenanceProofAccepted({
    ...input,
    healthEvidence: evidence.map((item) => ({ ...item, health: health(main, item.expected_url) })),
  })).toBe(false);
  expect(hostedTeamMaintenanceProofAccepted({
    ...input,
    maintenance: { ...input.maintenance, skipped: 0 },
  })).toBe(false);
  expect(hostedTeamMaintenanceProofAccepted({
    ...input,
    phase: "post-restart",
    healthEvidence: evidence.map((item) => ({ ...item, health: health(main, item.expected_url) })),
  })).toBe(true);
});


test("parity API probes and mutations retain the configured mount", () => {
  for (const path of ["/api/apps", "/health", "/api/git/worktrees", "/api/apps/example/start"]) {
    expect(parityApiUrl("http://127.0.0.1:20000/launchpad/", path).href).toBe(`http://127.0.0.1:20000/launchpad${path}`);
    expect(parityApiUrl("http://127.0.0.1:20000", path).pathname).toBe(path);
    expect(parityApiUrl("http://127.0.0.1:20000/launchpad", path).pathname).toBe(`/launchpad${path}`);
  }
});
