// Lifecycle hint after Team authentication, never an access decision.
// Caddy retains Fetch Metadata and Sec-WebSocket-Key on its bodyless check;
// it removes Connection/Upgrade, so those cannot identify reconnects here.
export function hostedRequestMayStartApp(headers) {
  if (headers.has("sec-websocket-key")) return false;
  const mode = headers.get("sec-fetch-mode");
  return !mode || mode === "navigate";
}
