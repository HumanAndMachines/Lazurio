import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFingerprinter, describeFile, main } from "./custody-shape.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "custody-shape-"));
const home = join(sandbox, "home");
mkdirSync(home, { recursive: true });
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

// Synthetic secrets with distinctive characters, so any leak of even a
// fragment is visible in the output.
const SECRETS = {
  db: "Qz7vKx2mWp9Lr4Tn8Yc1",
  admin: "Hb3jXq6Zs0Fv5Nd2Gk7M",
  client: "Wt8cRm1Pz4Jx9Lq2Vb6KsY3",
  short: "Pq7Zx",
  oidc: "Ux5Kd9Rv2Mw7Tz3Hq8Ln4Bc",
  key: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  token: "Fg2Kw7Rp4Xt9Zm1Vq6Bn3Hs",
  yaml: "Yk4Rm8Wq2Tz6Xp1Lv9Nc5Bd",
  number: 731954,
};
const fragments = Object.values(SECRETS).flatMap((secret) => {
  const s = String(secret);
  const size = Math.min(5, s.length);
  return Array.from({ length: s.length - size + 1 }, (_, i) => s.slice(i, i + size));
});
const file = (name, content) => {
  const path = join(sandbox, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
};
const pointerTarget = file("pointed.json", JSON.stringify({ value: SECRETS.oidc }));

const fixtures = {
  // The incident shape: one field is a JSON string holding KEY=value lines.
  incident: file(
    "issuer-secrets.json",
    JSON.stringify({
      keycloak_env: `KC_DB_PASSWORD=${SECRETS.db}\nKC_BOOTSTRAP_ADMIN_PASSWORD=${SECRETS.admin}\n# comment\nexport KC_CLIENT="${SECRETS.client}"\n`,
      clients: [{ client_id: "dashboard", secret: SECRETS.client }, { client_id: "short", secret: SECRETS.short }],
      port: SECRETS.number,
      enabled: true,
    }),
  ),
  map: file("credential-map.json", JSON.stringify({ credentials: { "credentials/oidc": { path: pointerTarget }, "credentials/gone": { path: "/nonexistent/qz7vkx-not-a-path.json" } } })),
  env: file("broker.env", `# broker\nexport TOKEN=${SECRETS.token}\nOIDC='${SECRETS.oidc}'\n\nPORT=${SECRETS.number}\n${SECRETS.client}${SECRETS.db}=keyed\n`),
  pem: file("id_example", `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRETS.key}\n-----END OPENSSH PRIVATE KEY-----\n`),
  nested: file("nested.json", JSON.stringify({ outer: [[{ inner: SECRETS.token }], { json: JSON.stringify({ deep: SECRETS.db }) }], [`${SECRETS.client}${SECRETS.token}`]: "keyed" })),
  keyed: file(
    "token-keys.json",
    JSON.stringify({
      [`sk_live_${SECRETS.admin}`]: 1,
      [`eyJhbGciOiJIUzI1NiJ9.${SECRETS.oidc}`]: 2,
      [`ghp_${SECRETS.client}${SECRETS.short}`]: 3,
      // A token after a structural prefix, with no long mixed run (review of 71e74444).
      [`account/xoxb-${SECRETS.short}123-${SECRETS.short}abc-${SECRETS.short}789`]: 4,
      "credentials/vm101-ssh": { path: "/nonexistent" },
      ASIA_PACIFIC: 5,
      error_count: 6,
    }),
  ),
  yaml: file("values.yaml", `service:\n  password: ${SECRETS.yaml}\n  user: admin\n`),
  toml: file("values.toml", `[service]\npassword = "${SECRETS.yaml}"\n`),
  invalid: file("broken.json", `{"password": "${SECRETS.db}", trailing`),
  text: file("token", `${SECRETS.token}\n`),
  binary: file("blob.bin", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, ...Buffer.from(SECRETS.key)])),
};

function shape(path, options = {}) {
  return describeFile(path, { home, ...options }).lines.join("\n");
}

describe("never prints a value", () => {
  for (const [name, path] of Object.entries(fixtures)) {
    test(name, () => {
      const output = shape(path, { fingerprint: createFingerprinter() });
      for (const fragment of fragments) expect(output).not.toContain(fragment);
    });
  }
});

describe("shows the structure", () => {
  test("incident shape: env block keys with lengths", () => {
    const output = shape(fixtures.incident);
    expect(output).toMatch(/\n  json · \d+ bytes · mode 0600/u);
    expect(output).toContain("$.keycloak_env");
    expect(output).toContain("env block, 3 keys");
    expect(output).toMatch(new RegExp(`KC_DB_PASSWORD\\s+len=${SECRETS.db.length}`, "u"));
    expect(output).toContain("KC_BOOTSTRAP_ADMIN_PASSWORD");
    expect(output).toMatch(/\$\.clients\[1\]\.secret\s+string len=5/u);
    expect(output).toMatch(/\$\.port\s+number/u);
    expect(output).toMatch(/\$\.enabled\s+boolean/u);
  });

  test("credential map: an existing pointer is shown, anything else is not", () => {
    const output = shape(fixtures.map);
    expect(output).toContain(`path ${pointerTarget}`);
    expect(output).not.toContain("qz7vkx-not-a-path");
  });

  test("KEY=value file", () => {
    const output = shape(fixtures.env);
    expect(output).toMatch(/\n  env · \d+ bytes/u);
    expect(output).toMatch(new RegExp(`TOKEN\\s+len=${SECRETS.token.length}`, "u"));
    expect(output).toMatch(new RegExp(`OIDC\\s+len=${SECRETS.oidc.length}`, "u"));
    expect(output).toMatch(/<key len=\d+>/u);
  });

  test("PEM label only", () => {
    expect(shape(fixtures.pem)).toContain("pem OPENSSH PRIVATE KEY");
  });

  test("nested arrays, a JSON string and a key that looks like a credential", () => {
    const output = shape(fixtures.nested);
    expect(output).toContain("$.outer[0][0].inner");
    expect(output).toContain("$.outer[1].json⟶$.deep");
    expect(output).toMatch(/<key len=\d+>/u);
  });

  test("keys shaped like credentials are shown by length, schema names are not", () => {
    const output = shape(fixtures.keyed);
    expect(output.match(/<key len=\d+>/gu)?.length).toBe(4);
    expect(output).toContain('$["credentials/vm101-ssh"]');
    expect(output).toContain("$.ASIA_PACIFIC");
    expect(output).toContain("$.error_count");
  });

  test("YAML and TOML", () => {
    expect(shape(fixtures.yaml)).toMatch(/\$\.service\.password\s+string len=/u);
    expect(shape(fixtures.toml)).toMatch(/\$\.service\.password\s+string len=/u);
  });

  test("a file it cannot parse is described, not echoed", () => {
    expect(shape(fixtures.invalid)).toContain("json (does not parse)");
    expect(shape(fixtures.text)).toMatch(/text, 1 non-empty lines/u);
    expect(shape(fixtures.binary)).toContain("binary (zip)");
  });
});

describe("--fingerprint", () => {
  const fp = (output, label) => new RegExp(`${label}[^\\n]*fp=([0-9a-f]{8})`, "u").exec(output)?.[1];

  test("equal values match across files of one run; different values do not", () => {
    const fingerprint = createFingerprinter();
    const incident = shape(fixtures.incident, { fingerprint });
    const env = shape(fixtures.env, { fingerprint });
    expect(fp(incident, "\\$\\.clients\\[0\\]\\.secret")).toBe(fp(incident, "KC_CLIENT"));
    expect(fp(env, "OIDC")).toBeDefined();
    expect(fp(env, "OIDC")).not.toBe(fp(env, "TOKEN"));
  });

  test("a run's key is random, so fingerprints cannot be looked up later", () => {
    const first = fp(shape(fixtures.env, { fingerprint: createFingerprinter() }), "TOKEN");
    const second = fp(shape(fixtures.env, { fingerprint: createFingerprinter() }), "TOKEN");
    expect(first).not.toBe(second);
  });
});

describe("command line", () => {
  const run = (argv) => {
    const lines = [];
    const code = main(argv, { write: (line) => lines.push(line), home });
    return { code, output: lines.join("\n") };
  };

  test("several files, one shared fingerprint key", () => {
    const { code, output } = run(["--fingerprint", fixtures.incident, fixtures.env]);
    expect(code).toBe(0);
    expect(output.match(/fp=[0-9a-f]{8}/gu)?.length).toBeGreaterThan(4);
  });

  test("missing file and directory fail without content", () => {
    expect(run([join(sandbox, "missing.json")]).code).toBe(1);
    expect(run([sandbox]).code).toBe(1);
  });

  test("usage errors", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--print-values", fixtures.env]).code).toBe(2);
  });
});
