import { expect, test } from "bun:test";
import {
  T3ChatError,
  issueT3ChatUrl,
  t3ChatConfigurationFromEnvironment,
  t3PairUrl,
} from "./t3-chat-lib.mjs";

const command = JSON.stringify([
  "/home/tereza/.local/bin/node",
  "/home/tereza/.local/share/lazurio/t3code/current/dist/bin.mjs",
  "auth", "pairing", "create", "--base-dir", "/home/tereza/.t3",
]);
const env = {
  LAZURIO_T3CODE_URL: "https://t3code.tereza.iotorlazurio.lazurio.io/t3code/",
  LAZURIO_T3CODE_PAIRING_COMMAND: command,
};

test("Chat stays off when the Machine does not configure T3", () => {
  expect(t3ChatConfigurationFromEnvironment({})).toBeNull();
});

test("half a configuration is a deployment error, not a silent off", () => {
  expect(() => t3ChatConfigurationFromEnvironment({ LAZURIO_T3CODE_URL: env.LAZURIO_T3CODE_URL })).toThrow();
  expect(() => t3ChatConfigurationFromEnvironment({ LAZURIO_T3CODE_PAIRING_COMMAND: command })).toThrow();
});

test("the T3 address must be a clean HTTPS mount", () => {
  for (const url of [
    "http://t3code.tereza.iotorlazurio.lazurio.io/t3code/",
    "https://t3code.tereza.iotorlazurio.lazurio.io/t3code",
    "https://t3code.tereza.iotorlazurio.lazurio.io/t3code/?x=1",
    "https://user@t3code.tereza.iotorlazurio.lazurio.io/t3code/",
    "t3code/",
  ]) {
    expect(() => t3ChatConfigurationFromEnvironment({ ...env, LAZURIO_T3CODE_URL: url })).toThrow();
  }
});

test("the pairing command is an exact argv with absolute program and script", () => {
  for (const value of ["node bin.mjs", "[]", JSON.stringify(["node", "/x/bin.mjs"]), JSON.stringify(["/usr/bin/node", "bin.mjs"])]) {
    expect(() => t3ChatConfigurationFromEnvironment({ ...env, LAZURIO_T3CODE_PAIRING_COMMAND: value })).toThrow();
  }
});

test("the pair URL keeps the T3 mount and carries the token only in the fragment", () => {
  expect(t3PairUrl(env.LAZURIO_T3CODE_URL, "Q99JLPJXN9WC"))
    .toBe("https://t3code.tereza.iotorlazurio.lazurio.io/t3code/pair#token=Q99JLPJXN9WC");
});

test("a Chat click mints a short one-time token without a shell", async () => {
  const configuration = t3ChatConfigurationFromEnvironment(env);
  const calls = [];
  const url = await issueT3ChatUrl(configuration, {
    run: async (program, args) => {
      calls.push([program, args]);
      return JSON.stringify({ id: "x", credential: "G2RQZFN6MK77", expiresAt: "2026-09-21T10:00:00.000Z" });
    },
  });
  expect(url).toBe("https://t3code.tereza.iotorlazurio.lazurio.io/t3code/pair#token=G2RQZFN6MK77");
  expect(calls).toEqual([[
    "/home/tereza/.local/bin/node",
    [
      "/home/tereza/.local/share/lazurio/t3code/current/dist/bin.mjs",
      "auth", "pairing", "create", "--base-dir", "/home/tereza/.t3",
      "--ttl", "60s", "--label", "launchpad-chat", "--json",
    ],
  ]]);
});

test("a failing or odd CLI answer never leaks its output", async () => {
  const configuration = t3ChatConfigurationFromEnvironment(env);
  const secret = "SECRETSECRET";
  for (const run of [
    async () => { throw new Error(`boom ${secret}`); },
    async () => `not json ${secret}`,
    async () => JSON.stringify({ credential: `${secret}#frag` }),
  ]) {
    const error = await issueT3ChatUrl(configuration, { run }).catch((caught) => caught);
    expect(error).toBeInstanceOf(T3ChatError);
    expect(error.message).not.toContain(secret);
  }
});
