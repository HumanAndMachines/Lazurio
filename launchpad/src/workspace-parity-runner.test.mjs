import { expect, test } from "bun:test";
import {
  catalogRemovalProofAccepted,
  externalAssertions,
  explicitStopResponseAccepted,
  hostedCatalogProofAccepted,
  noResurrectionProofAccepted,
  parityLoopbackProbeHosts,
  parseArgs,
  runtimePortsMatchModuleLease,
  worktreeProvenanceMatches,
} from "./workspace-parity-runner.mjs";

const canonicalIotorOrganization = "IotorLazurio_GEN3";
const expectedCreator = "t3-code/iotor-builder";

test("workspace parity runner keeps local session and hosted catalog phases explicit", () => {
  expect(parseArgs([
    "--profile", "local",
    "--phase", "live",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toMatchObject({ profile: "local", phase: "live" });
  expect(parseArgs([
    "--profile", "local",
    "--phase", "post-restart",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toMatchObject({ profile: "local", phase: "post-restart" });
  expect(parseArgs([
    "--profile", "hosted",
    "--phase", "post-restart",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--expected-catalog-revision", "catalog-revision-7",
    "--t3-pid", "101",
    "--codex-pid", "151",
    "--launchpad-pid", "202",
  ])).toMatchObject({
    profile: "hosted",
    phase: "post-restart",
    t3Pid: 101,
    codexPid: 151,
    launchpadPid: 202,
    expectedWorktreeCreatedBy: expectedCreator,
  });
  expect(parseArgs([
    "--profile", "hosted",
    "--phase", "expect-removed",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--expected-catalog-revision", "catalog-revision-8",
    "--t3-pid", "101",
    "--codex-pid", "151",
    "--launchpad-pid", "202",
  ])).toMatchObject({ phase: "expect-removed", expectedCatalogRevision: "catalog-revision-8" });
});

test("hosted parity runner fails closed without exact external origin", () => {
  expect(() => parseArgs([
    "--profile", "hosted",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toThrow("--expected-origin is required");
});

test("hosted evidence requests proof that the catalog origin is private development preview", () => {
  expect(externalAssertions).toContain(
    "generated Team service-catalog origin is a private development preview reachable only through the approved Tailscale/VPN access plane, never a public production endpoint",
  );
});

test("hosted parity runner requires T3, Codex and Launchpad process identities", () => {
  expect(() => parseArgs([
    "--profile", "hosted",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--expected-catalog-revision", "catalog-revision-7",
    "--t3-pid", "101",
    "--launchpad-pid", "202",
  ])).toThrow("--codex-pid is required for hosted profile");
});

test("workspace parity runner requires an exact T3 creation identity", () => {
  expect(() => parseArgs([
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
  ])).toThrow("--expected-worktree-created-by is required");
});

test("hosted removal is a catalog revision phase and hosted Stop is forbidden", () => {
  expect(() => parseArgs([
    "--profile", "local",
    "--phase", "expect-removed",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toThrow("valid only for the hosted catalog profile");
  expect(() => parseArgs([
    "--profile", "hosted",
    "--stop-after",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--expected-catalog-revision", "catalog-revision-7",
  ])).toThrow("forbidden for hosted catalog services");
});

test("runtime takeover requires one integer module lease port and exact equality", () => {
  expect(runtimePortsMatchModuleLease([24_301, 24_301, 24_301, 24_301], 24_301)).toBe(true);
  expect(runtimePortsMatchModuleLease([undefined, undefined, undefined, undefined], undefined)).toBe(false);
  expect(runtimePortsMatchModuleLease([24_301, 24_302, 24_301, 24_301], 24_301)).toBe(false);
  expect(runtimePortsMatchModuleLease([], 24_301)).toBe(false);
});

test("disabled vacancy probes every loopback spelling for the numeric module lease", () => {
  expect(parityLoopbackProbeHosts("localhost")).toEqual(["localhost", "127.0.0.1", "::1"]);
  expect(parityLoopbackProbeHosts("[::1]")).toEqual(["::1", "127.0.0.1"]);
});

test("local Stop stays session-scoped and hosted removal requires a new catalog revision", () => {
  const stopped = {
    action: "stop",
    runtime: { managed: false, status: "stopped" },
  };
  expect(explicitStopResponseAccepted(stopped, { profile: "local" })).toBe(true);
  expect(explicitStopResponseAccepted(stopped, { profile: "hosted" })).toBe(false);
  expect(explicitStopResponseAccepted({ ...stopped, desired: {} }, { profile: "local" })).toBe(false);

  const afterRestart = {
    managed: false,
    status: "stopped",
    owner: "none",
    port_owner: null,
    probe: { reachable: false },
    runtime_source: { type: "worktree", slug: "DEV-6439-parity" },
  };
  const noListener = { rawTcpReachable: false };
  expect(noResurrectionProofAccepted(
    afterRestart,
    "DEV-6439-parity",
    { profile: "local", ...noListener },
  )).toBe(true);
  expect(noResurrectionProofAccepted(
    afterRestart,
    "DEV-6439-parity",
    { profile: "hosted", ...noListener },
  )).toBe(false);
  expect(noResurrectionProofAccepted(
    afterRestart,
    "DEV-6439-parity",
    { profile: "local", rawTcpReachable: true },
  )).toBe(false);
  expect(noResurrectionProofAccepted(
    { ...afterRestart, managed: true },
    "DEV-6439-parity",
    { profile: "local", ...noListener },
  )).toBe(false);
  expect(noResurrectionProofAccepted({
    ...afterRestart,
    status: "healthy",
    owner: "adopted-port",
    port_owner: { pid: 404 },
    probe: { reachable: true },
  }, "DEV-6439-parity", { profile: "local", ...noListener })).toBe(false);
  expect(noResurrectionProofAccepted(
    afterRestart,
    "another-worktree",
    { profile: "local", ...noListener },
  )).toBe(false);

  const removedCatalog = { catalog_revision: "catalog-revision-8", services: [] };
  expect(catalogRemovalProofAccepted(
    removedCatalog,
    afterRestart,
    "iotor-knowledgebase-v2",
    "DEV-6439-parity",
    "catalog-revision-8",
    noListener,
  )).toBe(true);
  expect(catalogRemovalProofAccepted(
    { ...removedCatalog, services: [{ app_id: "iotor-knowledgebase-v2" }] },
    afterRestart,
    "iotor-knowledgebase-v2",
    "DEV-6439-parity",
    "catalog-revision-8",
    noListener,
  )).toBe(false);
});

test("worktree provenance and hosted catalog readiness use exact immutable identities", () => {
  const worktree = {
    ownership_status: "owned",
    metadata: { created_by: expectedCreator },
  };
  expect(worktreeProvenanceMatches(worktree, expectedCreator)).toBe(true);
  expect(worktreeProvenanceMatches({ ...worktree, created_by: expectedCreator, metadata: {} }, expectedCreator)).toBe(false);

  const readiness = {
    ready: true,
    catalog_revision: "catalog-revision-7",
    observed: {
      status: "healthy",
      source: { type: "worktree", slug: "DEV-6439-parity" },
    },
    runtime: {
      status: "healthy",
      managed: true,
      owner: "current-instance",
      runtime_source: { type: "worktree", slug: "DEV-6439-parity" },
    },
  };
  expect(hostedCatalogProofAccepted(readiness, "DEV-6439-parity", "catalog-revision-7")).toBe(true);
  expect(hostedCatalogProofAccepted(readiness, "DEV-6439-parity", "catalog-revision-8")).toBe(false);
  expect(hostedCatalogProofAccepted({
    ...readiness,
    observed: { ...readiness.observed, source: { type: "main" } },
  }, "DEV-6439-parity", "catalog-revision-7")).toBe(false);
  expect(hostedCatalogProofAccepted({
    ...readiness,
    runtime: { ...readiness.runtime, owner: "adopted-port" },
  }, "DEV-6439-parity", "catalog-revision-7")).toBe(false);
});
