import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePackageRuntime,
  runtimeListenerEnvironmentNames,
  validateDeclaredRuntime,
} from "../../lazurio/core/runtime-contract-lib.mjs";
import { validateAgainstSchema } from "../../lazurio/runtime/json-schema-mini.mjs";

const runtimeSchema = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "lazurio", "schemas", "lazurio-runtime.schema.json"), "utf8"),
);

test("listener environment names include the hosted external origin for both roles", () => {
  // Deployed readers: Knowledgebase listener `app` reads
  // LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN, Mission Control listener `web`
  // reads LAZURIO_RUNTIME_LISTENER_WEB_EXTERNAL_ORIGIN; both declare role entrypoint.
  expect(runtimeListenerEnvironmentNames({ id: "web", role: "entrypoint" })).toEqual({
    host: "LAZURIO_RUNTIME_HOST",
    port: "LAZURIO_RUNTIME_PORT",
    externalOrigin: "LAZURIO_RUNTIME_LISTENER_WEB_EXTERNAL_ORIGIN",
    entrypointExternalOrigin: "LAZURIO_RUNTIME_EXTERNAL_ORIGIN",
  });
  expect(runtimeListenerEnvironmentNames({ id: "app", role: "entrypoint" }).externalOrigin)
    .toBe("LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN");
  expect(runtimeListenerEnvironmentNames({ id: "api-ws", role: "auxiliary" })).toEqual({
    host: "LAZURIO_RUNTIME_LISTENER_API_WS_HOST",
    port: "LAZURIO_RUNTIME_LISTENER_API_WS_PORT",
    externalOrigin: "LAZURIO_RUNTIME_LISTENER_API_WS_EXTERNAL_ORIGIN",
  });
});

function runtime(overrides = {}) {
  return {
    schema_version: "lazurio.runtime.v1",
    id: "example-presentation-v1",
    title: "Presentation",
    company: "example",
    module: "presentation",
    surface: "internal",
    dev_script: "dev",
    tags: ["presentation"],
    listeners: [
      {
        id: "web",
        role: "entrypoint",
        lease: "web",
        protocol: "http",
        health: { kind: "http", path: "/" },
      },
      {
        id: "api",
        role: "auxiliary",
        lease: "api",
        protocol: "http",
        health: { kind: "http", path: "/api/health" },
      },
    ],
    ...overrides,
  };
}

test("normalizes lazurio.runtime.v1 to stable Launchpad aliases", () => {
  const result = normalizePackageRuntime({
    packageJson: { scripts: { dev: "concurrently ..." }, lazurio: { runtime: runtime() } },
  });
  expect(result.issues).toEqual([]);
  expect(result.app).toMatchObject({
    port: null,
    host: null,
    health_path: "/",
    runtime_contract: {
      schema_version: "lazurio.runtime.v1",
      source: "lazurio.runtime",
      legacy: false,
      auxiliary_listeners_known: true,
    },
  });
  expect(result.app.listeners.map((listener) => listener.id)).toEqual(["web", "api"]);
});

test("normalizes legacy app as one entrypoint with unknown auxiliaries", () => {
  const result = normalizePackageRuntime({
    packageJson: {
      companyascode: {
        app: {
          schema_version: "companyascode.launchpad_app.v1",
          id: "example-legacy-v1",
          title: "Legacy",
          company: "example",
          surface: "internal",
          port: 5390,
          host: "localhost",
          health_path: "/",
          dev_script: "dev",
          tags: [],
        },
      },
    },
  });
  expect(result.app.runtime_contract).toMatchObject({
    legacy: true,
    auxiliary_listeners_known: false,
  });
  expect(result.app.listeners).toEqual([
    expect.objectContaining({ role: "entrypoint", allocation: "static", port: 5390 }),
  ]);
});

test("requires exactly one entrypoint", () => {
  const value = runtime({
    listeners: [
      ...runtime().listeners,
      {
        ...runtime().listeners[0],
        id: "second-web",
        role: "entrypoint",
      },
    ],
  });
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.some((issue) => issue.includes("právě jeden entrypoint"))).toBe(true);
});

test("validates every optional runtime field from the published schema", () => {
  const value = runtime({
    required_module_slots: ["workspace/wiki", "workspace/wiki", "../outside"],
    icon: " ",
    description: "x".repeat(241),
    group: "x".repeat(81),
    production_url: "ftp://example.test",
  });
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.join("\n")).toContain("required_module_slots[1] workspace/wiki je duplicitní");
  expect(issues.join("\n")).toContain("required_module_slots[2] není validní");
  expect(issues.join("\n")).toContain("icon musí být neprázdný string");
  expect(issues.join("\n")).toContain("description smí mít nejvýše 240 znaků");
  expect(issues.join("\n")).toContain("group smí mít nejvýše 80 znaků");
  expect(issues.join("\n")).toContain("production_url musí začínat http:// nebo https://");
});

test("accepts schema-valid optional runtime metadata", () => {
  const issues = validateDeclaredRuntime({
    runtime: runtime({
      required_module_slots: ["workspace/wiki", "productionspace/Repository.v2"],
      icon: "book-open",
      description: "Knowledgebase",
      group: "Knowledge",
      production_url: "https://example.test/knowledgebase",
    }),
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues).toEqual([]);
});

test("requires a stable module identity for the single-instance lease", () => {
  const value = runtime();
  delete value.module;
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.some((issue) => issue.includes("lazurio.runtime.module chybí"))).toBe(true);
  expect(issues.some((issue) => issue.includes("lazurio.runtime.module není validní"))).toBe(true);
});

test("port ownership fields are forbidden in the runtime contract", () => {
  const splitAuthority = runtime({
    listeners: [{
      id: "web",
      role: "entrypoint",
      allocation: "dynamic",
      host: "127.0.0.1",
      port: 5394,
      lease: "web",
      protocol: "http",
      health: { kind: "http", path: "/" },
      claim: { mode: "exclusive" },
    }],
  });
  const issues = validateDeclaredRuntime({
    runtime: splitAuthority,
    packageJson: { scripts: { dev: "run" } },
  });
  for (const field of ["allocation", "host", "port", "claim"]) {
    expect(issues.some((issue) => issue.includes(`.${field} není povolené pole`))).toBe(true);
  }
});

test("every runtime listener must reference a module lease", () => {
  const value = runtime();
  delete value.listeners[0].lease;
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.some((issue) => issue.includes(".lease chybí"))).toBe(true);
  expect(issues.some((issue) => issue.includes(".lease není validní"))).toBe(true);
});

test("rejects split authority when new and legacy manifests coexist", () => {
  const result = normalizePackageRuntime({
    packagePath: "workspace/demo/package.json",
    packageJson: {
      scripts: { dev: "run" },
      lazurio: { runtime: runtime() },
      companyascode: { app: { id: "legacy" } },
    },
  });
  expect(result.issues).toEqual([
    "workspace/demo/package.json: package nesmí současně deklarovat lazurio.runtime a legacy companyascode.app",
  ]);
});

test("runtime scripts fail closed when Launchpad listener injection is missing", () => {
  const unsafe = validateDeclaredRuntime({
    runtime: runtime(),
    packageJson: {
      scripts: { dev: "vite --host $HOST --port $PORT --strictPort" },
    },
  });
  expect(unsafe.some((issue) => issue.includes("$HOST bez přenositelné fail-closed"))).toBe(
    true,
  );
  expect(unsafe.some((issue) => issue.includes("$PORT bez přenositelné fail-closed"))).toBe(
    true,
  );

  const safe = validateDeclaredRuntime({
    runtime: runtime(),
    packageJson: {
      scripts: {
        dev: 'bun -e "process.exit(process.env.HOST && process.env.PORT ? 0 : 1)" && vite --host "$HOST" --port "$PORT" --strictPort',
      },
    },
  });
  expect(safe).toEqual([]);
});

function builtRuntime(overrides = {}) {
  return runtime({
    build_script: "build",
    build_output: "dist",
    listeners: [
      { id: "app", role: "entrypoint", lease: "main", protocol: "http", health: { kind: "http", path: "/" } },
    ],
    ...overrides,
  });
}
const builtScripts = { scripts: { dev: "astro dev", build: "astro build" } };

test("accepts a static App that declares its built version (Module Standard 4.5)", () => {
  expect(validateDeclaredRuntime({ runtime: builtRuntime(), packageJson: builtScripts })).toEqual([]);
  expect(validateDeclaredRuntime({
    runtime: builtRuntime({ build_output: "app/dist", static_fallback: "spa" }),
    packageJson: builtScripts,
  })).toEqual([]);
});

test("rejects a built version the Platform could not serve", () => {
  const issues = (overrides, packageJson = builtScripts) =>
    validateDeclaredRuntime({ runtime: builtRuntime(overrides), packageJson }).join("\n");
  expect(issues({ build_output: "../dist" })).toContain("build_output musí být relativní adresář");
  expect(issues({ build_output: "/abs" })).toContain("build_output musí být relativní adresář");
  expect(issues({ build_output: ".hidden" })).toContain("build_output musí být relativní adresář");
  expect(issues({ static_fallback: "index" })).toContain('static_fallback musí být "404" nebo "spa"');
  expect(issues({ build_script: undefined })).toContain("build_output vyžaduje build_script");
  expect(issues({}, { scripts: { dev: "astro dev" } })).toContain("build_output vyžaduje build_script");
  expect(issues({ secrets: ["API_KEY"] })).toContain("build_output nedovoluje secrets");
  expect(issues({
    listeners: [
      { id: "app", role: "entrypoint", lease: "main", protocol: "http", health: { kind: "http", path: "/" } },
      { id: "api", role: "auxiliary", lease: "api", protocol: "http", health: { kind: "http", path: "/" } },
    ],
  })).toContain("build_output vyžaduje právě jeden listener");
  expect(issues({ build_output: undefined, static_fallback: "spa" })).toContain("static_fallback smí být jen spolu s build_output");
});

// Module Standard 4.6 (decision 0195 point 24, LazurioPlatform F58 addendum
// (2) of 2026-10-21): an App with its own server runs `start_script` from
// main. Its process gets its listeners and secrets like its development run,
// so its client (`build_output`) is bound by neither the one-listener nor the
// no-secrets rule of a static App, and it routes its own requests.
const serverScripts = {
  scripts: {
    dev: "bun --no-env-file run src/server.ts",
    start: "bun --no-env-file run src/server.ts",
    build: "vite build",
  },
};
function serverRuntime(overrides = {}) {
  return runtime({
    start_script: "start",
    build_script: "build",
    build_output: "dist",
    secrets: ["EXTERNAL_API_KEY"],
    optional_secrets: ["OPTIONAL_API_KEY"],
    ...overrides,
  });
}

test("accepts an App with its own server from main (Module Standard 4.6)", () => {
  // A client with two listeners and secrets.
  expect(validateDeclaredRuntime({ runtime: serverRuntime(), packageJson: serverScripts })).toEqual([]);
  // A server without a client, whose start script is its development script.
  expect(validateDeclaredRuntime({
    runtime: runtime({ start_script: "dev" }),
    packageJson: serverScripts,
  })).toEqual([]);
  expect(validateAgainstSchema(serverRuntime(), runtimeSchema, "runtime")).toEqual([]);
  expect(validateAgainstSchema(runtime({ start_script: "dev" }), runtimeSchema, "runtime")).toEqual([]);
});

test("rejects a server App the Platform could not start", () => {
  const issues = (overrides, packageJson = serverScripts) =>
    validateDeclaredRuntime({ runtime: serverRuntime(overrides), packageJson }).join("\n");
  expect(issues({ start_script: " " })).toContain("start_script musí být neprázdný string");
  expect(issues({ start_script: "serve" })).toContain("start_script serve neexistuje v scripts");
  expect(issues({}, { scripts: { ...serverScripts.scripts, start: "vite --host $HOST --port $PORT" } }))
    .toContain("start_script používá $PORT bez přenositelné fail-closed kontroly");
  expect(issues({ static_fallback: "spa" })).toContain("static_fallback nesmí být spolu se start_script");
  expect(issues({ static_fallback: "spa", build_output: undefined, build_script: undefined }))
    .toContain("static_fallback nesmí být spolu se start_script");
  expect(issues({ build_script: undefined })).toContain("build_output vyžaduje build_script");
  expect(issues({}, { scripts: { dev: "bun --no-env-file run src/server.ts", start: "bun --no-env-file run src/server.ts" } }))
    .toContain("build_output vyžaduje build_script");
  expect(issues({ build_output: "../dist" })).toContain("build_output musí být relativní adresář");
  // The static App rules stay out of a server App.
  expect(issues({})).not.toContain("právě jeden listener");
  expect(issues({})).not.toContain("nedovoluje");
});

test("the runtime schema refuses what Core refuses for start_script", () => {
  const schemaIssues = (value) => validateAgainstSchema(value, runtimeSchema, "runtime").join("\n");
  expect(schemaIssues(serverRuntime({ static_fallback: "404" }))).toContain("zakázané 'not' větvi");
  expect(schemaIssues(serverRuntime({ start_script: "" }))).toContain("minimum 1");
  // A static App keeps its fallback.
  expect(validateAgainstSchema(builtRuntime({ static_fallback: "spa" }), runtimeSchema, "runtime")).toEqual([]);
});
