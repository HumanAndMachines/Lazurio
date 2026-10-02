import { expect, test } from "bun:test";
import { DESCRIPTION, handle, hostAllowed } from "./app.ts";

const loopback = new Set(["localhost", "127.0.0.1", "::1"]);

test("the root route describes the Module", async () => {
  const response = handle(new Request("http://127.0.0.1/"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(DESCRIPTION);
  expect(DESCRIPTION.module).toBe("{{slug}}");
});

test("unknown routes and write methods are refused", () => {
  expect(handle(new Request("http://127.0.0.1/missing")).status).toBe(404);
  expect(handle(new Request("http://127.0.0.1/", { method: "POST" })).status).toBe(405);
});

test("only allowed hostnames pass the Host check", () => {
  const request = (host: string) => new Request("http://127.0.0.1/", { headers: { host } });
  expect(hostAllowed(request("127.0.0.1:4000"), loopback)).toBe(true);
  expect(hostAllowed(request("[::1]:4000"), loopback)).toBe(true);
  expect(hostAllowed(request("foreign.invalid"), loopback)).toBe(false);
});
