import { expect, test } from "bun:test";

test("the hand-over code is accepted bare, as connect=<code>, in a fragment or a whole URL, and validated", async () => {
  const { parseHandover } = await import("../public/connections.js");
  const payload = {
    label: "betaco-anna-vm", ipv4: "100.72.0.3", user: "anna", tailnet: "headscale.betaco.lazurio.io",
    host_key: { type: "ssh-ed25519", key: "AAAAC3NzaC1lZDI1NTE5AAAAIGb7d9Q6Cy1S1ZwZ5vN5a1r0Q6Q4XxT3s1jWl5eGqk0L" },
    fingerprint: "SHA256:abc", return: "https://launchpad.betaco-anna-vm.betaco.lazurio.io/settings/ssh",
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const code = encode(payload);
  for (const input of [code, `connect=${code}`, `#connect=${code}`, `http://127.0.0.1:4187/settings/connections#connect=${code}`, `  ${code}\n`]) {
    expect(parseHandover(input)).toEqual({ ...payload, return: payload.return });
  }
  expect(parseHandover("")).toBeNull();
  expect(parseHandover("not a code")).toBeNull();
  expect(parseHandover(encode({ ...payload, return: "http://launchpad.betaco-anna-vm.betaco.lazurio.io/" }))).toBeNull();
  expect(parseHandover(encode({ ...payload, return: "https://evil.example.com/" }))).toBeNull();
});
