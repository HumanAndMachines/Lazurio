/** Request handling of the service, free of the listener so it has unit tests. */

export const HEALTH_PATH = "/healthz";

export const DESCRIPTION = {
  module: "{{slug}}",
  organization: "{{organization}}",
  title: "{{display_name}}",
};

/** Hostnames the service answers; `allowedHosts()` of module-kit gives loopback
 * plus the external origin of a hosted listener. Anything else is refused. */
export function hostAllowed(request: Request, hosts: ReadonlySet<string>): boolean {
  const header = request.headers.get("host");
  if (header === null) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname;
  } catch {
    return false;
  }
  return hosts.has(hostname.replace(/^\[(.*)\]$/, "$1"));
}

export function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (pathname === "/") {
    return Response.json(DESCRIPTION);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
