import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "fs/promises";
import {
  RuntimeActionError,
  bunExecutableCandidates,
  canonicalRuntimeListenerHost,
  createRuntimeManager as createRuntimeManagerImpl,
  observedListenerMatchesDeclaration,
  parseProcessGroupListeners,
  parseWindowsProcessIdentity,
  parseWindowsListeningPid,
  parseWindowsListeningBindings,
  probeRuntimeListener,
  resolvePortOwner,
  resolveBunExecutable,
  resolvePosixProcessGroupId,
  runtimeHostsShareListener,
  runtimeListenerHasStaticLease,
  selectManagedModuleStopRecord,
  windowsNetstatCommand,
  windowsProcessIdentityCommand,
  windowsPowerShellExecutable,
  windowsTaskkillCommand,
} from "../../lazurio/runtime/runtime-lib.mjs";
import { discoverLaunchpadApps } from "../../lazurio/runtime/discovery-lib.mjs";
import { platformTestTimeout } from "./test-platform-setup.mjs";
import { buildWorktreeIndex } from "../../lazurio/runtime/worktree-lib.mjs";

const tempRoots = [];
// Windows záměrně neumí z vestavěného resolveru ověřit CWD cizího procesu,
// takže adopted/foreign klasifikaci fail-closed drží jako unknown-port. Testy
// pozitivní CWD adopce patří na OS, kde je skutečný process CWD čitelný.
const testWithInspectableProcessCwd = process.platform === "win32" ? test.skip : test;
const testOnPosix = process.platform === "win32" ? test.skip : test;

function fixtureDependencyInstallScript(extra = "") {
  return [
    'const { mkdir } = await import("node:fs/promises")',
    'await mkdir("node_modules/fixture", { recursive: true })',
    'await Bun.write("node_modules/fixture/package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }))',
    extra,
  ].filter(Boolean).join("; ");
}

afterAll(async () => {
  for (const fixture of tempRoots) {
    await removeTempRootAfterChildExit(fixture);
  }
});

test("runtime ownership považuje localhost a 127.0.0.1 za tentýž listener", () => {
  expect(canonicalRuntimeListenerHost("localhost")).toBe("127.0.0.1");
  expect(canonicalRuntimeListenerHost("[::1]")).toBe("::1");
  expect(runtimeHostsShareListener("localhost", "127.0.0.1")).toBe(true);
  expect(runtimeHostsShareListener("127.0.0.1", "localhost")).toBe(true);
  expect(runtimeHostsShareListener("localhost", "localhost")).toBe(true);
  expect(runtimeHostsShareListener("127.0.0.1", "127.0.0.1")).toBe(true);
  expect(runtimeHostsShareListener("localhost", "0.0.0.0")).toBe(false);
});

test("durable Stop selects one managed module runtime and rejects true ambiguity", () => {
  const app = fixtureDiscoveryApp({ port: 24001 });
  const main = {
    runtimeKey: app.id,
    runtimeSource: { type: "main" },
    runtimeApp: app,
  };
  const worktree = {
    runtimeKey: `${app.id}--worktree--DEV-6439-stop-selector`,
    runtimeSource: { type: "worktree", slug: "DEV-6439-stop-selector" },
    runtimeApp: app,
  };

  expect(selectManagedModuleStopRecord([], app)).toBeNull();
  expect(selectManagedModuleStopRecord([worktree], app)).toBe(worktree);
  expect(() => selectManagedModuleStopRecord([main, worktree], app)).toThrow(
    expect.objectContaining({
      code: "app_stop_ambiguous",
      metadata: expect.objectContaining({
        failure_kind: "ambiguous_managed_module_runtime",
        runtime_keys: [main.runtimeKey, worktree.runtimeKey],
      }),
    }),
  );
});

test("TCP listener health používá skutečné spojení místo HTTP předpokladu", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const probe = await probeRuntimeListener(
      runtimeListener("api", "auxiliary", address.port, {
        protocol: "tcp",
        health: { kind: "tcp" },
      }),
    );
    expect(probe).toEqual({ reachable: true, ok: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fixture cleanup proves the exact spawned child exited before removing its mapped temp root", async () => {
  const events = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  await removeTempRootAfterChildExit(
    {
      root: "fixture-root",
      port: 24001,
      owner: "mapped creating test",
      children: [{ pid: 4101, exited }],
    },
    {
      childExitAttempts: 2,
      retryDelayMs: 0,
      removeFn: async () => events.push("remove"),
      sleepFn: async () => {
        events.push("wait");
        resolveExit(0);
      },
    },
  );
  expect(events).toEqual(["wait", "remove"]);
});

test("fixture cleanup reports the creating test and PID instead of deleting a live child", async () => {
  let removed = false;
  await expect(removeTempRootAfterChildExit(
    {
      root: "fixture-root",
      port: 24002,
      owner: "mapped creating test",
      children: [{ pid: 4242, exited: new Promise(() => {}) }],
    },
    {
      childExitAttempts: 2,
      retryDelayMs: 0,
      removeFn: async () => { removed = true; },
      sleepFn: async () => {},
    },
  )).rejects.toThrow("owner=mapped creating test; root=fixture-root; port=24002; child_pid=4242");
  expect(removed).toBe(false);
});

test("fixture cleanup does not attribute a reused port to an exited fixture child", async () => {
  let removed = false;
  await removeTempRootAfterChildExit(
    {
      root: "fixture-root",
      port: 24003,
      owner: "mapped creating test",
      children: [{ pid: 4242, exited: Promise.resolve(0) }],
    },
    {
      removeFn: async () => { removed = true; },
    },
  );
  expect(removed).toBe(true);
});

test("fixture cleanup uses an explicit bounded Windows retry after child exit", async () => {
  let removeAttempts = 0;
  await removeTempRootAfterChildExit(
    { root: "fixture-root", port: null, owner: "mapped creating test" },
    {
      platform: "win32",
      rootRemovalAttempts: 3,
      retryDelayMs: 0,
      removeFn: async () => {
        removeAttempts += 1;
        if (removeAttempts < 3) {
          const error = new Error("simulated Windows handle release");
          error.code = "EBUSY";
          throw error;
        }
      },
      sleepFn: async () => {},
    },
  );
  expect(removeAttempts).toBe(3);
});

test("runtime manager spustí, změří a zastaví managed aplikaci", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let childEnv = null;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    systemEnvironment: {
      ...process.env,
      HOST: "stale-parent-host",
      PORT: "49999",
      NODE_PATH: join(root, "stale-parent-node-modules"),
      LAZURIO_RUNTIME_PORT: "49998",
      LAZURIO_RUNTIME_LISTENER_WEB_PORT: "49997",
    },
    spawnProcess(command, options) {
      childEnv = options.env;
      return Bun.spawn(command, options);
    },
    spawnProcessIsNative: true,
  });

  const initialHealth = await runtime.health("test-company-demo-v1");
  expect(initialHealth.status).toBe("stopped");
  expect(initialHealth.dependencies.state).toBe("ready");
  expect(initialHealth.dependencies.install_command_display).toBeNull();
  await runtime.start("test-company-demo-v1");
  const healthy = await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  expect(healthy.managed).toBe(true);
  expect(healthy.pid).toBeNumber();
  const runtimeEnv = await (await fetch(`http://127.0.0.1:${port}/runtime-env`)).json();
  expect(runtimeEnv.organizationRoot).toBe(await realpath(join(root, "organizations", "TestCompany")));
  expect(runtimeEnv.nodeEnv).toBe("development");
  expect(runtimeEnv.runtimeHost).toBe("127.0.0.1");
  expect(runtimeEnv.runtimePort).toBe(String(port));
  const entrypoint = runtimeEnv.listeners.find((listener) => listener.role === "entrypoint");
  expect(entrypoint).toMatchObject({ host: "127.0.0.1", port });
  const listenerEnvKey = String(entrypoint.id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  expect(childEnv.HOST).toBe("127.0.0.1");
  expect(childEnv.PORT).toBe(String(port));
  expect(childEnv.NODE_PATH).toBe(join(
    await realpath(join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1")),
    "node_modules",
  ));
  expect(childEnv.LAZURIO_RUNTIME_PORT).toBe(String(port));
  expect(childEnv[`LAZURIO_RUNTIME_LISTENER_${listenerEnvKey}_HOST`]).toBe("127.0.0.1");
  expect(childEnv[`LAZURIO_RUNTIME_LISTENER_${listenerEnvKey}_PORT`]).toBe(String(port));
  expect(runtimeEnv.astroDevBackground).toBe("1");
  expect(runtimeEnv.astroPreviewBackground).toBe("1");

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.action).toBe("stop");
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.log_path).toBe("logs/apps/test-company-demo-v1.log");
  expect(logs.content).toContain("stop test-company-demo-v1");
  expect((await runtime.health("test-company-demo-v1")).status).toBe("stopped");
}, platformTestTimeout(10_000));

test("Open počká na přechodný HTTP 404 během start grace", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "const startedAt = Date.now();",
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health' && Date.now() - startedAt < 1400) return new Response('building', { status: 404 });",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "transient-health-status",
  });

  try {
    const opened = await runtime.open("test-company-demo-v1");
    expect(opened).toMatchObject({
      status: "healthy",
      url: `http://127.0.0.1:${port}`,
    });
  } finally {
    await runtime.stop("test-company-demo-v1").catch(() => {});
  }
}, platformTestTimeout(10_000));

test("runtime process resolves module-root source from app-local dependencies", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      'import { dependencyValue } from "../../shared-config.mjs";',
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response(dependencyValue);",
      "  },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const moduleRoot = join(root, "organizations", "TestCompany", "modules", "demo");
  const dependencyRoot = join(moduleRoot, "app", "v1", "node_modules", "@fixture", "app-local-dependency");
  await mkdir(dependencyRoot, { recursive: true });
  await writeJson(join(dependencyRoot, "package.json"), {
    name: "@fixture/app-local-dependency",
    type: "module",
    exports: "./index.mjs",
  });
  await writeFile(join(dependencyRoot, "index.mjs"), 'export const value = "app-local dependency";\n', "utf8");
  await writeFile(
    join(moduleRoot, "shared-config.mjs"),
    [
      'import { value } from "@fixture/app-local-dependency";',
      "export const dependencyValue = value;",
      "",
    ].join("\n"),
    "utf8",
  );
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "app-local-resolution",
  });

  try {
    const opened = await runtime.open("test-company-demo-v1");
    expect(opened.status).toBe("healthy");
    expect(await (await fetch(opened.url)).text()).toBe("app-local dependency");
  } finally {
    await runtime.stop("test-company-demo-v1").catch(() => {});
  }
}, platformTestTimeout(10_000));

test("runtime manager ukládá mutable stav mimo read-only Launchpad source", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port, writeLockfile: true });
  const launchpadRoot = join(root, "immutable-runtime", "launchpad");
  const stateRoot = join(root, "state", "launchpad");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot,
    stateRoot,
    instanceId: "external-state-test",
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  await runtime.stop("test-company-demo-v1");
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.log_path).toBe("logs/apps/test-company-demo-v1.log");
  expect(existsSync(join(stateRoot, "logs", "apps", "test-company-demo-v1.log"))).toBe(true);
  expect(existsSync(join(launchpadRoot, "logs"))).toBe(false);
  expect(existsSync(join(launchpadRoot, "runtime"))).toBe(false);
}, platformTestTimeout(10_000));

test("runtime reclaims an occupied declared auxiliary listener before spawn", async () => {
  const entrypointPort = await findFreePort();
  const auxiliaryPort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: entrypointPort });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port: entrypointPort }), [
    runtimeListener("web", "entrypoint", entrypointPort),
    runtimeListener("api", "auxiliary", auxiliaryPort),
  ]);
  let spawned = false;
  let occupied = true;
  const signals = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(app),
    resolvePortOwnerFn: async (port, options) => {
      if (port === auxiliaryPort) expect(options.host).toBe("127.0.0.1");
      return port === auxiliaryPort && occupied
        ? { pid: 4242, cwd_matches: false }
        : null;
    },
    signalPortOwnerFn: async (pid, signal) => {
      signals.push({ pid, signal });
      occupied = false;
    },
    spawnProcess: () => {
      spawned = true;
      throw new Error("expected spawn after reclaim");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "app_start_failed",
  });
  expect(spawned).toBe(true);
  expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
});

test("Windows reserved-port takeover escalates a failed graceful taskkill to forced tree kill", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  let occupied = true;
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    platform: "win32",
    discover: discoveryWithApp(app),
    resolvePortOwnerFn: async () => occupied
      ? { pid: 4242, cwd_matches: false }
      : null,
    resolveProcessIdentityFn: async () => ({
      pid: 4242,
      parent_pid: 1,
      created_at: "2026-08-13T00:00:00.000Z",
      executable_path: "C:\\Tools\\bun.exe",
    }),
    runSystemCommandFn: async (command) => {
      commands.push(command);
      if (command.includes("/F")) {
        occupied = false;
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "The process can only be terminated forcefully.",
      };
    },
    spawnProcess: () => {
      throw new Error("expected spawn after reclaim");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({ code: "app_start_failed" });
  expect(commands.some((command) => command.includes("/T") && !command.includes("/F"))).toBe(true);
  expect(commands.some((command) => command.includes("/T") && command.includes("/F"))).toBe(true);
});

test("occupied static lease with unresolved PID fails before spawn", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  let spawned = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(app),
    resolvePortOwnerFn: async () => null,
    probeNumericPortOccupiedFn: async () => true,
    spawnProcess: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "runtime_listener_reclaim_failed",
    metadata: { failure_kind: "reserved_port_owner_unresolvable" },
  });
  expect(spawned).toBe(false);
});

test("POSIX takeover rejects process group 1 without sending a signal", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  let spawned = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    platform: "linux",
    discover: discoveryWithApp(app),
    resolvePortOwnerFn: async () => ({ pid: 4242, cwd_matches: false }),
    resolvePortOwnerProcessGroupFn: async () => 1,
    runSystemCommandFn: async (command) => command[0] === "ps"
      ? { ok: true, exitCode: 0, stdout: "Thu Aug 13 12:00:00 2026", stderr: "" }
      : { ok: false, exitCode: 1, stdout: "", stderr: "unexpected command" },
    spawnProcess: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "runtime_listener_reclaim_failed",
    metadata: { failure_kind: "reserved_port_signal_failed", signal: "SIGTERM" },
  });
  expect(spawned).toBe(false);
});

test("only Lazurio static claims grant reserved-port reclaim authority", () => {
  const listener = runtimeListener("web", "entrypoint", 5392);
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port: 5392 }), [listener]);
  expect(runtimeListenerHasStaticLease(app, listener)).toBe(true);
  expect(runtimeListenerHasStaticLease(
    { ...app, runtime_contract: { ...app.runtime_contract, legacy: true, schema_version: "companyascode.launchpad_app.v1" } },
    listener,
  )).toBe(false);
  expect(runtimeListenerHasStaticLease(app, { ...listener, allocation: "dynamic" })).toBe(false);
  expect(runtimeListenerHasStaticLease({ ...app, personal: true }, listener)).toBe(false);
});

test("Windows start ownership does not accept an unrelated same-cwd process", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  let stopped = false;
  let spawned = false;
  let reportExit;
  const exited = new Promise((resolve) => { reportExit = resolve; });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    platform: "win32",
    bunExecutable: process.execPath,
    discover: discoveryWithApp(app),
    resolvePortOwnerFn: async () => spawned && !stopped
      ? { pid: 99_001, cwd_matches: true }
      : null,
    resolveProcessIdentityFn: async () => null,
    probeNumericPortOccupiedFn: async () => false,
    startedListenerOwnershipTimeoutMs: 20,
    spawnProcess: () => {
      spawned = true;
      return {
        pid: 99_002,
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited,
        kill: () => {
          stopped = true;
          reportExit(0);
        },
      };
    },
    runSystemCommandFn: async () => {
      stopped = true;
      reportExit(0);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "runtime_listener_ownership_unverified",
  });
  expect(stopped).toBe(true);
});

test("runtime health resolves ownership for the declared entrypoint endpoint", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port }), [
    runtimeListener("web", "entrypoint", port, { host: "::1" }),
  ]);
  const calls = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(app),
    resolvePortOwnerFn: async (candidatePort, options) => {
      calls.push({ port: candidatePort, host: options.host });
      return options.host === "::1" ? null : { pid: 4242, cwd_matches: false };
    },
  });

  const health = await runtime.health(app.id);
  expect(health.status).toBe("stopped");
  expect(calls).toContainEqual({ port, host: "::1" });
});

test("dynamic entrypoint is rejected before Launchpad starts a process", async () => {
  const fixturePort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: fixturePort });
  const dynamic = runtimeListener("web", "entrypoint", null, { allocation: "dynamic" });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port: fixturePort }), [dynamic]);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(app),
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "runtime_listener_not_static",
    metadata: { failure_kind: "dynamic_runtime_listener_forbidden" },
  });
});

test("dynamic auxiliary listener is rejected before Launchpad starts a process", async () => {
  const fixturePort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: fixturePort });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port: fixturePort }), [
    runtimeListener("web", "entrypoint", fixturePort),
    runtimeListener("api", "auxiliary", null, { allocation: "dynamic" }),
  ]);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(app),
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "runtime_listener_not_static",
    metadata: { failure_kind: "dynamic_runtime_listener_forbidden" },
  });
});

test("runtime action isolates a discovery failure from another Organization", async () => {
  const fixturePort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: fixturePort });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port: fixturePort }));
  const discoveryScopes = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: async (_root, options = {}) => {
      discoveryScopes.push({
        organization: options.organization ?? null,
        organizationPath: options.organization_path ?? null,
      });
      return {
        apps: [app],
        invalid_apps: [],
        failures: options.organization === app.company
          ? []
          : ["organizations/OtherCompany: rozbitá deklarace nesouvisející Organizace"],
        warnings: [],
        port_overlaps: [],
      };
    },
    spawnProcess: () => {
      throw new Error("scoped discovery passed");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "app_start_failed",
    metadata: { failure_kind: "start_spawn_failed" },
  });
  expect(discoveryScopes).toContainEqual({ organization: null, organizationPath: null });
  expect(discoveryScopes).toContainEqual({
    organization: app.company,
    organizationPath: app.organization_path,
  });
});

test("runtime action remains blocked when the target Organization discovery is invalid", async () => {
  const fixturePort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: fixturePort });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port: fixturePort }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: async () => ({
      apps: [app],
      invalid_apps: [],
      failures: ["organizations/TestCompany: nevalidní runtime deklarace"],
      warnings: [],
      port_overlaps: [],
    }),
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "invalid_discovery",
    metadata: {
      failure_kind: "invalid_discovery",
      organization: app.company,
    },
  });
});

test("Lazurio runtime app cannot start with a cross-module port conflict", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const conflictOwner = {
    app_id: "other-company-other-v1",
    package_path: "organizations/Other/workspace/other/app/v1/package.json",
  };
  let spawned = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: async () => ({
      apps: [app],
      invalid_apps: [],
      failures: [],
      warnings: [],
      port_overlaps: [{ port, conflict: true, classification: "declared-conflict", owners: [
        { app_id: app.id, package_path: app.package_path },
        conflictOwner,
      ] }],
    }),
    spawnProcess: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "invalid_runtime_port_contract",
    metadata: { failure_kind: "invalid_runtime_port_contract", conflict_count: 1 },
  });
  expect(spawned).toBe(false);
});

test("legacy runtime cannot start with a declared cross-module port conflict", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = fixtureDiscoveryApp({ port });
  let spawned = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: async () => ({
      apps: [app],
      invalid_apps: [],
      failures: [],
      warnings: [],
      port_overlaps: [{ port, conflict: true, classification: "declared-conflict", owners: [
        { app_id: app.id, package_path: app.package_path },
        { app_id: "other-company-other-v1", package_path: "organizations/Other/modules/other/package.json" },
      ] }],
    }),
    spawnProcess: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "invalid_runtime_port_contract",
    metadata: { failure_kind: "invalid_runtime_port_contract", conflict_count: 1 },
  });
  expect(spawned).toBe(false);
});

test("numeric port ownership resolves the OS listener and excludes the current process", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await expect(resolvePortOwner(address.port, { includeSelf: true })).resolves.toMatchObject({ pid: process.pid });
    await expect(resolvePortOwner(address.port)).resolves.toBeNull();
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}, platformTestTimeout(10_000));

test("static module lease rejects a runtime bound to a wildcard host", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "const server = Bun.serve({",
      "  hostname: '0.0.0.0',",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) { return new Response(new URL(request.url).pathname === '/health' ? 'ok' : 'ok'); },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(app),
    startedListenerOwnershipTimeoutMs: 200,
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    code: "runtime_listener_ownership_unverified",
  });
});

testOnPosix("POSIX managed runtime starts detached and Stop signals its process group", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let spawnOptions = null;
  const groupSignals = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    platform: "darwin",
    spawnProcess: (command, options) => {
      spawnOptions = options;
      return spawnFixtureChild(root, command, options);
    },
    signalProcessGroupFn: (processGroupId, signal, record) => {
      groupSignals.push({ processGroupId, signal });
      record.child.kill(signal);
    },
  });

  try {
    await runtime.start("test-company-demo-v1");
    await runtime.stop("test-company-demo-v1");
    expect(spawnOptions.detached).toBe(true);
    expect(groupSignals[0]).toMatchObject({ signal: "SIGTERM" });
    expect(groupSignals[0].processGroupId).toBeNumber();
  } finally {
    await runtime.stop("test-company-demo-v1").catch(() => {});
  }
}, platformTestTimeout(10_000));

testOnPosix("POSIX launcher may exit while its managed listener group remains controllable", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      return new Response(new URL(request.url).pathname === "/health" ? "ok" : "ok");
    },
  });
  const launcherPid = 12_345;
  const listenerPid = 12_346;
  let spawned = false;
  let groupAlive = true;
  let reportLauncherExit;
  const launcherExited = new Promise((resolve) => {
    reportLauncherExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(withStaticEntrypoint(fixtureDiscoveryApp({ port }))),
    platform: "linux",
    bunExecutable: process.execPath,
    probeNumericPortOccupiedFn: async () => false,
    spawnProcess: () => {
      spawned = true;
      return {
        pid: launcherPid,
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: launcherExited,
        kill: () => {},
      };
    },
    resolvePortOwnerFn: async () => spawned && groupAlive
      ? { pid: listenerPid, cwd_matches: true }
      : null,
    resolvePortOwnerProcessGroupFn: async () => launcherPid,
    resolveObservedPortBindingsFn: async () => [{
      endpoint: `127.0.0.1:${port}`,
      host: "127.0.0.1",
      port,
    }],
    processGroupAliveFn: async () => groupAlive,
    signalProcessGroupFn: async (_processGroupId, signal) => {
      if (signal === "SIGTERM") {
        groupAlive = false;
        server.stop(true);
      }
    },
  });

  try {
    await runtime.start("test-company-demo-v1");
    reportLauncherExit(0);
    const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
    const handedOff = await waitForJson(statePath, (state) => state.launcher_exit_code === 0);
    expect(handedOff).toMatchObject({
      status: "healthy",
      process_group_id: expect.any(Number),
      owner_proof: {
        schema_version: "lazurio.posix_process_group_owner_proof.v1",
        listener_pid: expect.any(Number),
      },
    });
    expect(await runtime.health("test-company-demo-v1")).toMatchObject({
      status: "healthy",
      owner: "current-instance",
      managed: true,
      controllable: true,
    });
    expect((await runtime.stop("test-company-demo-v1")).runtime.status).toBe("stopped");
  } finally {
    await runtime.stop("test-company-demo-v1").catch(() => {});
    server.stop(true);
  }
}, platformTestTimeout(10_000));

testOnPosix("POSIX launcher exit never adopts a same-port process from another checkout", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch() {
      return new Response("ok");
    },
  });
  let reportLauncherExit;
  let cwdMatches = true;
  let spawned = false;
  const launcherExited = new Promise((resolve) => {
    reportLauncherExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    discover: discoveryWithApp(withStaticEntrypoint(fixtureDiscoveryApp({ port }))),
    platform: "linux",
    bunExecutable: process.execPath,
    probeNumericPortOccupiedFn: async () => false,
    spawnProcess: () => {
      spawned = true;
      return {
        pid: 12_347,
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: launcherExited,
        kill: () => {},
      };
    },
    resolvePortOwnerFn: async () => spawned
      ? { pid: 12_348, cwd_matches: cwdMatches }
      : null,
    resolvePortOwnerProcessGroupFn: async () => 12_347,
    resolveObservedPortBindingsFn: async () => [{
      endpoint: `127.0.0.1:${port}`,
      host: "127.0.0.1",
      port,
    }],
    processGroupAliveFn: async () => true,
  });

  try {
    await runtime.start("test-company-demo-v1");
    cwdMatches = false;
    reportLauncherExit(0);
    const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
    await waitForJson(statePath, (state) => state.status === "stopped");
    expect(await runtime.health("test-company-demo-v1")).toMatchObject({
      managed: false,
      controllable: false,
      owner: "foreign-port",
    });
  } finally {
    server.stop(true);
  }
}, platformTestTimeout(10_000));

test("POSIX Stop escalates when the launcher exits but its process group survives", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const signals = [];
  let groupAlive = true;
  let reportExit;
  const exited = new Promise((resolve) => {
    reportExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    platform: "linux",
    bunExecutable: process.execPath,
    processGroupAliveFn: async () => groupAlive,
    signalProcessGroupFn: async (_processGroupId, signal, record) => {
      record.child.kill(signal);
    },
    spawnProcess: () => ({
      pid: 12_344,
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") reportExit(0);
        if (signal === "SIGKILL") groupAlive = false;
      },
    }),
  });

  await runtime.start("test-company-demo-v1");
  const stopped = await runtime.stop("test-company-demo-v1");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(stopped.forced).toBe(true);
  expect(stopped.runtime.status).toBe("stopped");
}, platformTestTimeout(10_000));

test("process-group listener parser returns unique observed TCP endpoints", () => {
  expect(parseProcessGroupListeners("p42\nPnode\nn127.0.0.1:5392\nn[::1]:5393\nn127.0.0.1:5392\n")).toEqual([
    { endpoint: "127.0.0.1:5392", host: "127.0.0.1", port: 5392 },
    { endpoint: "[::1]:5393", host: "::1", port: 5393 },
  ]);
  expect(observedListenerMatchesDeclaration(
    { host: "0.0.0.0", port: 5392 },
    { host: "127.0.0.1", port: 5392 },
  )).toBe(false);
  expect(observedListenerMatchesDeclaration(
    { host: "::1", port: 5392 },
    { host: "::1", port: 5392 },
  )).toBe(true);
});

test("POSIX takeover resolves the listener owner's process group", async () => {
  const calls = [];
  const processGroupId = await resolvePosixProcessGroupId(4242, {
    runCommandFn: async (command) => {
      calls.push(command);
      return { ok: true, stdout: "  5150\n", stderr: "", exitCode: 0 };
    },
  });
  expect(processGroupId).toBe(5150);
  expect(calls).toEqual([["ps", "-o", "pgid=", "-p", "4242"]]);
});

test("Windows runtime dohledá Bun i bez shell PATH", () => {
  const env = {
    USERPROFILE: "C:\\Users\\builder",
    LOCALAPPDATA: "C:\\Users\\builder\\AppData\\Local",
  };
  const candidates = bunExecutableCandidates({ platform: "win32", env });

  expect(candidates).toEqual([
    "C:\\Users\\builder\\.bun\\bin\\bun.exe",
    "C:\\Users\\builder\\AppData\\Local\\bun\\bin\\bun.exe",
  ]);
  expect(resolveBunExecutable({
    platform: "win32",
    env,
    execPath: "C:\\Program Files\\Launchpad\\Launchpad.exe",
    which: () => null,
    pathExists: (candidate) => candidate === candidates[0],
    probe: (candidate) => candidate === candidates[0],
  })).toBe(candidates[0]);
});

test("Windows runtime přeskočí nefunkční Bun alias a validuje user-local instalaci", () => {
  const broken = "C:\\Users\\builder\\AppData\\Local\\Microsoft\\WindowsApps\\bun.exe";
  const working = "C:\\Users\\builder\\.bun\\bin\\bun.exe";
  const probes = [];

  const resolved = resolveBunExecutable({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\builder" },
    execPath: "C:\\Program Files\\Launchpad\\Launchpad.exe",
    which: () => broken,
    pathExists: (candidate) => candidate === working,
    probe: (candidate) => {
      probes.push(candidate);
      return candidate === working;
    },
  });

  expect(resolved).toBe(working);
  expect(probes).toEqual([broken, working]);
});

test("Windows port ownership používá rychlý systémový netstat a ne lokalizovaný state label", () => {
  expect(windowsNetstatCommand({ SystemRoot: "C:\\Windows" })).toEqual([
    "C:\\Windows\\System32\\netstat.exe",
    "-ano",
  ]);
  expect(parseWindowsListeningPid([
    "  TCP    127.0.0.1:5797       0.0.0.0:0       LISTENING       4312",
    "  TCP    [::1]:5798           [::]:0          NASLOUCHANI     4313",
    "  TCP    127.0.0.1:5799       127.0.0.1:64000  ESTABLISHED     4314",
  ].join("\r\n"), 5797)).toBe(4312);
  expect(parseWindowsListeningPid([
    "  TCP    [::1]:5798           [::]:0          NASLOUCHANI     4313",
  ].join("\r\n"), 5798)).toBe(4313);
  expect(parseWindowsListeningPid([
    "  TCP    127.0.0.1:5799       127.0.0.1:64000  ESTABLISHED     4314",
  ].join("\r\n"), 5799)).toBeNull();
  expect(parseWindowsListeningBindings([
    "  TCP    0.0.0.0:5797         0.0.0.0:0       LISTENING       4312",
    "  TCP    [::1]:5797           [::]:0          NASLOUCHANI     4313",
  ].join("\r\n"), 5797)).toEqual([
    { endpoint: "0.0.0.0:5797", host: "0.0.0.0", port: 5797 },
    { endpoint: "[::1]:5797", host: "::1", port: 5797 },
  ]);
});

test("Windows module lifecycle system commands fail closed outside a trusted local SystemRoot", () => {
  const invalidEnvironments = [
    {},
    { SystemRoot: "relative-root" },
    { SystemRoot: "C:\\Windows\\..\\attacker" },
    { SystemRoot: "\\\\server\\share\\Windows" },
  ];
  for (const env of invalidEnvironments) {
    expect(() => windowsPowerShellExecutable(env)).toThrow("SystemRoot/WINDIR");
    expect(() => windowsNetstatCommand(env)).toThrow("SystemRoot/WINDIR");
    expect(() => windowsTaskkillCommand(123, { env })).toThrow("SystemRoot/WINDIR");
  }
  expect(windowsNetstatCommand({ WINDIR: "D:\\Windows" })[0])
    .toBe("D:\\Windows\\System32\\netstat.exe");
});

test("Windows process identity command a parser drží PID, parent, creation time a executable", () => {
  const command = windowsProcessIdentityCommand(4242, { SystemRoot: "C:\\Windows" });
  expect(command[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(command.join(" ")).toContain("ProcessId = 4242");
  expect(parseWindowsProcessIdentity(JSON.stringify({
    pid: 4242,
    parent_pid: 3131,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  }))).toEqual({
    pid: 4242,
    parent_pid: 3131,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  });
  expect(parseWindowsProcessIdentity("{}")).toBeNull();
  expect(parseWindowsProcessIdentity(JSON.stringify({
    pid: 4242,
    parent_pid: 3131,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "",
  }))).toBeNull();
});

test("Windows managed Stop používá taskkill jen nad známým PID a celým stromem", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  const stopped = await runtime.stop("test-company-demo-v1");

  expect(stopped.runtime.status).toBe("stopped");
  expect(stopped.forced).toBe(true);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("/T");
  expect(commands[0]).toContain("/F");
  expect(commands[0][commands[0].indexOf("/PID") + 1]).toBe(String(stopped.pid));
  expect(windowsTaskkillCommand(123, {
    force: true,
    env: { SystemRoot: "C:\\Windows" },
  })).toEqual(["C:\\Windows\\System32\\taskkill.exe", "/PID", "123", "/T", "/F"]);
  expect(windowsPowerShellExecutable({ SystemRoot: "C:\\Windows" }))
    .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("Windows Stop nikdy nepoužije taskkill jen podle neověřeného portu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    resolvePortOwnerFn: async () => ({ pid: 42_424, cwd_matches: null }),
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_managed",
    metadata: { owner: "unknown-port" },
  });
  expect(commands).toEqual([]);
});

test("Windows managed Stop uklidí záznam i při numericky shodném reused PID", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let signalSent = false;
  let managedPid = null;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => signalSent
      ? { pid: managedPid, cwd_matches: null }
      : null,
    runSystemCommandFn: async (command) => {
      signalSent = true;
      managedPid = Number(command[command.indexOf("/PID") + 1]);
      return executeWindowsStopCommand(command);
    },
  });

  const started = await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  const stopped = await runtime.stop("test-company-demo-v1");

  expect(stopped.runtime).toMatchObject({
    managed: false,
    owner: "unknown-port",
    pid: started.pid,
    status: "unhealthy",
  });
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_managed",
    metadata: { owner: "unknown-port" },
  });
});

test("Windows managed Restart uklidí Stop záznam a bezpečně blokuje nový PID na reused portu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const replacementPid = 54_321;
  let signalSent = false;
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => signalSent
      ? { pid: replacementPid, cwd_matches: null }
      : null,
    runSystemCommandFn: async (command) => {
      signalSent = true;
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  await expect(runtime.restart("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "runtime_listener_preflight_failed",
    metadata: { failure_kind: "listener_preflight_conflict" },
  });
  const stopped = await runtime.health("test-company-demo-v1");

  expect(stopped).toMatchObject({
    managed: false,
    owner: "unknown-port",
    pid: replacementPid,
    status: "unhealthy",
  });
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_managed",
    metadata: { owner: "unknown-port" },
  });
  expect(commands).toHaveLength(1);
});

test("Windows managed Stop ponechá ownership, když child handle nepotvrdí exit", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const spawnedChildren = [];
  const commands = [];
  let spawnCount = 0;
  let reportFirstExit;
  const firstReportedExit = new Promise((resolve) => {
    reportFirstExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    spawnProcess: (command, options) => {
      const child = spawnFixtureChild(root, command, options);
      spawnedChildren.push(child);
      spawnCount += 1;
      if (spawnCount > 1) return child;
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        exited: firstReportedExit,
      };
    },
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  const started = await runtime.start("test-company-demo-v1");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 500,
    code: "app_stop_failed",
    metadata: {
      failure_kind: "stop_exit_unconfirmed",
      managed_pid: started.pid,
      port,
    },
  });
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_stop_in_progress",
    metadata: {
      failure_kind: "stop_in_progress",
      owner: "current-instance",
      pid: started.pid,
    },
  });
  expect(commands).toHaveLength(1);
  expect(await runtime.health("test-company-demo-v1")).toMatchObject({
    managed: true,
    owner: "current-instance",
    pid: started.pid,
  });
  reportFirstExit(0);
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "stopped");
  expect(commands).toHaveLength(1);

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  expect(spawnCount).toBe(2);
  await runtime.stop("test-company-demo-v1");
  expect(commands).toHaveLength(2);
  await Promise.allSettled(spawnedChildren.map((child) => child.exited));
}, platformTestTimeout(15_000));

test("Windows Stop je po přechodné chybě taskkill znovu bezpečně zkusitelný", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  let failSignal = true;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    runSystemCommandFn: async (command) => {
      commands.push(command);
      if (failSignal) {
        failSignal = false;
        return { ok: false, exitCode: 5, stdout: "", stderr: "Access is denied." };
      }
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 500,
    code: "app_stop_failed",
    metadata: { failure_kind: "stop_signal_failed" },
  });
  expect(commands).toHaveLength(1);
  expect((await runtime.health("test-company-demo-v1")).managed).toBe(true);

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.runtime.status).toBe("stopped");
  expect(commands).toHaveLength(2);
}, platformTestTimeout(10_000));

test("Windows Stop vrátí pre-signal I/O chybu do retryable managed stavu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  let failStoppingWrite = true;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    writeRuntimeStateFile: async (path, content, encoding) => {
      const state = JSON.parse(content);
      if (state.status === "stopping" && failStoppingWrite) {
        failStoppingWrite = false;
        throw new Error("simulated state lock");
      }
      return writeFile(path, content, encoding);
    },
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toThrow("simulated state lock");
  expect(commands).toEqual([]);
  expect((await runtime.health("test-company-demo-v1")).managed).toBe(true);

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.runtime.status).toBe("stopped");
  expect(commands).toHaveLength(1);
}, platformTestTimeout(10_000));

test("Windows Stop po potvrzeném exitu opakuje jen selhanou finalizaci", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  let failStoppedWrite = true;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    writeRuntimeStateFile: async (path, content, encoding) => {
      const state = JSON.parse(content);
      if (state.status === "stopped" && failStoppedWrite) {
        failStoppedWrite = false;
        throw new Error("simulated final state lock");
      }
      return writeFile(path, content, encoding);
    },
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toThrow("simulated final state lock");
  expect(commands).toHaveLength(1);

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.runtime.status).toBe("stopped");
  expect(commands).toHaveLength(1);
}, platformTestTimeout(10_000));

test("Windows Stop drží managed slot až do finálního zápisu a blokuje souběžný Start", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let signalSent = false;
  let shouldBlockOwnerProbe = true;
  let releaseOwnerProbe;
  let reportOwnerProbeStarted;
  const ownerProbeStarted = new Promise((resolve) => {
    reportOwnerProbeStarted = resolve;
  });
  const ownerProbeRelease = new Promise((resolve) => {
    releaseOwnerProbe = resolve;
  });
  let spawnCount = 0;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    spawnProcess: (command, options) => {
      spawnCount += 1;
      return spawnFixtureChild(root, command, options);
    },
    resolvePortOwnerFn: async () => {
      if (!signalSent || !shouldBlockOwnerProbe) return null;
      shouldBlockOwnerProbe = false;
      reportOwnerProbeStarted();
      await ownerProbeRelease;
      return null;
    },
    runSystemCommandFn: async (command) => {
      signalSent = true;
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  const stopPromise = runtime.stop("test-company-demo-v1");
  await ownerProbeStarted;

  let startSettled = false;
  const startPromise = runtime.start("test-company-demo-v1").finally(() => {
    startSettled = true;
  });
  await Bun.sleep(50);
  expect(startSettled).toBe(false);
  expect(spawnCount).toBe(1);

  releaseOwnerProbe();
  const stopped = await stopPromise;
  expect(stopped.runtime.status).toBe("stopped");
  const started = await startPromise;
  expect(started.runtime.status).toBe("healthy");
  expect(spawnCount).toBe(2);

  const finalStop = await runtime.stop("test-company-demo-v1");
  expect(finalStop.runtime.status).toBe("stopped");
}, platformTestTimeout(10_000));

test("Windows post-stop diagnostika je best-effort a neblokuje finalizaci", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let signalSent = false;
  let failDiagnostic = true;
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => {
      if (signalSent && failDiagnostic) {
        failDiagnostic = false;
        throw new Error("simulated owner probe failure");
      }
      return null;
    },
    runSystemCommandFn: async (command) => {
      signalSent = true;
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  const stopped = await runtime.stop("test-company-demo-v1");

  expect(stopped.runtime.status).toBe("stopped");
  expect(commands).toHaveLength(1);
  expect((await runtime.logs("test-company-demo-v1")).content)
    .toContain("post-stop port diagnostic failed");
}, platformTestTimeout(10_000));

test("POSIX Stop po selhání SIGKILL vrátí živý managed proces do retryable stavu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const signals = [];
  let failKill = true;
  let reportExit;
  const exited = new Promise((resolve) => {
    reportExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "posix-test-instance",
    platform: "linux",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    processGroupAliveFn: () => false,
    spawnProcess: () => ({
      pid: 12_345,
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL" && failKill) {
          failKill = false;
          const error = new Error("simulated EPERM");
          error.code = "EPERM";
          throw error;
        }
        if (signal === "SIGTERM" && signals.length > 2) reportExit(0);
      },
    }),
  });

  await runtime.start("test-company-demo-v1");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 403,
    code: "app_stop_forbidden",
    metadata: { failure_kind: "stop_signal_failed" },
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect((await runtime.health("test-company-demo-v1")).managed).toBe(true);

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.runtime.status).toBe("stopped");
  expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
}, 12_000);

test("POSIX Stop awaits an asynchronously rejected process-group signal", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let reportExit;
  const exited = new Promise((resolve) => {
    reportExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    platform: "linux",
    bunExecutable: process.execPath,
    signalProcessGroupFn: async () => {
      const error = new Error("simulated async EPERM");
      error.code = "EPERM";
      throw error;
    },
    spawnProcess: () => ({
      pid: 12_349,
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited,
      kill: () => {},
    }),
  });

  await runtime.start("test-company-demo-v1");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 403,
    code: "app_stop_forbidden",
    metadata: { failure_kind: "stop_signal_failed" },
  });
  expect((await runtime.health("test-company-demo-v1")).managed).toBe(true);
  reportExit(0);
}, platformTestTimeout(10_000));

test("POSIX Stop bez potvrzeného exitu po SIGKILL vrátí ownership do retryable stavu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const signals = [];
  let groupAlive = true;
  let reportExit;
  const exited = new Promise((resolve) => {
    reportExit = resolve;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "posix-test-instance",
    platform: "linux",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    processGroupAliveFn: async () => groupAlive,
    signalProcessGroupFn: async (_processGroupId, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM" && signals.length > 2) {
        groupAlive = false;
        reportExit(0);
      }
    },
    spawnProcess: () => ({
      pid: 12_346,
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited,
      kill: () => {},
    }),
  });

  await runtime.start("test-company-demo-v1");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 500,
    code: "app_stop_failed",
    metadata: {
      failure_kind: "stop_exit_unconfirmed",
      managed_pid: 12_346,
      platform: "linux",
    },
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect((await runtime.health("test-company-demo-v1")).managed).toBe(true);

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.runtime.status).toBe("stopped");
  expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
}, 12_000);

test("runtime manager nepředá stale Organization root lokálnímu surface ani Personalspace lane", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const previousOrganizationRoot = process.env.COMPANYASCODE_ORGANIZATION_ROOT;
  process.env.COMPANYASCODE_ORGANIZATION_ROOT = join(root, "organizations", "ForeignCompany");
  const app = fixtureDiscoveryApp({
    port,
    overrides: {
      organization_path: "guide",
      organization_kind: null,
      discovery_source: "local_surface",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    discover: discoveryWithApp(app),
  });

  let started = false;
  try {
    await runtime.start(app.id);
    started = true;
    await waitForStatus(() => runtime.health(app.id), "healthy");
    const runtimeEnv = await (await fetch(`http://127.0.0.1:${port}/runtime-env`)).json();
    expect(runtimeEnv.organizationRoot).toBeNull();
  } finally {
    if (started) await runtime.stop(app.id);
    if (previousOrganizationRoot === undefined) delete process.env.COMPANYASCODE_ORGANIZATION_ROOT;
    else process.env.COMPANYASCODE_ORGANIZATION_ROOT = previousOrganizationRoot;
  }
});

test("runtime manager odmítne Windows drive path mimo Organization boundary", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = fixtureDiscoveryApp({
    port,
    overrides: {
      organization_path: "D:\\outside\\Macano-Tech_GEN3",
      organization_kind: "organization",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    discover: discoveryWithApp(app),
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    status: 409,
    code: "invalid_organization_path",
  });
});

testWithInspectableProcessCwd("runtime manager rozpozná app-owned port, ale proces jiné Launchpad instance neukončí", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const previousLaunchpadProcess = spawnFixtureChild(root, ["bun", "server.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      LAZURIO_RUNTIME_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const adopted = await runtime.health("test-company-demo-v1");
    expect(adopted.owner).toBe("adopted-port");
    expect(adopted).toMatchObject({ managed: false, controllable: false });
    expect(adopted.pid).toBe(previousLaunchpadProcess.pid);
    const opened = await runtime.open("test-company-demo-v1");
    expect(opened).toMatchObject({
      url: `http://127.0.0.1:${port}`,
      status: "healthy",
      steps: [{ step: "reuse", status: "healthy" }],
    });
    expect(previousLaunchpadProcess.killed).toBe(false);
    await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
    });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_not_managed",
      metadata: { owner: "adopted-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    await killFixtureProcess(previousLaunchpadProcess, root);
  }
});

testWithInspectableProcessCwd("runtime manager neadoptuje zdravý app-owned port z jiného checkoutu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const foreignCwd = await mkdtemp(join(tmpdir(), "launchpad-foreign-checkout-"));
  registerTempRoot(foreignCwd);
  const foreignProcess = spawnFixtureChild(foreignCwd, ["bun", join(appRoot, "server.mjs")], {
    cwd: foreignCwd,
    env: {
      ...process.env,
      LAZURIO_RUNTIME_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const health = await runtime.health("test-company-demo-v1");
    expect(health).toMatchObject({
      status: "unhealthy",
      owner: "foreign-port",
      managed: false,
      failure_kind: "port_owner_cwd_mismatch",
      port_owner: { pid: foreignProcess.pid, cwd_matches: false },
    });
    expect(health.message).toContain("jiného checkoutu");
    await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "runtime_listener_preflight_failed",
      metadata: { failure_kind: "listener_preflight_conflict" },
    });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_not_managed",
      metadata: { owner: "foreign-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    await killFixtureProcess(foreignProcess, foreignCwd);
  }
});

testWithInspectableProcessCwd("runtime manager při Open nahradí jen předchozí verzi stejného module lease", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const sourceRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const targetRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v2");
  await cp(sourceRoot, targetRoot, { recursive: true });
  const targetPackagePath = join(targetRoot, "package.json");
  const targetPackage = JSON.parse(await readFile(targetPackagePath, "utf8"));
  targetPackage.name = "demo-v2";
  targetPackage.companyascode.app = {
    ...targetPackage.companyascode.app,
    id: "test-company-demo-v2",
    title: "Demo v2",
  };
  await writeJson(targetPackagePath, targetPackage);

  const sourceApp = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const targetApp = withStaticEntrypoint(fixtureDiscoveryApp({
    port,
    overrides: {
      id: "test-company-demo-v2",
      title: "Demo v2",
      package_path: "organizations/TestCompany/modules/demo/app/v2/package.json",
      cwd: "organizations/TestCompany/modules/demo/app/v2",
    },
  }));
  const sameOrganizationApp = fixtureDiscoveryApp({
    port,
    overrides: {
      id: "test-company-duplicate-port-v1",
      title: "Duplicate port v1",
      module: "other",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "shared-port-instance",
    discover: discoveryWithApps(sourceApp, targetApp, sameOrganizationApp),
  });

  try {
    await runtime.start(sourceApp.id);
    const sourceHealth = await waitForStatus(() => runtime.health(sourceApp.id), "healthy");
    const targetHealth = await runtime.health(targetApp.id);
    expect(targetHealth).toMatchObject({
      status: "unhealthy",
      owner: "foreign-port",
    });
    expect(targetHealth.pid).toBeNumber();
    expect(sourceHealth.pid).toBeNumber();

    await expect(runtime.switchApp(targetApp.id, { replace_app_id: sourceApp.id })).rejects.toMatchObject({
      status: 400,
      code: "app_switch_confirmation_required",
    });
    await expect(runtime.switchApp(sameOrganizationApp.id, {
      replace_app_id: sourceApp.id,
      confirmed: true,
      source: { type: "main" },
    })).rejects.toMatchObject({
      status: 409,
      code: "app_switch_module_mismatch",
    });

    const opened = await runtime.open(targetApp.id, { source: { type: "main" } });
    expect(opened).toMatchObject({
      action: "open",
      app_id: targetApp.id,
      status: "healthy",
    });
    expect(opened.steps).toContainEqual(expect.objectContaining({
      step: "start",
    }));
    const targetRunning = await waitForStatus(() => runtime.health(targetApp.id), "healthy");
    expect(targetRunning.owner).toBe("current-instance");
    expect((await runtime.health(sourceApp.id))).toMatchObject({
      status: "unhealthy",
      owner: "foreign-port",
    });
  } finally {
    const targetHealth = await runtime.health(targetApp.id);
    if (["current-instance", "adopted-port"].includes(targetHealth.owner)) {
      await runtime.stop(targetApp.id);
    }
  }
}, platformTestTimeout(15_000));

test("cross-Organization listener takeover requires the exact peer confirmation", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const { slug: sourceWorktreeSlug } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6439-cross-organization-source",
  });
  const sourceRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const targetRoot = join(root, "organizations", "Beta", "modules", "control", "app", "v1");
  await mkdir(dirname(targetRoot), { recursive: true });
  await cp(sourceRoot, targetRoot, { recursive: true });

  const source = withStaticEntrypoint(fixtureDiscoveryApp({
    port,
    overrides: {
      module: "demo",
      organization_path: "organizations/TestCompany",
    },
  }));
  const target = withStaticEntrypoint(fixtureDiscoveryApp({
    port,
    overrides: {
      id: "beta-control-v1",
      title: "Beta Control",
      company: "Beta",
      module: "control",
      organization_path: "organizations/Beta",
      package_path: "organizations/Beta/modules/control/app/v1/package.json",
      cwd: "organizations/Beta/modules/control/app/v1",
    },
  }));
  const [sourceApp, targetApp] = withCrossOrganizationOverlap(source, target);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "cross-organization-takeover",
    discover: discoveryWithApps(sourceApp, targetApp),
  });
  const sourceSelector = { source: { type: "worktree", slug: sourceWorktreeSlug } };
  let testFailure = null;

  try {
    await runtime.start(sourceApp.id, sourceSelector);
    await waitForStatus(() => runtime.health(sourceApp.id, sourceSelector), "healthy");

    await expect(runtime.open(targetApp.id)).rejects.toMatchObject({
      status: 409,
      code: "cross_organization_takeover_confirmation_required",
      metadata: {
        replace_app_id: sourceApp.id,
        replace_organization: "test-company",
      },
    });
    const sourceHealthBeforeTakeover = await runtime.health(sourceApp.id, sourceSelector);
    expect(sourceHealthBeforeTakeover).toMatchObject({
      status: "healthy",
      owner: "current-instance",
      runtime_source: { type: "worktree", slug: sourceWorktreeSlug },
    });
    expect(sourceHealthBeforeTakeover).not.toHaveProperty("maintenance");

    await expect(runtime.open(targetApp.id, {
      confirmed: true,
      replace_app_id: "unknown-peer",
    })).rejects.toMatchObject({ code: "cross_organization_takeover_confirmation_required" });

    const opened = await runtime.open(targetApp.id, {
      confirmed: true,
      replace_app_id: sourceApp.id,
    });
    expect(opened).toMatchObject({ action: "open", app_id: targetApp.id, status: "healthy" });
    const sourceHealthAfterTakeover = await runtime.health(sourceApp.id, sourceSelector);
    expect(sourceHealthAfterTakeover).toMatchObject({
      // Windows cannot inspect another process CWD with the built-in resolver,
      // so the same safe post-takeover state is classified fail-closed as
      // unknown-port instead of foreign-port.
      owner: process.platform === "win32" ? "unknown-port" : "foreign-port",
      runtime_source: { type: "worktree", slug: sourceWorktreeSlug },
    });
    expect(sourceHealthAfterTakeover).not.toHaveProperty("maintenance");
    const targetHealthAfterTakeover = await runtime.health(targetApp.id);
    expect(targetHealthAfterTakeover).toMatchObject({
      status: "healthy",
      owner: "current-instance",
    });
    expect(targetHealthAfterTakeover).not.toHaveProperty("maintenance");
    const takeoverAudit = JSON.parse((await readFile(
      join(root, "launchpad", "runtime", "audit", "takeovers.jsonl"),
      "utf8",
    )).trim());
    expect(takeoverAudit).toMatchObject({
      schema_version: "lazurio.runtime_takeover_audit.v1",
      company: "Beta",
      module: "control",
      app_id: targetApp.id,
      reclaimed_listeners: [{
        port,
        method: "managed-stop",
        previous_pid: expect.any(Number),
      }],
    });
    expect(takeoverAudit.listeners.every((listener) => listener.owned)).toBe(true);

    await runtime.stop(targetApp.id);
    const targetHealthAfterStop = await runtime.health(targetApp.id);
    expect(targetHealthAfterStop).toMatchObject({
      status: "stopped",
      owner: "none",
    });
    expect(targetHealthAfterStop).not.toHaveProperty("maintenance");
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    try {
      const targetHealth = await runtime.health(targetApp.id);
      if (targetHealth.owner === "current-instance") await runtime.stop(targetApp.id);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      const sourceHealth = await runtime.health(sourceApp.id, sourceSelector);
      if (sourceHealth.owner === "current-instance") {
        await runtime.stop(sourceApp.id, sourceSelector);
      }
    } catch (error) {
      cleanupFailures.push(error);
    }

    if (cleanupFailures.length > 0) {
      const fixture = tempRoots.find((candidate) => candidate.root === root);
      for (const trackedChild of fixture?.children ?? []) {
        if (trackedChild.exitConfirmed) continue;
        try {
          await killFixtureProcess(trackedChild.child, root);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (!testFailure) {
        throw new AggregateError(cleanupFailures, "Cross-Organization takeover fixture cleanup failed");
      }
    }
  }
}, platformTestTimeout(20_000));

test("runtime manager fail-closed neadoptuje zdravý port při neznámém CWD (Windows/restricted lookup)", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const foreignProcess = spawnFixtureChild(root, ["bun", "server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, LAZURIO_RUNTIME_HOST: "127.0.0.1", LAZURIO_RUNTIME_PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
    resolvePortOwnerFn: async () => ({ pid: foreignProcess.pid, cwd_matches: null }),
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const health = await runtime.health("test-company-demo-v1");
    expect(health).toMatchObject({
      status: "unhealthy",
      owner: "unknown-port",
      managed: false,
      failure_kind: "port_owner_cwd_unknown",
      port_owner: { pid: foreignProcess.pid, cwd_matches: null },
    });
    await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "runtime_listener_preflight_failed",
      metadata: { failure_kind: "listener_preflight_conflict" },
    });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_not_managed",
      metadata: { owner: "unknown-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    await killFixtureProcess(foreignProcess, root);
  }
});

test("Windows po restartu adoptuje jen listener s platným capture-time owner proof", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const ownedProcess = spawnFixtureChild(root, [process.execPath, "server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, LAZURIO_RUNTIME_HOST: "127.0.0.1", LAZURIO_RUNTIME_PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  const identity = {
    pid: ownedProcess.pid,
    parent_pid: process.pid,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  };
  const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
  await mkdir(join(root, "launchpad", "runtime", "apps"), { recursive: true });
  const validProof = {
    schema_version: "companiesascode.launchpad.runtime_owner_proof.v1",
    platform: "win32",
    launcher_pid: ownedProcess.pid,
    listener_pid: ownedProcess.pid,
    listener_identity: identity,
    ancestry: [identity],
    expected_cwd: appRoot,
    captured_at: "2026-07-27T08:00:01.000Z",
  };
  const writeProof = async (ownerProof, stateOverrides = {}) => writeJson(statePath, {
    status: "healthy",
    app_id: "test-company-demo-v1",
    runtime_key: "test-company-demo-v1",
    runtime_source: { type: "main" },
    port,
    pid: ownedProcess.pid,
    instance_id: "previous-launchpad-instance",
    owner_proof: ownerProof,
    ...stateOverrides,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
    platform: "win32",
    resolvePortOwnerFn: async () => ({ pid: ownedProcess.pid, cwd_matches: null }),
    resolveProcessIdentityFn: async () => identity,
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    await writeProof(validProof);
    expect(await runtime.health("test-company-demo-v1")).toMatchObject({
      status: "healthy",
      owner: "adopted-port",
      managed: false,
      controllable: false,
      port_owner: {
        pid: ownedProcess.pid,
        cwd_matches: true,
        verified_by: "runtime-owner-proof",
      },
    });

    const invalidProofs = [
      ["PID", { ...validProof, listener_pid: ownedProcess.pid + 1 }],
      ["creation time", {
        ...validProof,
        listener_identity: { ...identity, created_at: "2026-07-27T08:00:02.000Z" },
        ancestry: [{ ...identity, created_at: "2026-07-27T08:00:02.000Z" }],
      }],
      ["executable", {
        ...validProof,
        listener_identity: { ...identity, executable_path: "C:\\Other\\bun.exe" },
        ancestry: [{ ...identity, executable_path: "C:\\Other\\bun.exe" }],
      }],
      ["expected CWD", { ...validProof, expected_cwd: join(root, "other-checkout") }],
      ["capture-time ancestry", { ...validProof, launcher_pid: ownedProcess.pid + 10 }],
    ];
    for (const [reason, proof] of invalidProofs) {
      await writeProof(proof);
      expect(await runtime.health("test-company-demo-v1"), reason).toMatchObject({
        status: "unhealthy",
        owner: "unknown-port",
        managed: false,
        failure_kind: "port_owner_cwd_unknown",
      });
    }

    const invalidStateBindings = [
      ["app id", { app_id: "other-app" }],
      ["runtime key", { runtime_key: "other-runtime" }],
      ["port", { port: port + 1 }],
      ["status", { status: "stopped" }],
      ["unrelated unhealthy state", { status: "unhealthy", failure_kind: "start_failed" }],
    ];
    for (const [reason, stateOverrides] of invalidStateBindings) {
      await writeProof(validProof, stateOverrides);
      expect(await runtime.health("test-company-demo-v1"), reason).toMatchObject({
        owner: "unknown-port",
        managed: false,
        failure_kind: "port_owner_cwd_unknown",
      });
    }

    await writeProof(validProof);
    for (const resolveProcessIdentityFn of [
      async () => null,
      async () => { throw new Error("CIM denied"); },
    ]) {
      const identityUnavailableRuntime = createRuntimeManager({
        companiesRoot: root,
        launchpadRoot: join(root, "launchpad"),
        instanceId: "identity-unavailable",
        platform: "win32",
        resolvePortOwnerFn: async () => ({ pid: ownedProcess.pid, cwd_matches: null }),
        resolveProcessIdentityFn,
      });
      expect(await identityUnavailableRuntime.health("test-company-demo-v1")).toMatchObject({
        owner: "unknown-port",
        managed: false,
        failure_kind: "port_owner_cwd_unknown",
      });
    }

    const posixRuntime = createRuntimeManager({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      instanceId: "posix-proof-rejection",
      platform: "darwin",
      resolvePortOwnerFn: async () => ({ pid: ownedProcess.pid, cwd_matches: null }),
      resolveProcessIdentityFn: async () => identity,
    });
    expect(await posixRuntime.health("test-company-demo-v1")).toMatchObject({
      owner: "unknown-port",
      managed: false,
      failure_kind: "port_owner_cwd_unknown",
    });
  } finally {
    await killFixtureProcess(ownedProcess, root);
  }
});

test("Windows standalone Start doplní owner proof, i když listener začne být zdravý pomalu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "await Bun.sleep(1400);",
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  let child = null;
  const startedAt = Date.now();
  const identityFor = (pid) => ({
    pid,
    parent_pid: process.pid,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-slow-start",
    platform: "win32",
    bunExecutable: process.execPath,
    spawnProcess: (command, options) => {
      child = spawnFixtureChild(root, command, options);
      return child;
    },
    resolvePortOwnerFn: async () => child && Date.now() - startedAt >= 1200
      ? { pid: child.pid, cwd_matches: null }
      : null,
    resolveProcessIdentityFn: async (pid) => child && pid === child.pid ? identityFor(pid) : null,
  });

  try {
    const started = await runtime.start("test-company-demo-v1");
    expect(started.runtime.status).toBe("starting");
    const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
    const state = await waitForJson(statePath, (value) => value.owner_proof);
    expect(state).toMatchObject({
      status: "starting",
      owner_proof: {
        listener_pid: child.pid,
        ancestry: [{ pid: child.pid }],
      },
    });
    expect(state.owner_proof.expected_cwd.endsWith(
      join("organizations", "TestCompany", "modules", "demo", "app", "v1"),
    )).toBe(true);
    const restartedRuntime = createRuntimeManager({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      instanceId: "windows-after-slow-start",
      platform: "win32",
      resolvePortOwnerFn: async () => ({ pid: child.pid, cwd_matches: null }),
      resolveProcessIdentityFn: async (pid) => pid === child.pid ? identityFor(pid) : null,
    });
    expect(await restartedRuntime.health("test-company-demo-v1")).toMatchObject({
      status: "healthy",
      owner: "adopted-port",
      managed: false,
      controllable: false,
      port_owner: {
        pid: child.pid,
        verified_by: "runtime-owner-proof",
      },
    });
  } finally {
    await killFixtureProcess(child, root);
  }
}, platformTestTimeout(10_000));

test("Windows Lazurio Start accepts a listener owned by the launcher's child process", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const launcherPid = 42_425;
  const launcherIdentity = {
    pid: launcherPid,
    parent_pid: process.pid,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  };
  let listener = null;
  const listenerIdentity = () => ({
    pid: listener.pid,
    parent_pid: launcherPid,
    created_at: "2026-07-27T08:00:01.000Z",
    executable_path: "C:\\Tools\\vite.exe",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-child-listener",
    platform: "win32",
    bunExecutable: process.execPath,
    discover: discoveryWithApp(app),
    spawnProcess: (_command, options) => {
      listener = spawnFixtureChild(root, [process.execPath, "server.mjs"], options);
      return {
        pid: launcherPid,
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: new Promise(() => {}),
        kill: (signal) => listener.kill(signal),
      };
    },
    resolvePortOwnerFn: async () => listener
      ? { pid: listener.pid, cwd_matches: null }
      : null,
    resolveProcessIdentityFn: async (pid) => {
      if (pid === launcherPid) return launcherIdentity;
      if (pid === listener?.pid) return listenerIdentity();
      return null;
    },
    startedListenerOwnershipTimeoutMs: 3_000,
  });

  try {
    const started = await runtime.start(app.id);
    expect(started.runtime.listener_reconciliation).toMatchObject({
      status: "ok",
      declared: [expect.objectContaining({
        listener_id: "web",
        status: "observed",
        pid: listener.pid,
        observed_endpoints: expect.arrayContaining([`127.0.0.1:${port}`]),
      })],
    });
    const state = JSON.parse(await readFile(
      join(root, "launchpad", "runtime", "apps", `${app.id}.json`),
      "utf8",
    ));
    expect(state.listener_ownership).toEqual([
      expect.objectContaining({
        owner_pid: listener.pid,
        owned: true,
      }),
    ]);
  } finally {
    await killFixtureProcess(listener, root);
  }
}, platformTestTimeout(10_000));

test("Windows launcher exit after Start preserves Lazurio listener audit for restart", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
  const launcherPid = 42_424;
  let listener = null;
  let listenerExited = false;
  let reportLauncherExit;
  const launcherExited = new Promise((resolve) => {
    reportLauncherExit = resolve;
  });
  let releaseProofCapture = () => {};
  let reportProofCaptureStarted;
  const proofCaptureStarted = new Promise((resolve) => {
    reportProofCaptureStarted = resolve;
  });
  const proofCaptureRelease = new Promise((resolve) => {
    releaseProofCapture = resolve;
  });
  const listenerIdentity = () => ({
    pid: listener.pid,
    parent_pid: launcherPid,
    created_at: "2026-07-27T08:00:01.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  });
  const launcherIdentity = {
    pid: launcherPid,
    parent_pid: process.pid,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  };
  let launcherIdentityProbeCount = 0;
  const resolveOwner = async () => listener && !listenerExited
    ? { pid: listener.pid, cwd_matches: null }
    : null;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-launcher-handoff",
    platform: "win32",
    bunExecutable: process.execPath,
    discover: discoveryWithApp(app),
    spawnProcess: (_command, options) => {
      listener = spawnFixtureChild(root, [process.execPath, "server.mjs"], options);
      void listener.exited.then(() => { listenerExited = true; });
      return {
        pid: launcherPid,
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: launcherExited,
        kill: () => {},
      };
    },
    resolvePortOwnerFn: resolveOwner,
    resolveProcessIdentityFn: async (pid) => {
      if (pid === listener?.pid) {
        reportProofCaptureStarted();
        await proofCaptureRelease;
        return listenerIdentity();
      }
      if (pid === launcherPid) {
        launcherIdentityProbeCount += 1;
        return launcherIdentityProbeCount === 1 ? launcherIdentity : null;
      }
      return null;
    },
  });

  try {
    const startPromise = runtime.start("test-company-demo-v1");
    await proofCaptureStarted;
    releaseProofCapture();
    expect((await startPromise).runtime).toMatchObject({
      status: "healthy",
      owner: "current-instance",
      managed: true,
      controllable: true,
    });
    const startedState = JSON.parse(await readFile(statePath, "utf8"));
    expect(startedState).toMatchObject({
      status: "starting",
      active_source: { type: "main" },
      listeners: [expect.objectContaining({ id: "web", port })],
      listener_ownership: [expect.objectContaining({ owner_pid: listener.pid, owned: true })],
      takeover_audit: [],
    });

    reportLauncherExit(0);

    const handedOffState = await waitForJson(
      statePath,
      (state) => state.launcher_exit_code === 0,
    );
    expect(handedOffState).toMatchObject({
      status: "healthy",
      active_source: { type: "main" },
      listeners: [expect.objectContaining({ id: "web", port })],
      listener_ownership: [expect.objectContaining({ owner_pid: listener.pid, owned: true })],
      takeover_audit: [],
      launcher_exit_code: 0,
      owner_proof: {
        launcher_pid: launcherPid,
        listener_pid: listener.pid,
      },
    });
    expect(launcherIdentityProbeCount).toBe(1);

    const restartedRuntime = createRuntimeManager({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      instanceId: "windows-after-launcher-handoff",
      platform: "win32",
      discover: discoveryWithApp(app),
      resolvePortOwnerFn: resolveOwner,
      resolveProcessIdentityFn: async (pid) => pid === listener?.pid ? listenerIdentity() : null,
    });
    expect(await restartedRuntime.health("test-company-demo-v1")).toMatchObject({
      status: "healthy",
      owner: "adopted-port",
      port_owner: { verified_by: "runtime-owner-proof" },
    });
    await expect(restartedRuntime.stop("test-company-demo-v1")).rejects.toMatchObject({
      code: "app_not_managed",
      metadata: { owner: "adopted-port" },
    });
  } finally {
    reportLauncherExit(0);
    releaseProofCapture();
    await killFixtureProcess(listener, root);
  }
}, platformTestTimeout(10_000));

test("Windows owner proof přežije restart Launchpadu mezi stopping zápisem a signálem", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
  let child = null;
  let childExited = false;
  let releaseManagedSignal = () => {};
  let reportManagedSignalStarted;
  const managedSignalStarted = new Promise((resolve) => {
    reportManagedSignalStarted = resolve;
  });
  const managedSignalRelease = new Promise((resolve) => {
    releaseManagedSignal = resolve;
  });
  const identityFor = (pid) => ({
    pid,
    parent_pid: process.pid,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  });
  const resolveOwner = async () => child && !childExited
    ? { pid: child.pid, cwd_matches: null }
    : null;
  const firstRuntime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-before-stopping-restart",
    platform: "win32",
    bunExecutable: process.execPath,
    spawnProcess: (command, options) => {
      child = spawnFixtureChild(root, command, options);
      void child.exited.then(() => { childExited = true; });
      return child;
    },
    resolvePortOwnerFn: resolveOwner,
    resolveProcessIdentityFn: async (pid) => pid === child?.pid ? identityFor(pid) : null,
    runSystemCommandFn: async () => {
      reportManagedSignalStarted();
      await managedSignalRelease;
      // POSIX test double: graceful termination lets the local `bun run`
      // wrapper close its child and inherited pipes. Real Windows uses
      // taskkill /T /F over the full managed tree.
      child.kill("SIGTERM");
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });

  try {
    await firstRuntime.start("test-company-demo-v1");
    await waitForJson(statePath, (state) => state.owner_proof);
    const firstStop = firstRuntime.stop("test-company-demo-v1");
    await managedSignalStarted;

    const stoppingState = JSON.parse(await readFile(statePath, "utf8"));
    expect(stoppingState).toMatchObject({
      status: "stopping",
      owner_proof: { listener_pid: child.pid },
    });

    const restartedRuntime = createRuntimeManager({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      instanceId: "windows-after-stopping-restart",
      platform: "win32",
      resolvePortOwnerFn: resolveOwner,
      resolveProcessIdentityFn: async (pid) => pid === child?.pid ? identityFor(pid) : null,
    });
    expect(await restartedRuntime.health("test-company-demo-v1")).toMatchObject({
      status: "healthy",
      owner: "adopted-port",
      managed: false,
      controllable: false,
      port_owner: { verified_by: "runtime-owner-proof" },
    });

    // Dokončení původního managed Stopu potvrdí jen jeho child handle; nová
    // instance proces ani s platným owner proof neovládá.
    releaseManagedSignal();
    await firstStop;
    await expect(restartedRuntime.stop("test-company-demo-v1")).rejects.toMatchObject({
      code: "app_not_managed",
      metadata: { owner: "none" },
    });
  } finally {
    releaseManagedSignal();
    await killFixtureProcess(child, root);
  }
}, platformTestTimeout(10_000));

test("Windows owner proof přežije stop failure a po restartu dovolí bezpečný retry", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const statePath = join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json");
  let child = null;
  let childExited = false;
  const identityFor = (pid) => ({
    pid,
    parent_pid: process.pid,
    created_at: "2026-07-27T08:00:00.000Z",
    executable_path: "C:\\Tools\\bun.exe",
  });
  const resolveOwner = async () => child && !childExited
    ? { pid: child.pid, cwd_matches: null }
    : null;
  const firstRuntime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-before-stop-failure",
    platform: "win32",
    bunExecutable: process.execPath,
    spawnProcess: (command, options) => {
      child = spawnFixtureChild(root, command, options);
      void child.exited.then(() => { childExited = true; });
      return child;
    },
    resolvePortOwnerFn: resolveOwner,
    resolveProcessIdentityFn: async (pid) => pid === child?.pid ? identityFor(pid) : null,
    runSystemCommandFn: async () => ({
      ok: false,
      exitCode: 5,
      stdout: "",
      stderr: "Access is denied.",
    }),
  });

  try {
    await firstRuntime.start("test-company-demo-v1");
    await waitForJson(statePath, (state) => state.owner_proof);
    await expect(firstRuntime.stop("test-company-demo-v1")).rejects.toMatchObject({
      code: "app_stop_failed",
      metadata: { failure_kind: "stop_signal_failed" },
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      status: "unhealthy",
      failure_kind: "stop_signal_failed",
      owner_proof: { listener_pid: child.pid },
    });

    const restartedRuntime = createRuntimeManager({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      instanceId: "windows-after-stop-failure",
      platform: "win32",
      resolvePortOwnerFn: resolveOwner,
      resolveProcessIdentityFn: async (pid) => pid === child?.pid ? identityFor(pid) : null,
    });
    expect(await restartedRuntime.health("test-company-demo-v1")).toMatchObject({
      status: "healthy",
      owner: "adopted-port",
      managed: false,
      controllable: false,
      port_owner: { verified_by: "runtime-owner-proof" },
    });
    await expect(restartedRuntime.stop("test-company-demo-v1")).rejects.toMatchObject({
      code: "app_not_managed",
      metadata: { owner: "adopted-port" },
    });
  } finally {
    await killFixtureProcess(child, root);
  }
}, platformTestTimeout(10_000));

test("Windows owner proof capture je bounded a health hot path ho neopakuje", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let child = null;
  let identityProbeCount = 0;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-bounded-proof",
    platform: "win32",
    bunExecutable: process.execPath,
    spawnProcess: (command, options) => {
      child = spawnFixtureChild(root, command, options);
      return child;
    },
    resolvePortOwnerFn: async () => child ? { pid: child.pid, cwd_matches: null } : null,
    resolveProcessIdentityFn: async () => {
      identityProbeCount += 1;
      return null;
    },
  });

  try {
    await runtime.start("test-company-demo-v1");
    for (let attempt = 0; attempt < 20 && identityProbeCount < 4; attempt += 1) {
      await sleep(100);
    }
    expect(identityProbeCount).toBe(4);
    await runtime.health("test-company-demo-v1");
    await runtime.health("test-company-demo-v1");
    expect(identityProbeCount).toBe(4);
  } finally {
    await killFixtureProcess(child, root);
  }
}, platformTestTimeout(10_000));

test("adopted port zůstává diagnostický a Stop nikdy nezíská destruktivní autoritu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const adoptedProcess = spawnFixtureChild(root, ["bun", "server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, LAZURIO_RUNTIME_HOST: "127.0.0.1", LAZURIO_RUNTIME_PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  let ownerProbeCount = 0;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
    resolvePortOwnerFn: async () => ({
      pid: adoptedProcess.pid,
      cwd_matches: ++ownerProbeCount <= 2 ? true : null,
    }),
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    expect(await runtime.health("test-company-demo-v1")).toMatchObject({
      owner: "adopted-port",
      managed: false,
      controllable: false,
    });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_not_managed",
      metadata: { failure_kind: "not_managed", owner: "adopted-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    await killFixtureProcess(adoptedProcess, root);
  }
});

testWithInspectableProcessCwd("runtime manager neukončí ani stubborn adopted vlastníka", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "process.on('SIGTERM', () => {});",
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const stubbornProcess = spawnFixtureChild(root, ["bun", "server.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      LAZURIO_RUNTIME_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const adopted = await runtime.health("test-company-demo-v1");
    expect(adopted).toMatchObject({ owner: "adopted-port", pid: stubbornProcess.pid });

    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      code: "app_not_managed",
      metadata: { owner: "adopted-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    await killFixtureProcess(stubbornProcess, root);
  }
}, 12_000);

test("runtime manager umí nainstalovat balíčky aplikace a zapsat install log", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([process.execPath, "-e", fixtureDependencyInstallScript("await Bun.write('node_modules/fixture.txt', 'ready\\n')")], options)
      : spawnFixtureChild(root, command, options),
  });

  const result = await runtime.install("test-company-demo-v1");
  expect(result.action).toBe("install");
  expect(result.exit_code).toBe(0);
  expect(result.command_display).toBe("bun install --frozen-lockfile");
  expect(result.cwd.endsWith(join("organizations", "TestCompany", "modules", "demo", "app", "v1"))).toBe(true);
  expect(result.log_path).toBe("logs/apps/test-company-demo-v1.log");
  const repair = await runtime.install("test-company-demo-v1", { action: "repair" });
  expect(repair.action).toBe("repair");
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.content).toContain("install test-company-demo-v1 command=bun install --frozen-lockfile");
  expect(logs.content).toContain("repair test-company-demo-v1 command=bun install --frozen-lockfile");
  expect(logs.content).toContain("code=0");
});

test("clean Repair zastaví a znovu spustí přesně managed aplikaci", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(join(appRoot, "node_modules", "old.txt"), "old\n");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([process.execPath, "-e", fixtureDependencyInstallScript("await Bun.write('node_modules/new.txt', 'new\\n')")], options)
      : spawnFixtureChild(root, command, options),
  });

  const opened = await runtime.open("test-company-demo-v1");
  const oldPid = opened.runtime.pid;
  expect(opened.runtime.status).toBe("healthy");

  const repaired = await runtime.install("test-company-demo-v1", { action: "repair" });
  const healthy = await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");

  expect(repaired).toMatchObject({
    action: "repair",
    mode: "clean",
    removed_node_modules: true,
    restarted: { action: "start" },
  });
  expect(healthy.pid).not.toBe(oldPid);
  expect(existsSync(join(appRoot, "node_modules", "old.txt"))).toBe(false);
  expect(await readFile(join(appRoot, "node_modules", "new.txt"), "utf8")).toBe("new\n");
  await runtime.stop("test-company-demo-v1");
}, platformTestTimeout(15_000));

test("update refresh retries a failed ensure cleanly and restores the managed app", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(join(appRoot, "node_modules", "old.txt"), "old\n");
  let installAttempts = 0;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "refresh-test-instance",
    spawnProcess: (command, options) => {
      if (!command.slice(1).includes("install")) return spawnFixtureChild(root, command, options);
      installAttempts += 1;
      return installAttempts === 1
        ? Bun.spawn([process.execPath, "-e", "process.exit(2)"], options)
        : Bun.spawn([process.execPath, "-e", fixtureDependencyInstallScript("await Bun.write('node_modules/new.txt', 'new\\n')")], options);
    },
  });

  const opened = await runtime.open("test-company-demo-v1");
  const refreshed = await runtime.refreshDependencies("test-company-demo-v1");
  const healthy = await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");

  expect(refreshed).toMatchObject({
    action: "refresh",
    mode: "clean",
    refresh_strategy: "clean_repair",
    removed_node_modules: true,
    restarted: { action: "start" },
  });
  expect(installAttempts).toBe(2);
  expect(healthy.pid).not.toBe(opened.runtime.pid);
  expect(existsSync(join(appRoot, "node_modules", "old.txt"))).toBe(false);
  expect(await readFile(join(appRoot, "node_modules", "new.txt"), "utf8")).toBe("new\n");
  await runtime.stop("test-company-demo-v1");
}, platformTestTimeout(15_000));

test("failed clean Repair discards derived dependencies and leaves the app blocked", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(join(appRoot, "node_modules", "previous.txt"), "previous\n");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "repair-failure-test-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([
          process.execPath,
          "-e",
          "await Bun.write('node_modules/partial.txt', 'partial\\n'); process.exit(23)",
        ], options)
      : spawnFixtureChild(root, command, options),
  });

  const opened = await runtime.open("test-company-demo-v1");
  await expect(runtime.install("test-company-demo-v1", { action: "repair" })).rejects.toMatchObject({
    code: "app_install_failed",
    metadata: { runtime_tree_usable: false },
  });
  const blocked = await runtime.health("test-company-demo-v1");

  expect(blocked).toMatchObject({
    owner: "none",
    status: "stopped",
    managed: false,
    dependencies: { state: "needs_install" },
  });
  expect(blocked.pid).not.toBe(opened.runtime.pid);
  expect(existsSync(join(appRoot, "node_modules"))).toBe(false);
  expect(existsSync(join(appRoot, "node_modules", "partial.txt"))).toBe(false);
}, platformTestTimeout(15_000));

test("authority drift discards dependencies and never restarts the previously managed app", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(join(appRoot, "node_modules", "previous.txt"), "previous\n");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "repair-authority-drift-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([
          process.execPath,
          "-e",
          "await Bun.write('package.json', JSON.stringify({ name: 'fixture', private: true, dependencies: {} })); process.exit(0)",
        ], options)
      : spawnFixtureChild(root, command, options),
  });

  await runtime.open("test-company-demo-v1");
  await expect(runtime.install("test-company-demo-v1", { action: "repair" })).rejects.toMatchObject({
    code: "app_install_failed",
    metadata: {
      failure_kind: "dependency_authority_changed",
      runtime_tree_usable: false,
    },
  });

  expect(existsSync(join(appRoot, "node_modules"))).toBe(false);
  expect(JSON.parse(await readFile(
    join(root, "launchpad", "runtime", "apps", "test-company-demo-v1.json"),
    "utf8",
  ))).toMatchObject({
    status: "unhealthy",
    failure_kind: "dependency_authority_changed",
  });
}, platformTestTimeout(15_000));

test("refused clean Repair leaves the dependency boundary untouched and the app stopped", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const externalDependencies = join(root, "organizations", "TestCompany", "modules", "demo", "dependency-tree");
  await mkdir(externalDependencies);
  await writeFile(join(externalDependencies, "marker.txt"), "untouched\n");
  await mkdir(join(externalDependencies, "fixture"));
  await writeFile(
    join(externalDependencies, "fixture", "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  await symlink(externalDependencies, join(appRoot, "node_modules"), "dir");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "repair-boundary-test-instance",
  });

  const opened = await runtime.open("test-company-demo-v1");
  await expect(runtime.install("test-company-demo-v1", { action: "repair" })).rejects.toMatchObject({
    code: "app_install_failed",
    metadata: {
      failure_kind: "node_modules_boundary_invalid",
      runtime_tree_usable: true,
    },
  });
  const blocked = await runtime.health("test-company-demo-v1");

  expect(blocked).toMatchObject({ owner: "none", status: "stopped", managed: false });
  expect(blocked.pid).not.toBe(opened.runtime.pid);
  expect(await readFile(join(externalDependencies, "marker.txt"), "utf8")).toBe("untouched\n");
}, platformTestTimeout(15_000));

test("runtime manager předá absolutní Organization root i install lifecycle procesu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
    installScripts: { preinstall: "bun capture-install-env.mjs" },
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(
    join(appRoot, "capture-install-env.mjs"),
    [
      "await Bun.write(",
      "  'install-env.json',",
      "  JSON.stringify({ organizationRoot: process.env.COMPANYASCODE_ORGANIZATION_ROOT ?? null, nodePath: process.env.NODE_PATH ?? null }),",
      ");",
      "",
    ].join("\n"),
    "utf8",
  );
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([
          process.execPath,
          "-e",
          fixtureDependencyInstallScript("await Bun.write('node_modules/fixture.txt', 'ready\\n'); await Bun.write('install-env.json', JSON.stringify({ organizationRoot: process.env.COMPANYASCODE_ORGANIZATION_ROOT ?? null, nodePath: process.env.NODE_PATH ?? null }))"),
        ], options)
      : spawnFixtureChild(root, command, options),
  });

  await runtime.install("test-company-demo-v1");
  const captured = JSON.parse(await readFile(join(appRoot, "install-env.json"), "utf8"));
  expect(captured.organizationRoot).toBe(await realpath(join(root, "organizations", "TestCompany")));
  expect(captured.nodePath).toBe(join(await realpath(appRoot), "node_modules"));
});

test("runtime manager classifyuje selhaný Install/Repair s failure_kind", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    writeLockfile: true,
    installScripts: {
      preinstall: "node -e \"console.error('fixture install script failed: lifecycle script'); process.exit(13)\"",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: () => ({
      stdout: new Response("").body,
      stderr: new Response("fixture install script failed: lifecycle script\n").body,
      exited: Promise.resolve(13),
    }),
  });

  let failure;
  try {
    await runtime.install("test-company-demo-v1", { action: "repair" });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    status: 500,
    code: "app_install_failed",
  });
  expect(failure.metadata.action).toBe("repair");
  expect(failure.metadata.failure_kind).toBe("install_script_failed");
  const health = await runtime.health("test-company-demo-v1");
  expect(health.failure_kind).toBe("install_script_failed");
  expect(health.last_install.action).toBe("repair");
});

test("runtime manager rozlišuje missing dependency state a blokuje Start před Install", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "@fixture/needs-install": "1.0.0" },
    writeLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("needs_install");
  expect(health.dependencies.can_install).toBe(true);
  expect(health.dependencies.can_start).toBe(false);
  let startError;
  try {
    await runtime.start("test-company-demo-v1");
  } catch (error) {
    startError = error;
  }
  expect(startError).toMatchObject({
    status: 409,
    code: "app_not_ready",
  });
  expect(startError.metadata.failure_kind).toBe("missing_dependencies");
});

test("runtime manager dependency model nepoužívá filesystem mtime jako package drift autoritu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "@fixture/stale": "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
    staleLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("ready");
  expect(health.dependencies.lockfile.path).toBe("bun.lock");
  expect(health.dependencies.can_start).toBe(true);
});

test("runtime manager nepovažuje neúplný node_modules strom za připravený", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "simple-icons": "16.28.0", "@fixture/present": "1.0.0" },
    devDependencies: { "@fixture/dev-present": "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await rm(join(appRoot, "node_modules", "simple-icons"), { recursive: true, force: true });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies).toMatchObject({
    state: "needs_install",
    can_install: true,
    can_start: false,
    missing_required_dependencies: ["simple-icons"],
  });
  expect(health.dependencies.message).toContain("simple-icons");
  await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_ready",
    metadata: { failure_kind: "missing_dependencies" },
  });

  const simpleIconsRoot = join(appRoot, "node_modules", "simple-icons");
  await mkdir(simpleIconsRoot);
  await writeFile(
    join(simpleIconsRoot, "package.json"),
    JSON.stringify({ name: "simple-icons", version: "16.28.0" }),
  );
  await rm(join(appRoot, "node_modules", "@fixture", "dev-present"), { recursive: true, force: true });
  expect((await runtime.health("test-company-demo-v1")).dependencies).toMatchObject({
    state: "needs_install",
    missing_required_dependencies: ["@fixture/dev-present"],
  });
});

test("runtime dependency boundary izoluje Module checkout od jiné Organizace", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const foreignNodeModules = join(root, "organizations", "OtherCompany", "workspace", "foreign", "node_modules");
  await mkdir(join(foreignNodeModules, "fixture"), { recursive: true });
  await writeFile(
    join(foreignNodeModules, "fixture", "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  await symlink(
    foreignNodeModules,
    join(appRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "cross-organization-dependency-boundary",
    discover: discoveryWithApp(app),
  });

  expect((await runtime.health(app.id)).dependencies).toMatchObject({
    state: "dependency_boundary_invalid",
    can_start: false,
    can_install: false,
  });
  await expect(runtime.start(app.id)).rejects.toMatchObject({
    status: 409,
    code: "app_not_ready",
    metadata: { failure_kind: "dependency_boundary_invalid" },
  });
});

test("runtime accepts an exact declared file dependency from the same Organization", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "@workspace-contracts/v1": "file:../../../../launchpad/contracts/v1" },
    writeLockfile: true,
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  const appRoot = join(organizationRoot, "modules", "demo", "app", "v1");
  const targetRoot = join(organizationRoot, "launchpad", "contracts", "v1");
  const installedRoot = join(appRoot, "node_modules", "@workspace-contracts", "v1");
  await mkdir(targetRoot, { recursive: true });
  await writeJson(join(targetRoot, "package.json"), {
    name: "@test-company-contracts/v1",
    private: true,
  });
  await writeFile(join(targetRoot, "index.ts"), "export const fixture = true;\n");
  await mkdir(join(appRoot, "node_modules", "@workspace-contracts"), { recursive: true });
  await symlink(targetRoot, installedRoot, process.platform === "win32" ? "junction" : "dir");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "organization-local-file-dependency",
  });

  expect((await runtime.health("test-company-demo-v1")).dependencies).toMatchObject({
    state: "ready",
    required_dependency_count: 1,
    missing_required_dependencies: [],
    can_start: true,
  });
});

test.skipIf(process.platform === "win32")("runtime blocks a local link farm whose executable payload escapes the Organization", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "@workspace-contracts/v1": "file:../../../../launchpad/contracts/v1" },
    writeLockfile: true,
  });
  const organizationRoot = join(root, "organizations", "TestCompany");
  const appRoot = join(organizationRoot, "modules", "demo", "app", "v1");
  const targetRoot = join(organizationRoot, "launchpad", "contracts", "v1");
  const installedRoot = join(appRoot, "node_modules", "@workspace-contracts", "v1");
  const foreignRoot = join(root, "organizations", "OtherCompany", "payload");
  await mkdir(targetRoot, { recursive: true });
  await mkdir(installedRoot, { recursive: true });
  await mkdir(foreignRoot, { recursive: true });
  await writeJson(join(targetRoot, "package.json"), { name: "@test-company-contracts/v1" });
  await writeFile(join(targetRoot, "index.ts"), "export const local = true;\n");
  await writeFile(join(foreignRoot, "index.ts"), "export const foreign = true;\n");
  await symlink(join(targetRoot, "package.json"), join(installedRoot, "package.json"), "file");
  await symlink(join(foreignRoot, "index.ts"), join(installedRoot, "index.ts"), "file");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "organization-local-link-farm-escape",
  });

  expect((await runtime.health("test-company-demo-v1")).dependencies).toMatchObject({
    state: "dependency_boundary_invalid",
    can_start: false,
    can_install: false,
  });
  await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_ready",
    metadata: { failure_kind: "dependency_boundary_invalid" },
  });
});

test.skipIf(process.platform === "win32")("runtime reads package and selected lockfile only after exact checkout authority", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port, writeLockfile: true });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const packagePath = join(appRoot, "package.json");
  const originalPackage = await readFile(packagePath, "utf8");
  const foreignRoot = join(root, "organizations", "OtherCompany", "workspace", "foreign-authority");
  await mkdir(foreignRoot, { recursive: true });
  await writeJson(join(foreignRoot, "package.json"), {
    private: true,
    dependencies: { foreign: "1.0.0" },
  });
  await writeFile(join(foreignRoot, "package-lock.json"), "{}\n");
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "package-authority-boundary",
    discover: discoveryWithApp(app),
  });

  await rm(packagePath);
  await symlink(join(foreignRoot, "package.json"), packagePath, "file");
  expect((await runtime.health(app.id)).dependencies).toMatchObject({
    state: "dependency_boundary_invalid",
    can_start: false,
    can_install: false,
  });

  await rm(packagePath);
  await writeFile(packagePath, originalPackage);
  await rm(join(appRoot, "bun.lock"));
  await symlink(join(foreignRoot, "package-lock.json"), join(appRoot, "package-lock.json"), "file");
  expect((await runtime.health(app.id)).dependencies).toMatchObject({
    state: "dependency_boundary_invalid",
    can_start: false,
    can_install: false,
  });
});

test("main runtime revalidates a stale discovery checkout before reading or spawning", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    writeLockfile: true,
    withNodeModules: true,
    dependencies: { fixture: "1.0.0" },
  });
  const discovery = await discoverLaunchpadApps(root);
  const app = discovery.apps.find((candidate) => candidate.id === "test-company-demo-v1");
  expect(app).toBeDefined();
  const moduleRoot = join(root, "organizations", "TestCompany", "modules", "demo");
  const parkedModuleRoot = `${moduleRoot}.parked`;
  const foreignModuleRoot = join(root, "foreign-main-runtime");
  await cp(moduleRoot, foreignModuleRoot, { recursive: true });
  let swapped = false;
  let spawned = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "main-runtime-root-swap",
    discover: async () => {
      if (!swapped) {
        await rename(moduleRoot, parkedModuleRoot);
        await symlink(foreignModuleRoot, moduleRoot, process.platform === "win32" ? "junction" : "dir");
        swapped = true;
      }
      return discovery;
    },
    spawnProcess() {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  expect((await runtime.health(app.id)).dependencies).toMatchObject({
    state: "dependency_boundary_invalid",
    can_start: false,
    can_install: false,
  });
  await expect(runtime.start(app.id)).rejects.toMatchObject({
    status: 409,
    code: "app_not_ready",
    metadata: { failure_kind: "dependency_boundary_invalid" },
  });
  expect(spawned).toBe(false);
});

test("peer a optional dependencies samy neblokují Start", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    peerDependencies: { peer: "1.0.0" },
    optionalDependencies: { optional: "1.0.0" },
    writeLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  expect((await runtime.health("test-company-demo-v1")).dependencies).toMatchObject({
    state: "ready",
    required_dependency_count: 0,
    missing_required_dependencies: [],
    can_start: true,
  });
});

test("runtime manager Repair vždy odstraní node_modules a provede čistý frozen install", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    writeLockfile: true,
    withNodeModules: true,
    staleLockfile: true,
  });
  const runtimeWithNoopInstall = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([
          process.execPath,
          "-e",
          `if (await Bun.file('node_modules/old.txt').exists()) process.exit(91); ${fixtureDependencyInstallScript("await Bun.write('node_modules/new.txt', 'fresh\\n')")}`,
        ], options)
      : spawnFixtureChild(root, command, options),
  });

  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(join(appRoot, "node_modules", "old.txt"), "stale\n");
  expect((await runtimeWithNoopInstall.health("test-company-demo-v1")).dependencies.state).toBe("ready");

  const result = await runtimeWithNoopInstall.install("test-company-demo-v1", { action: "repair" });

  expect(result.action).toBe("repair");
  expect(result.mode).toBe("clean");
  expect(result.removed_node_modules).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.log_excerpt).toContain("repair test-company-demo-v1 code=0");
  expect(result.runtime.dependencies.state).toBe("ready");
  expect((await runtimeWithNoopInstall.health("test-company-demo-v1")).dependencies.state).toBe("ready");
  expect(existsSync(join(appRoot, "node_modules", "old.txt"))).toBe(false);
  expect(await readFile(join(appRoot, "node_modules", "new.txt"), "utf8")).toBe("fresh\n");
});

test("runtime manager dependency model hlásí missing package a unknown package manager", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    packageManager: "pnpm@9.0.0",
    dependencies: { "@fixture/pnpm": "1.0.0" },
    withNodeModules: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("unknown_package_manager");
  expect(health.dependencies.package_manager).toBe("pnpm");
  expect(health.dependencies.can_install).toBe(false);
  await expect(runtime.install("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_install_unavailable",
  });

  const [missing] = await runtime.appsWithRuntime([
    {
      id: "missing-package-demo",
      title: "Missing package demo",
      company: "test-company",
      module: "demo",
      surface: "internal",
      port: await findFreePort(),
      host: "127.0.0.1",
      health_path: "/health",
      dev_script: "dev",
      package_path: "organizations/TestCompany/modules/missing/app/v1/package.json",
      cwd: "organizations/TestCompany/modules/missing/app/v1",
      tags: ["test"],
    },
  ]);
  expect(missing.dependencies.state).toBe("missing_package");
  expect(missing.dependencies.can_install).toBe(false);
});

test("chybějící dependency bez exact lockfilu vede k repair diagnostice bez Install capability", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    packageManager: "bun@1.4.0",
    dependencies: { fixture: "1.0.0" },
    writeLockfile: false,
    withNodeModules: false,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "missing-lockfile",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies).toMatchObject({
    state: "missing_lockfile",
    package_manager: "bun",
    package_manager_source: "missing_lockfile",
    install_command: null,
    install_command_display: null,
    can_install: false,
    can_start: false,
  });
  expect(health.dependencies.message).toContain("Vytvoř a commitni lockfile");
});

test("runtime manager nenabídne Bun Install nad cizím lockfilem", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    packageManager: "bun@1.3.0",
    dependencies: { fixture: "1.0.0" },
    withNodeModules: true,
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(join(appRoot, "package-lock.json"), "{}\n", "utf8");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "package-manager-lockfile-mismatch",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies).toMatchObject({
    state: "unknown_package_manager",
    package_manager: "bun",
    lockfile: { path: "package-lock.json", package_manager: "npm" },
    can_install: false,
  });
  expect(health.dependencies.message).toContain("neodpovídá vybranému package-lock.json");
  await expect(runtime.install("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_install_unavailable",
  });
});

test("legacy runtime still blocks on an occupied unhealthy port without a static lease", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  // Cizí PROCES (ne tenhle test proces — jinak resolvePortOwner vrátí null kvůli
  // pid === process.pid) obsadí app port raw TCP listenerem, který nemluví HTTP →
  // health probe je unreachable, runtime je unhealthy s port_owner. open() nesmí
  // tiše fallbacknout: musí propadnout do start() → startConflictForRuntime →
  // blokující 409 app_port_conflict.
  const squatter = spawnFixtureChild(root,
    [
      "bun",
      "-e",
      "const net=require('net');net.createServer((s)=>{}).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('squatting'));setInterval(()=>{},2147483647);",
    ],
    {
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  try {
    // Počkej, až listener obsadí port (raw TCP → connect uspěje).
    await waitForTcpListen(port);

    const health = await runtime.health("test-company-demo-v1");
    expect(health.status).toBe("unhealthy");
    expect(["adopted-port", "foreign-port", "unknown-port"]).toContain(health.owner);

    await expect(runtime.open("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "runtime_listener_preflight_failed",
    });

    // Squatter běží dál — open ho nesmí zabít ani přepsat.
    expect(squatter.killed).toBe(false);
  } finally {
    await killFixtureProcess(squatter, root);
  }
}, platformTestTimeout(10_000));

test("Lazurio static lease reclaims a foreign port and replaces it with the declared module", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port }), [
    runtimeListener("web", "entrypoint", port),
  ]);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "lease-owner-instance",
    discover: discoveryWithApp(app),
  });
  const squatter = spawnFixtureChild(root,
    [
      "bun",
      "-e",
      "const net=require('net');net.createServer(()=>{}).listen(Number(process.env.PORT),'127.0.0.1');setInterval(()=>{},2147483647);",
    ],
    {
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
    },
  );
  try {
    await waitForTcpListen(port);
    const result = await runtime.open(app.id);
    expect(result.url).toBe(`http://127.0.0.1:${port}`);
    expect(result.runtime.owner).toBe("current-instance");
    expect(result.steps.some((step) => step.step === "start")).toBe(true);
    const takeoverAudit = JSON.parse((await readFile(
      join(root, "launchpad", "runtime", "audit", "takeovers.jsonl"),
      "utf8",
    )).trim());
    expect(takeoverAudit).toMatchObject({
      schema_version: "lazurio.runtime_takeover_audit.v1",
      company: "test-company",
      module: "demo",
      app_id: app.id,
      runtime_source: { type: "main" },
      reclaimed_listeners: [{ previous_pid: squatter.pid }],
    });
    expect(takeoverAudit.listeners.every((listener) => listener.owned)).toBe(true);
    await expect(Promise.race([
      squatter.exited.then(() => true),
      sleep(2_000).then(() => false),
    ])).resolves.toBe(true);
    await runtime.stop(app.id);
  } finally {
    await killFixtureProcess(squatter, root);
  }
}, platformTestTimeout(15_000));

test("runtime manager vrátí konkrétní log excerpt, když appka spadne hned po startu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "console.error('fixture missing dependency: Cannot find package @missing/demo');",
      "process.exit(42);",
      "",
    ].join("\n"),
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  let failure;
  try {
    await runtime.start("test-company-demo-v1");
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    status: 500,
    code: "app_start_failed",
  });
  expect(["unknown_early_exit", "missing_dependencies"]).toContain(failure.metadata.failure_kind);
  await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
    status: 500,
    code: "app_start_failed",
  });
  const health = await runtime.health("test-company-demo-v1");
  expect(["unknown_early_exit", "missing_dependencies"]).toContain(health.failure_kind);
  expect(health.message).toMatch(/Otevři Logs|Použij Install\/Repair/);
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.content).toContain("exit test-company-demo-v1");
});

test("runtime manager open chain spustí ready aplikaci a vrátí URL", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const result = await runtime.open("test-company-demo-v1");
  expect(result.action).toBe("open");
  expect(result.url).toBe(`http://127.0.0.1:${port}`);
  expect(result.steps.some((step) => step.step === "start")).toBe(true);
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");

  // Idempotence: druhé open na běžící appce jen vrátí URL (reuse), nespouští znovu.
  const again = await runtime.open("test-company-demo-v1");
  expect(again.url).toBe(`http://127.0.0.1:${port}`);
  expect(again.steps.some((step) => step.step === "reuse")).toBe(true);

  await runtime.stop("test-company-demo-v1");
}, platformTestTimeout(15_000));

test("runtime manager open chain odmítne proces, který spadne hned po prvním healthy response", async () => {
  const port = await findFreePort();
  const blockedPort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "console.log(`fixture listening ${server.port}`);",
      "setTimeout(() => {",
      `  console.error('fixture sidecar failed: Failed to start server. Is port ${blockedPort} in use? EADDRINUSE');`,
      "  server.stop(true);",
      "  process.exit(1);",
      "}, 1200);",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  let failure;
  try {
    await runtime.open("test-company-demo-v1");
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    status: 500,
    code: "app_start_failed",
  });
  expect(failure.metadata.failure_kind).toBe("port_conflict");
  expect(failure.message).toContain("EADDRINUSE");
  expect(failure.message).toContain(String(blockedPort));
});

test("runtime manager replaces main with one worktree instance on the same declared ports", async () => {
  const mainPort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: mainPort });
  const orgRoot = join(root, "organizations", "TestCompany");
  const mainModuleRoot = join(orgRoot, "modules", "demo");
  const worktreeSlug = "CAC-0042-demo-runtime-selector";
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "demo", worktreeSlug);
  await mkdir(join(orgRoot, ".worktrees", "workspace", "demo"), { recursive: true });
  await mkdir(join(orgRoot, "mission-control", "plans", "2026", "07"), { recursive: true });
  await cp(mainModuleRoot, worktreeRoot, { recursive: true });
  await declareFixtureLazurioRuntime(worktreeRoot);
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-demo-runtime-selector.yaml"),
    "dev_code: CAC-0042\ntitle: Demo runtime selector\nstatus: in_progress\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "demo", `${worktreeSlug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    organization: "TestCompany",
    organization_path: "organizations/TestCompany",
    workspace: "workspace",
    module: "demo",
    module_path: "modules/demo",
    repo_kind: "module",
    base_branch: "main",
    branch: "CAC-0042-demo-runtime-selector",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-demo-runtime-selector.yaml",
    worktree_path: ".worktrees/workspace/demo/CAC-0042-demo-runtime-selector",
    created_at: "2026-07-04T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port: mainPort }), [
    runtimeListener("web", "entrypoint", mainPort),
  ]);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    discover: discoveryWithApp(app),
  });

  await expect(runtime.open("test-company-demo-v1", {
    source: { type: "worktree", slug: "../not-a-canonical-worktree" },
  })).rejects.toMatchObject({ status: 400, code: "invalid_runtime_source" });

  const main = await runtime.open("test-company-demo-v1");
  const worktree = await runtime.open("test-company-demo-v1", {
    source: { type: "worktree", slug: worktreeSlug },
  });

  expect(main.url).toBe(`http://127.0.0.1:${mainPort}`);
  expect(worktree.url).toBe(main.url);
  expect(worktree.runtime_source).toMatchObject({
    type: "worktree",
    slug: worktreeSlug,
    plan_code: "CAC-0042",
    branch: "CAC-0042-demo-runtime-selector",
  });
  expect(worktree.runtime.runtime_source.type).toBe("worktree");
  expect(worktree.runtime.runtime_key).toBe(`test-company-demo-v1--worktree--${worktreeSlug}`);
  expect(worktree.runtime.port).toBe(mainPort);
  expect(worktree.runtime.listeners).toHaveLength(1);
  expect(worktree.runtime.listeners.every((listener) => listener.allocation === "static")).toBe(true);
  expect(worktree.runtime.listeners.map((listener) => listener.port)).toEqual([mainPort]);
  expect(worktree.runtime.dependencies.cwd).toContain(`.worktrees/workspace/demo/${worktreeSlug}/app/v1`);
  const worktreeEnv = await (await fetch(`${worktree.url}/runtime-env`)).json();
  expect(worktreeEnv.organizationRoot).toBe(await realpath(orgRoot));
  expect(worktreeEnv.nodePath).toBe(join(await realpath(worktreeRoot), "app", "v1", "node_modules"));
  expect(worktreeEnv.listeners.map((listener) => listener.port).sort()).toEqual(
    worktree.runtime.listeners.map((listener) => listener.port).sort(),
  );
  expect((await runtime.health("test-company-demo-v1")).owner).not.toBe("current-instance");

  const stoppedAfterClientReload = await runtime.stop("test-company-demo-v1", {
    source: { type: "main" },
  });
  expect(stoppedAfterClientReload).toMatchObject({
    action: "stop",
    runtime_source: { type: "worktree", slug: worktreeSlug },
  });
}, platformTestTimeout(15_000));

test("worktree Start materializes its explicit contract while main is still legacy", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const { slug } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6439-contract-adoption",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "worktree-contract-adoption",
  });
  const squatter = spawnFixtureChild(root,
    [
      "bun",
      "-e",
      "const net=require('net');net.createServer(()=>{}).listen(Number(process.env.PORT),'127.0.0.1');setInterval(()=>{},2147483647);",
    ],
    {
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
    },
  );
  try {
    await waitForTcpListen(port);
    const result = await runtime.open("test-company-demo-v1", {
      source: { type: "worktree", slug },
    });
    expect(result.url).toBe(`http://127.0.0.1:${port}`);
    expect(result.runtime_source).toMatchObject({ type: "worktree", slug });
    expect(result.runtime).toMatchObject({
      owner: "current-instance",
      host: "127.0.0.1",
      port,
      runtime_source: { type: "worktree", slug },
    });
    expect(result.runtime.listeners).toEqual([
      expect.objectContaining({
        id: "web",
        allocation: "static",
        host: "127.0.0.1",
        port,
      }),
    ]);
    expect(result.runtime.dependencies.cwd).toContain(`.worktrees/workspace/demo/${slug}/app/v1`);
    const takeoverAudit = JSON.parse((await readFile(
      join(root, "launchpad", "runtime", "audit", "takeovers.jsonl"),
      "utf8",
    )).trim());
    expect(takeoverAudit).toMatchObject({
      company: "test-company",
      module: "demo",
      app_id: "test-company-demo-v1",
      runtime_source: { type: "worktree", slug },
      reclaimed_listeners: [{ previous_pid: squatter.pid }],
    });
    await runtime.stop("test-company-demo-v1", {
      source: { type: "worktree", slug },
    });
  } finally {
    await killFixtureProcess(squatter, root);
  }
}, platformTestTimeout(15_000));

test.skipIf(process.platform === "win32")("worktree runtime reads package and Module manifests only inside the selected checkout", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const { slug, worktreeRoot } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6439-authority-boundary",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "worktree-authority-boundary",
  });
  const packagePath = join(worktreeRoot, "app", "v1", "package.json");
  const modulePath = join(worktreeRoot, "lazurio.module.json");
  const originalPackage = await readFile(packagePath, "utf8");
  const originalModule = await readFile(modulePath, "utf8");
  const foreignRoot = join(root, "organizations", "OtherCompany", "workspace", "foreign-worktree-authority");
  await mkdir(foreignRoot, { recursive: true });
  await writeFile(join(foreignRoot, "package.json"), originalPackage);
  await writeFile(join(foreignRoot, "lazurio.module.json"), originalModule);

  await rm(packagePath);
  await symlink(join(foreignRoot, "package.json"), packagePath, "file");
  const packageError = await runtime.start("test-company-demo-v1", {
    source: { type: "worktree", slug },
  }).catch((error) => error);
  expect(packageError).toMatchObject({
    status: 409,
    code: "invalid_worktree_runtime_contract",
  });
  expect(packageError.details.join("\n")).toContain("package autoritu nelze bezpečně načíst");

  await rm(packagePath);
  await writeFile(packagePath, originalPackage);
  await rm(modulePath);
  await symlink(join(foreignRoot, "lazurio.module.json"), modulePath, "file");
  const moduleError = await runtime.start("test-company-demo-v1", {
    source: { type: "worktree", slug },
  }).catch((error) => error);
  expect(moduleError).toMatchObject({
    status: 409,
    code: "invalid_worktree_runtime_contract",
  });
  expect(moduleError.details.join("\n")).toContain("odkazuje mimo vybraný checkout");
});

test("worktree runtime znovu ukotví selected root po indexaci", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const { slug, worktreeRoot } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6439-root-swap",
  });
  const foreignRoot = join(root, "foreign-worktree-swap");
  const parkedWorktree = `${worktreeRoot}.parked`;
  await cp(worktreeRoot, foreignRoot, { recursive: true });
  let swapped = false;
  let spawnCalls = 0;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "worktree-root-swap",
    buildWorktreeIndexFn: async (options) => {
      const index = await buildWorktreeIndex(options);
      if (!swapped) {
        await rename(worktreeRoot, parkedWorktree);
        await symlink(foreignRoot, worktreeRoot, process.platform === "win32" ? "junction" : "dir");
        swapped = true;
      }
      return index;
    },
    spawnProcess() {
      spawnCalls += 1;
      throw new Error("foreign lifecycle must not start");
    },
  });

  try {
    const error = await runtime.start("test-company-demo-v1", {
      source: { type: "worktree", slug },
    }).catch((cause) => cause);
    expect(error).toMatchObject({
      status: 409,
      code: "invalid_worktree_runtime_contract",
    });
    expect(error.details.join("\n")).toContain("odkazuje mimo canonical Organization root");
    expect(spawnCalls).toBe(0);
  } finally {
    if (swapped) {
      await rm(worktreeRoot, { recursive: true, force: true });
      await rename(parkedWorktree, worktreeRoot);
    }
  }
});

test("worktree Start rejects a lease that drifts from an explicit main contract", async () => {
  const port = await findFreePort();
  const driftPort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withRuntimeListeners(fixtureDiscoveryApp({ port }), [
    runtimeListener("web", "entrypoint", port),
  ]);
  app.module_contract.port_leases = [{ id: "main", host: "127.0.0.1", port }];
  const { slug, worktreeRoot } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6439-contract-drift",
  });
  const manifestPath = join(worktreeRoot, "lazurio.module.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.port_leases[0].port = driftPort;
  await writeJson(manifestPath, manifest);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "worktree-contract-drift",
    discover: discoveryWithApp(app),
  });

  await expect(runtime.start(app.id, {
    source: { type: "worktree", slug },
  })).rejects.toMatchObject({
    status: 409,
    code: "invalid_worktree_runtime_contract",
    metadata: { failure_kind: "invalid_worktree_runtime_contract", worktree_slug: slug },
  });
  await expect(runtime.health(app.id, {
    source: { type: "worktree", slug },
  })).rejects.toMatchObject({
    code: "invalid_worktree_runtime_contract",
  });
});

test("worktree Start validates its selected manifest script and proves the actual listener", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const { slug, worktreeRoot } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6439-port-authority",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "worktree-port-authority",
  });
  const packagePath = join(worktreeRoot, "app", "v1", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts.dev = `bun server.mjs --port ${port}`;
  await writeJson(packagePath, packageJson);

  const scriptError = await runtime.start("test-company-demo-v1", {
    source: { type: "worktree", slug },
  }).catch((error) => error);
  expect(scriptError).toMatchObject({
    status: 409,
    code: "invalid_worktree_runtime_contract",
  });
  expect(scriptError.details.join("\n")).toContain(
    `scripts.dev obsahuje číselný port ${port}`,
  );

  packageJson.scripts.dev = "bun server.mjs";
  packageJson.scripts.serve = "bun server.mjs --port $PORT";
  packageJson.lazurio.runtime.dev_script = "serve";
  await writeJson(packagePath, packageJson);
  const customScriptError = await runtime.start("test-company-demo-v1", {
    source: { type: "worktree", slug },
  }).catch((error) => error);
  expect(customScriptError).toMatchObject({
    status: 409,
    code: "invalid_worktree_runtime_contract",
  });
  expect(customScriptError.details.join("\n")).toContain(
    "scripts.serve používá obecné HOST/PORT",
  );

  packageJson.scripts.dev = "bun server.mjs";
  packageJson.lazurio.runtime.dev_script = "dev";
  delete packageJson.scripts.serve;
  await writeJson(packagePath, packageJson);
  await writeFile(
    join(worktreeRoot, "app", "v1", "server.mjs"),
    `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? ${port}), fetch: () => new Response("ok") });\n`,
    "utf8",
  );
  try {
    const started = await runtime.start("test-company-demo-v1", {
      source: { type: "worktree", slug },
    });
    expect(["starting", "healthy"]).toContain(started.runtime.status);
    const healthy = await waitForStatus(
      () => runtime.health("test-company-demo-v1", { source: { type: "worktree", slug } }),
      "healthy",
    );
    expect(healthy.listener_reconciliation?.status ?? "ok").toBe("ok");
  } finally {
    await runtime.stop("test-company-demo-v1", {
      source: { type: "worktree", slug },
    }).catch(() => {});
  }
});

test("hosted maintenance starts the discovered App, rejects Stop and retires removed Modules", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-maintenance",
    lifecycleProfile: "hosted",
    discover: discoveryWithApp(app),
    maintenanceIntervalMs: 10,
    maintenanceRetryDelaysMs: [10],
  });

  try {
    expect(() => runtime.maintainApps([app.id])).toThrow("requires discovered App records");
    expect(runtime.maintainApps([app])).toMatchObject({ total: 1, starting: 1 });
    const healthy = await waitForStatus(() => runtime.health(app.id), "healthy");
    expect(healthy).toMatchObject({
      managed: true,
      maintenance: {
        configured_app_id: app.id,
        app_id: app.id,
        module_lease_key: "test-company/demo",
        source: { type: "main" },
      },
    });
    await expect(runtime.stop(app.id)).rejects.toMatchObject({
      code: "hosted_module_always_on",
      metadata: { failure_kind: "hosted_module_always_on" },
    });

    runtime.maintainApps([]);
    await waitForStatus(() => runtime.health(app.id), "stopped");
    expect(runtime.maintenanceSummary()).toMatchObject({ total: 0 });
  } finally {
    await runtime.shutdown();
  }
}, platformTestTimeout(15_000));

test("hosted inventory projects the worktree selected for the current Launchpad session", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const { slug } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6513-session-projection",
  });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-session-projection",
    lifecycleProfile: "hosted",
    discover: discoveryWithApp(app),
    maintenanceIntervalMs: 10,
    maintenanceRetryDelaysMs: [10],
  });

  try {
    runtime.maintainApps([app]);
    await waitForStatus(() => runtime.health(app.id), "healthy");
    await runtime.open(app.id, { source: { type: "worktree", slug } });

    const [projected] = await runtime.appsWithRuntime([app]);
    expect(projected.runtime).toMatchObject({
      status: "healthy",
      runtime_source: { type: "worktree", slug },
      maintenance: { source: { type: "worktree", slug }, status: "healthy" },
      maintenance_alignment: "matches",
    });
  } finally {
    await runtime.shutdown();
  }
}, platformTestTimeout(15_000));

test("hosted maintenance rejects a non-default App before changing the maintained Module", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const defaultApp = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const siblingApp = withStaticEntrypoint(fixtureDiscoveryApp({
    port,
    overrides: {
      id: "test-company-demo-v2",
      title: "Demo v2",
    },
  }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-default-app",
    lifecycleProfile: "hosted",
    discover: discoveryWithApps(defaultApp, siblingApp),
    maintenanceIntervalMs: 10,
    maintenanceRetryDelaysMs: [10],
  });

  try {
    runtime.maintainApps([defaultApp]);
    const healthy = await waitForStatus(() => runtime.health(defaultApp.id), "healthy");
    for (const action of [
      () => runtime.start(siblingApp.id),
      () => runtime.open(siblingApp.id),
      () => runtime.restart(siblingApp.id),
      () => runtime.switchApp(siblingApp.id, {
        replace_app_id: defaultApp.id,
        confirmed: true,
      }),
    ]) {
      await expect(action()).rejects.toMatchObject({
        code: "hosted_module_default_app_required",
        metadata: {
          failure_kind: "hosted_module_default_app_required",
          configured_app_id: defaultApp.id,
        },
      });
    }
    expect(await runtime.health(siblingApp.id)).not.toHaveProperty("maintenance");
    expect(await runtime.health(defaultApp.id)).toMatchObject({
      pid: healthy.pid,
      maintenance: {
        configured_app_id: defaultApp.id,
        app_id: defaultApp.id,
        source: { type: "main" },
        status: "healthy",
      },
    });
  } finally {
    await runtime.shutdown();
  }
}, platformTestTimeout(15_000));

test("hosted maintenance never installs dependencies during boot and keeps retrying the exact source", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
  });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const appRoot = join(root, app.cwd);
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-no-boot-install",
    lifecycleProfile: "hosted",
    discover: discoveryWithApp(app),
    maintenanceIntervalMs: 5,
    maintenanceRetryDelaysMs: [5],
  });

  try {
    runtime.maintainApps([app]);
    const degraded = await waitForRuntime(
      () => runtime.health(app.id),
      (state) => state.maintenance?.status === "degraded",
    );
    expect(degraded).toMatchObject({
      status: "degraded",
      managed: false,
      maintenance: {
        source: { type: "main" },
        failure_kind: "app_not_ready",
      },
    });
    expect(existsSync(join(appRoot, "node_modules"))).toBe(false);
  } finally {
    await runtime.shutdown();
  }
});

test("hosted maintenance backs off while an exact runtime source is still starting", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "const startedAt = Date.now();",
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health' && Date.now() - startedAt < 2500) return new Response('building', { status: 404 });",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-start-backoff",
    lifecycleProfile: "hosted",
    discover: discoveryWithApp(app),
    maintenanceIntervalMs: 10,
    maintenanceRetryDelaysMs: [500, 1_000, 2_000],
  });

  try {
    runtime.maintainApps([app]);
    const retrying = await waitForRuntime(
      () => runtime.maintenanceSummary().apps[0],
      (state) => state?.status === "starting" && state.attempts > 0,
    );
    expect(Date.parse(retrying.next_attempt_at)).toBeGreaterThan(Date.now());
    expect(await waitForStatus(() => runtime.health(app.id), "healthy")).toMatchObject({
      managed: true,
      maintenance: { status: "healthy", attempts: 0 },
    });
  } finally {
    await runtime.shutdown();
  }
}, platformTestTimeout(15_000));

test("hosted shutdown drains an overlapping maintenance pass before taking the child snapshot", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  let releaseFirstLock;
  let reportFirstLock;
  let firstLock = true;
  let spawnCount = 0;
  const firstLockEntered = new Promise((resolveEntered) => {
    reportFirstLock = resolveEntered;
  });
  const firstLockGate = new Promise((resolveGate) => {
    releaseFirstLock = resolveGate;
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-shutdown-overlap",
    lifecycleProfile: "hosted",
    discover: discoveryWithApp(app),
    maintenanceIntervalMs: 5,
    acquireModuleLockFn: async () => {
      if (firstLock) {
        firstLock = false;
        reportFirstLock();
        await firstLockGate;
      }
      return { release: async () => {} };
    },
    spawnProcess: (...args) => {
      spawnCount += 1;
      return Bun.spawn(...args);
    },
  });

  runtime.maintainApps([app]);
  await firstLockEntered;
  let shutdownSettled = false;
  const shutdown = runtime.shutdown().then((result) => {
    shutdownSettled = true;
    return result;
  });
  await sleep(20);
  expect(shutdownSettled).toBe(false);
  releaseFirstLock();
  expect(await shutdown).toMatchObject({ attempted: 0, stopped: 0, failed: 0 });
  expect(spawnCount).toBe(0);
});

test("hosted maintenance restores an unexpectedly exited App from the same session source", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: controlledExitServerSource(),
  });
  const { slug, worktreeRoot } = await createOwnedWorktreeFixture({
    root,
    slug: "DEV-6513-exit-recovery",
  });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const exitMarker = join(worktreeRoot, "app", "v1", ".launchpad-exit-now");
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "hosted-exit-recovery",
    lifecycleProfile: "hosted",
    discover: discoveryWithApp(app),
    maintenanceIntervalMs: 10,
    maintenanceRetryDelaysMs: [10],
  });

  try {
    runtime.maintainApps([app]);
    await waitForStatus(() => runtime.health(app.id), "healthy");
    await runtime.open(app.id, { source: { type: "worktree", slug } });
    const initial = await waitForStatus(
      () => runtime.health(app.id, { source: { type: "worktree", slug } }),
      "healthy",
    );
    await writeFile(exitMarker, "exit managed child\n", "utf8");
    const recovered = await waitForRuntime(
      () => runtime.health(app.id, { source: { type: "worktree", slug } }),
      (state) => state.status === "healthy" && state.pid !== initial.pid,
      300,
    );
    expect(recovered).toMatchObject({
      managed: true,
      runtime_source: { type: "worktree", slug },
      maintenance: { source: { type: "worktree", slug }, status: "healthy" },
    });
  } finally {
    await runtime.shutdown();
  }
}, platformTestTimeout(15_000));

test("local Restart and Stop serialize on the module lease without persistent intent", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = withStaticEntrypoint(fixtureDiscoveryApp({ port }));
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "concurrent-local-session-lifecycle",
    discover: discoveryWithApp(app),
  });

  await runtime.start(app.id, { source: { type: "main" } });
  const [restarted, stopped] = await Promise.all([
    runtime.restart(app.id, { source: { type: "main" } }),
    runtime.stop(app.id, { source: { type: "main" } }),
  ]);
  expect(restarted.action).toBe("restart");
  expect(stopped.action).toBe("stop");
  expect(stopped).not.toHaveProperty("maintenance");
  expect(await runtime.health(app.id)).toMatchObject({
    status: "stopped",
    managed: false,
  });
}, platformTestTimeout(15_000));

test("runtime manager open chain nejdřív nainstaluje chybějící balíčky", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "left-pad": "^1.0.0" },
    writeLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => command.slice(1).includes("install")
      ? Bun.spawn([
          process.execPath,
          "-e",
          "await (await import('node:fs/promises')).mkdir('node_modules/left-pad', { recursive: true }); await Bun.write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', version: '1.0.0' })); await Bun.write('node_modules/left-pad/index.js', 'export default {}\\n')",
        ], options)
      : spawnFixtureChild(root, command, options),
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("needs_install");

  const result = await runtime.open("test-company-demo-v1");
  expect(result.steps[0].step).toBe("install");
  expect(result.steps[0].exit_code).toBe(0);
  expect(result.steps.some((step) => step.step === "start")).toBe(true);
  expect(result.url).toBe(`http://127.0.0.1:${port}`);

  await runtime.stop("test-company-demo-v1");
}, platformTestTimeout(15_000));

test("Mission Control s planned data slotem se zastaví před startem procesu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    moduleSlots: [
      {
        path: "mission-control/db",
        slug: "mission-control-data",
        category: "planning-data",
        default_access: "expected",
        required_roles: ["organization-admin"],
        source_of_truth: "repository-db:v3",
        space: "root",
        status: "planned_slot",
      },
    ],
    appOverrides: {
      title: "BNO & LJ Mission Control",
      module: "mission-control",
      required_module_slots: ["mission-control/db"],
      tags: ["mission-control", "repository-db"],
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies).toMatchObject({
    state: "planned_slot",
    can_start: false,
    can_install: false,
  });
  expect(health.dependencies.message).toContain("repozitář ručně neklonuj");

  await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_ready",
    metadata: { failure_kind: "planned_slot" },
  });
  expect((await runtime.health("test-company-demo-v1")).managed).toBe(false);
});

test("runtime open po exit 0 neodstartuje aplikaci s pořád neúplným stromem", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { fixture: "1.0.0" },
    writeLockfile: true,
  });
  let runtimeSpawned = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => {
      if (command.slice(1).includes("install")) {
        return Bun.spawn([
          process.execPath,
          "-e",
          "await (await import('node:fs/promises')).mkdir('node_modules', { recursive: true }); process.exit(0)",
        ], options);
      }
      runtimeSpawned = true;
      return spawnFixtureChild(root, command, options);
    },
  });

  await expect(runtime.open("test-company-demo-v1")).rejects.toMatchObject({
    code: "app_install_failed",
    metadata: {
      failure_kind: "dependency_install_incomplete",
      missing_required_dependencies: ["fixture"],
    },
  });
  expect(runtimeSpawned).toBe(false);
});

test("runtime manager vrací 404 pro aplikaci mimo discovery", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  await expect(runtime.health("unknown-app")).rejects.toBeInstanceOf(RuntimeActionError);
  await expect(runtime.health("unknown-app")).rejects.toMatchObject({
    status: 404,
    code: "app_not_found",
  });
});

async function createCompaniesWorkspaceFixture({
  port,
  serverSource = null,
  packageManager = null,
  dependencies = null,
  devDependencies = null,
  optionalDependencies = null,
  peerDependencies = null,
  writeLockfile = false,
  withNodeModules = false,
  staleLockfile = false,
  installScripts = {},
  appOverrides = {},
  moduleSlots = [{
    path: "modules/demo",
    slug: "demo",
    git: { url: "git@github.com:TestCompany/demo.git", branch: "main" },
  }],
}) {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-launchpad-"));
  registerTempRoot(root, { port });
  const companyRoot = join(root, "organizations", "TestCompany");
  const appRoot = join(companyRoot, "modules", "demo", "app", "v1");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });

  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  // Scan-first: identity comes from the normalized Organization resource.
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: {
      slug: "test-company",
      display_name: "Test Company",
      github_org: "TestCompany",
    },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: moduleSlots,
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const packageJson = {
    name: "test-company-demo-v1",
    private: true,
    type: "module",
    ...(packageManager ? { packageManager } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(devDependencies ? { devDependencies } : {}),
    ...(optionalDependencies ? { optionalDependencies } : {}),
    ...(peerDependencies ? { peerDependencies } : {}),
    scripts: {
      ...installScripts,
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
        port,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["test"],
        ...appOverrides,
      },
    },
  };
  await writeJson(join(appRoot, "package.json"), packageJson);
  if (writeLockfile) {
    await writeFile(join(appRoot, "bun.lock"), [
      "{",
      '  "lockfileVersion": 1,',
      '  "configVersion": 1,',
      '  "workspaces": { "": { "name": "test-company-demo-v1" } },',
      '  "packages": {},',
      "}",
      "",
    ].join("\n"), "utf8");
  }
  if (withNodeModules) {
    await mkdir(join(appRoot, "node_modules"), { recursive: true });
    const requiredDependencies = [...new Set([
      ...Object.keys(dependencies ?? {}),
      ...Object.keys(devDependencies ?? {}),
    ])];
    for (const dependencyName of requiredDependencies) {
      const dependencyRoot = join(appRoot, "node_modules", ...dependencyName.split("/"));
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(
        join(dependencyRoot, "package.json"),
        JSON.stringify({ name: dependencyName, version: "1.0.0" }),
      );
    }
  }
  if (staleLockfile) {
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date();
    await utimes(join(appRoot, "bun.lock"), oldTime, oldTime);
    await utimes(join(appRoot, "package.json"), newTime, newTime);
  }
  await writeFile(
    join(appRoot, "server.mjs"),
    serverSource ?? [
      "const server = Bun.serve({",
      "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
      "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    if (url.pathname === '/runtime-env') return Response.json({ organizationRoot: process.env.COMPANYASCODE_ORGANIZATION_ROOT ?? null, nodeEnv: process.env.NODE_ENV ?? null, nodePath: process.env.NODE_PATH ?? null, runtimeHost: process.env.LAZURIO_RUNTIME_HOST ?? null, runtimePort: process.env.LAZURIO_RUNTIME_PORT ?? null, listeners: JSON.parse(process.env.LAZURIO_RUNTIME_LISTENERS_JSON ?? '[]'), astroDevBackground: process.env.ASTRO_DEV_BACKGROUND ?? null, astroPreviewBackground: process.env.ASTRO_PREVIEW_BACKGROUND ?? null });",
      "    return new Response('ok');",
      "  },",
      "});",
      "console.log(`fixture listening ${server.port}`);",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function fixtureDiscoveryApp({ port, overrides = {} }) {
  return {
    id: "test-company-demo-v1",
    title: "Demo v1",
    company: "test-company",
    module: "demo",
    surface: "internal",
    port,
    host: "127.0.0.1",
    health_path: "/health",
    dev_script: "dev",
    plugin: null,
    package_path: "organizations/TestCompany/modules/demo/app/v1/package.json",
    organization_path: "organizations/TestCompany",
    organization_kind: "organization",
    discovery_source: "filesystem",
    company_workspace_path: "organizations/TestCompany",
    cwd: "organizations/TestCompany/modules/demo/app/v1",
    tags: ["test"],
    ...overrides,
  };
}

function withStaticEntrypoint(app) {
  const entrypoint = {
    id: "web",
    role: "entrypoint",
    lease: "main",
    allocation: "static",
    host: app.host,
    port: app.port,
    protocol: "http",
    health: { kind: "http", path: app.health_path },
    claim: { mode: "exclusive" },
    module_lease: {
      id: "main",
      module_id: app.module,
      company: app.company,
      source: `${app.organization_path}/modules/${app.module}/lazurio.module.json`,
    },
  };
  return {
    ...app,
    listeners: [entrypoint],
    entrypoint_listener: entrypoint,
    module_contract: fixtureModuleContract(app),
    runtime_contract: {
      schema_version: "lazurio.runtime.v1",
      source: "lazurio.runtime",
      legacy: false,
      auxiliary_listeners_known: true,
      listeners: [entrypoint],
    },
  };
}

function runtimeListener(id, role, port, overrides = {}) {
  const allocation = overrides.allocation ?? "static";
  return {
    id,
    role,
    lease: id === "web" ? "main" : id,
    allocation,
    host: "127.0.0.1",
    ...(Number.isInteger(port) ? { port } : {}),
    protocol: "http",
    health: { kind: "http", path: role === "entrypoint" ? "/health" : "/api/health" },
    claim: { mode: "exclusive" },
    module_lease: {
      id: id === "web" ? "main" : id,
      module_id: "demo",
      company: "test-company",
      source: "organizations/TestCompany/modules/demo/lazurio.module.json",
    },
    ...overrides,
  };
}

function withRuntimeListeners(app, listeners) {
  const entrypoint = listeners.find((listener) => listener.role === "entrypoint");
  return {
    ...app,
    port: entrypoint.allocation === "static" ? entrypoint.port : null,
    host: entrypoint.host,
    health_path: entrypoint.health.path,
    listeners,
    entrypoint_listener: entrypoint,
    module_contract: fixtureModuleContract(app),
    runtime_contract: {
      schema_version: "lazurio.runtime.v1",
      source: "lazurio.runtime",
      legacy: false,
      auxiliary_listeners_known: true,
      listeners,
    },
  };
}

function fixtureModuleContract(app) {
  return {
    schema_version: "lazurio.module.v1",
    id: app.module,
    company: app.company,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: app.host, port: app.port }],
    module_path: `${app.organization_path}/modules/${app.module}/lazurio.module.json`,
  };
}

function withCrossOrganizationOverlap(...apps) {
  const owners = apps.map((app) => ({
    port: app.port,
    host: app.host,
    app_id: app.id,
    company: app.company,
    module: app.module,
    package_path: app.package_path,
    listener_id: app.entrypoint_listener.id,
    lease_id: app.entrypoint_listener.lease,
  }));
  return apps.map((app) => ({ ...app, shared_port_owners: owners }));
}

function discoveryWithApp(app) {
  return async () => ({ apps: [app], invalid_apps: [], failures: [], warnings: [] });
}

function discoveryWithApps(...apps) {
  return async () => ({ apps, invalid_apps: [], failures: [], warnings: [] });
}

async function createOwnedWorktreeFixture({ root, slug = "DEV-6439-hosted-parity" }) {
  const orgRoot = join(root, "organizations", "TestCompany");
  const mainModuleRoot = join(orgRoot, "modules", "demo");
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "demo", slug);
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "08", `${slug}.yaml`);
  await mkdir(join(orgRoot, ".worktrees", "workspace", "demo"), { recursive: true });
  await mkdir(join(orgRoot, "mission-control", "plans", "2026", "08"), { recursive: true });
  await cp(mainModuleRoot, worktreeRoot, { recursive: true });
  await declareFixtureLazurioRuntime(worktreeRoot);
  await writeFile(planPath, `dev_code: DEV-6439\ntitle: Hosted parity\nstatus: in_progress\n`, "utf8");
  await writeJson(join(orgRoot, ".worktrees", "workspace", "demo", `${slug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    organization: "TestCompany",
    organization_path: "organizations/TestCompany",
    workspace: "workspace",
    module: "demo",
    module_path: "modules/demo",
    repo_kind: "module",
    base_branch: "main",
    branch: `codex/${slug}`,
    mission_control_plan_code: "DEV-6439",
    mission_control_plan_path: `mission-control/plans/2026/08/${slug}.yaml`,
    worktree_path: `.worktrees/workspace/demo/${slug}`,
    created_at: "2026-08-13T00:00:00.000Z",
    created_by: "codex-for-test",
    status: "active",
  });
  return { slug, worktreeRoot };
}

async function declareFixtureLazurioRuntime(moduleRoot) {
  const packagePath = join(moduleRoot, "app", "v1", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const legacy = packageJson.companyascode?.app;
  if (!legacy) throw new Error(`Fixture ${packagePath} nemá legacy runtime pro migraci`);
  delete packageJson.companyascode;
  packageJson.lazurio = {
    runtime: {
      schema_version: "lazurio.runtime.v1",
      id: legacy.id,
      title: legacy.title,
      company: legacy.company,
      module: legacy.module,
      surface: legacy.surface,
      dev_script: legacy.dev_script,
      ...(legacy.preview_script ? { preview_script: legacy.preview_script } : {}),
      ...(legacy.build_script ? { build_script: legacy.build_script } : {}),
      tags: legacy.tags ?? [],
      listeners: [{
        id: "web",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: legacy.health_path ?? "/" },
      }],
    },
  };
  await writeJson(packagePath, packageJson);
  await writeJson(join(moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: legacy.module,
    company: legacy.company,
    tcp_port_policy: { mode: "single" },
    port_leases: [{
      id: "main",
      host: legacy.host === "localhost" ? "127.0.0.1" : legacy.host,
      port: legacy.port,
    }],
    apps: ["app/v1/package.json"],
    default_app: "app/v1/package.json",
  });
}

function controlledExitServerSource() {
  return [
    "import { existsSync, unlinkSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const marker = join(process.cwd(), '.launchpad-exit-now');",
    "const server = Bun.serve({",
    "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
    "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
    "    return new Response('ok');",
    "  },",
    "});",
    "const watcher = setInterval(() => {",
    "  if (!existsSync(marker)) return;",
    "  unlinkSync(marker);",
    "  clearInterval(watcher);",
    "  server.stop(true);",
    "  process.exit(7);",
    "}, 10);",
    "",
  ].join("\n");
}

function crashThenStayUnhealthyServerSource() {
  return [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const marker = join(import.meta.dir, '.crashed-once');",
    "const firstRun = !existsSync(marker);",
    "if (firstRun) writeFileSync(marker, 'crashed\\n');",
    "const server = Bun.serve({",
    "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
    "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname === '/health') return Response.json({ status: firstRun ? 'ok' : 'unhealthy' }, { status: firstRun ? 200 : 503 });",
    "    return new Response('ok');",
    "  },",
    "});",
    "if (firstRun) setTimeout(() => { server.stop(true); process.exit(7); }, process.platform === 'win32' ? 5000 : 1200);",
    "setInterval(() => {}, 2147483647);",
    "",
  ].join("\n");
}

async function writeJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function waitForStatus(readStatus, expectedStatus) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastStatus = await readStatus();
    if (lastStatus.status === expectedStatus) return lastStatus;
    await sleep(100);
  }
  throw new Error(`Čekal jsem status ${expectedStatus}, poslední byl ${lastStatus?.status}`);
}

async function waitForRuntime(readRuntime, predicate, attempts = 60) {
  let lastRuntime = null;
  const effectiveAttempts = process.platform === "win32" ? attempts * 3 : attempts;
  for (let attempt = 0; attempt < effectiveAttempts; attempt += 1) {
    lastRuntime = await readRuntime();
    if (predicate(lastRuntime)) return lastRuntime;
    await sleep(100);
  }
  throw new Error(`Runtime predicate was not reached: ${JSON.stringify(lastRuntime)}`);
}

async function waitForJson(path, predicate) {
  let lastValue = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      lastValue = JSON.parse(await readFile(path, "utf8"));
      if (predicate(lastValue)) return lastValue;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Čekal jsem na runtime state predicate, poslední state: ${JSON.stringify(lastValue)}`);
}

async function waitForFetch(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`Čekal jsem na ${url}`);
}

async function waitForTcpListen(port) {
  const { connect } = await import("net");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const connected = await new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`Port ${port} nezačal poslouchat`);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRuntimeManager(options) {
  const spawnProcess = options.spawnProcess ?? Bun.spawn;
  return createRuntimeManagerImpl({
    ...options,
    systemEnvironment: options.systemEnvironment
      ?? (options.platform === "win32" ? { SystemRoot: "C:\\Windows" } : process.env),
    spawnProcessIsNative: spawnProcess === Bun.spawn,
    spawnProcess(command, spawnOptions) {
      const child = spawnProcess(command, spawnOptions);
      registerFixtureChild(options.companiesRoot, child);
      return child;
    },
  });
}

function registerTempRoot(root, { port = null } = {}) {
  const caller = new Error("fixture owner").stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("runtime-lib.test.mjs")
      && !line.includes("registerTempRoot")
      && !line.includes("createCompaniesWorkspaceFixture"))
    ?? "unknown runtime-lib.test.mjs fixture";
  tempRoots.push({ root, port, owner: caller, children: [] });
}

function registerFixtureChild(root, child) {
  const fixture = tempRoots.find((candidate) => candidate.root === root);
  if (
    !fixture
    || !Number.isInteger(child?.pid)
    || !child?.exited?.then
    || typeof child.resourceUsage !== "function"
    || fixture.children.some((candidate) => candidate.child === child)
  ) return child;
  const trackedChild = {
    pid: child.pid,
    child,
    exitConfirmed: false,
    exited: Promise.resolve(child.exited).then(
      (exitCode) => {
        trackedChild.exitConfirmed = true;
        trackedChild.exitCode = exitCode;
        return exitCode;
      },
      (error) => {
        trackedChild.exitError = error;
        throw error;
      },
    ),
  };
  fixture.children.push(trackedChild);
  return child;
}

function spawnFixtureChild(root, command, options) {
  return registerFixtureChild(root, Bun.spawn(command, options));
}

async function removeTempRootAfterChildExit({ root, port, owner, children = [] }, {
  platform = process.platform,
  childExitAttempts = 21,
  rootRemovalAttempts = platform === "win32" ? 21 : 1,
  retryDelayMs = 100,
  removeFn = rm,
  sleepFn = sleep,
} = {}) {
  for (const child of children) {
    let exitResult = null;
    for (let attempt = 0; attempt < childExitAttempts; attempt += 1) {
      if (child.exitConfirmed) {
        exitResult = { exited: true, exitCode: child.exitCode };
        break;
      }
      exitResult = await Promise.race([
        Promise.resolve(child.exited).then(
          (exitCode) => ({ exited: true, exitCode }),
          (error) => ({ exited: false, error }),
        ),
        sleepFn(retryDelayMs).then(() => ({ exited: false })),
      ]);
      if (exitResult.exited) break;
    }
    if (!exitResult?.exited) {
      throw new Error(
        `Runtime fixture child survived its test: owner=${owner}; root=${root}; port=${port ?? "none"}; child_pid=${child.pid}`,
      );
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt < rootRemovalAttempts; attempt += 1) {
    try {
      await removeFn(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const retryable = platform === "win32"
        && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)
        && attempt < rootRemovalAttempts - 1;
      if (!retryable) break;
      await sleepFn(retryDelayMs);
    }
  }
  throw new Error(
    `Runtime fixture root remained owned after child exit: owner=${owner}; root=${root}; code=${lastError?.code ?? "unknown"}`,
    { cause: lastError },
  );
}

async function executeWindowsStopCommand(command) {
  if (process.platform === "win32") {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  }

  const pid = Number(command[command.indexOf("/PID") + 1]);
  try {
    // POSIX test double ověřuje command contract, ale nemá taskkill /T
    // process-tree semantics. SIGTERM nechá Bun parent korektně zavřít child
    // a pipe; skutečné /T /F chování ověřuje windows-latest.
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return { ok: true, exitCode: 0, stdout: "", stderr: "" };
}

async function killFixtureProcess(child, root) {
  if (!child) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  await Promise.resolve(child.exited).catch(() => {});
  const fixture = tempRoots.find((candidate) => candidate.root === root);
  const trackedChild = fixture?.children
    .find((candidate) => candidate.child === child);
  if (trackedChild) {
    trackedChild.exitConfirmed = true;
    trackedChild.exitCode = "confirmed-by-kill-fixture-process";
  } else if (fixture && typeof child.resourceUsage === "function") {
    throw new Error(`Fixture child PID ${child.pid ?? "unknown"} was not registered for root ${root}`);
  }
}
