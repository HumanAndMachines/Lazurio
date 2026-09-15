import { expect, test } from "bun:test";
import { hostedRequestMayStartApp } from "./hosted-readiness-lib.mjs";

test("direct navigation and non-browser links may open an app", () => {
  expect(hostedRequestMayStartApp(new Headers())).toBe(true);
  expect(hostedRequestMayStartApp(new Headers({"sec-fetch-mode": "navigate"}))).toBe(true);
});

test("background fetches and asset loads cannot restart an app", () => {
  for (const mode of ["cors", "no-cors", "same-origin", "websocket"]) {
    expect(hostedRequestMayStartApp(new Headers({"sec-fetch-mode": mode}))).toBe(false);
  }
});

test("a WebSocket handshake without Fetch Metadata cannot restart an app", () => {
  // Standard handshake identity survives the ingress bodyless GET rewrite.
  const headers = new Headers({"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="});
  expect(hostedRequestMayStartApp(headers)).toBe(false);
  headers.set("sec-fetch-mode", "navigate");
  expect(hostedRequestMayStartApp(headers)).toBe(false);
});
