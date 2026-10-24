// The small static server of a built App started from `main` on a computer
// (decision 0212 point 9, Module Standard 4.5). It mirrors the resolution
// rules of the LazurioPlatform static server (F58) without importing it: the
// root Launchpad runs it as the App's one process, through the same runtime
// manager and on the App's declared listener, so it imports nothing but
// Node's and Bun's own modules.
//
// It serves one immutable build directory: GET and HEAD only, nothing it
// cannot prove lies inside that directory, no directory listings. HTML is
// revalidated on every load (`no-cache` with an ETag); the files a framework
// names by their content (`/_astro/`, Vite's `/assets/`) are kept a year.
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

const immutablePrefixes = ["/_astro/", "/assets/"];
const textHeaders = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

// The decoded segments of a request path; null when one of them could name
// something outside the root. `:` is refused too, so that no Windows drive or
// alternate data stream can be named.
function segmentsOf(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const segments = [];
  for (const raw of pathname.slice(1).split("/")) {
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (
      segment === "."
      || segment === ".."
      || /[/\\\0:]/.test(segment)
    ) return null;
    segments.push(segment);
  }
  return segments;
}

// A regular file (not a link) inside the root whose real path is `base`, so
// that no link of a parent directory leads out of it either; or null.
async function fileInside(base, path) {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const real = await realpath(path);
    return real.startsWith(`${base}${sep}`) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Which file of `root` answers `pathname`: the exact file, then
 * `<path>.html`, then `<path>/index.html` (for a path without its slash a
 * redirect to it); a path ending in `/` is its `index.html`. Without one, the
 * fallback: `spa` answers a path whose last segment has no extension with the
 * root's `index.html`, `404` answers with the root's `404.html` and status
 * 404 when the build has one.
 */
export async function resolveStaticRequest(root, pathname, fallback = "404") {
  const segments = segmentsOf(pathname);
  if (segments === null) return { kind: "refused" };
  let base;
  try {
    base = await realpath(root);
  } catch {
    return { kind: "missing" };
  }
  const named = join(base, ...segments);
  if (pathname.endsWith("/")) {
    const index = await fileInside(base, join(named, "index.html"));
    if (index !== null) return { kind: "file", path: index, status: 200 };
  } else {
    const exact = await fileInside(base, named);
    if (exact !== null) return { kind: "file", path: exact, status: 200 };
    const html = await fileInside(base, `${named}.html`);
    if (html !== null) return { kind: "file", path: html, status: 200 };
    const index = await fileInside(base, join(named, "index.html"));
    if (index !== null) return { kind: "redirect", location: `${pathname}/` };
  }
  const last = segments.at(-1) ?? "";
  if (fallback === "spa" && !last.includes(".")) {
    const index = await fileInside(base, join(base, "index.html"));
    if (index !== null) return { kind: "file", path: index, status: 200 };
  }
  if (fallback === "404") {
    const missing = await fileInside(base, join(base, "404.html"));
    if (missing !== null) return { kind: "file", path: missing, status: 404 };
  }
  return { kind: "missing" };
}

/** One request of the server, exported for its tests. */
export async function answerStatic(request, { root, fallback = "404" }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { ...textHeaders, Allow: "GET, HEAD" },
    });
  }
  const url = new URL(request.url);
  const resolved = await resolveStaticRequest(root, url.pathname, fallback);
  if (resolved.kind === "refused") return new Response("Bad request\n", { status: 400, headers: textHeaders });
  if (resolved.kind === "missing") return new Response("Not found\n", { status: 404, headers: textHeaders });
  if (resolved.kind === "redirect") {
    return new Response(null, { status: 308, headers: { Location: `${resolved.location}${url.search}` } });
  }
  const file = Bun.file(resolved.path);
  const info = await stat(resolved.path);
  const tag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const html = resolved.path.endsWith(".html");
  const headers = {
    "Content-Type": file.type,
    "X-Content-Type-Options": "nosniff",
    ETag: tag,
    "Last-Modified": info.mtime.toUTCString(),
    "Cache-Control": !html
      && resolved.status === 200
      && immutablePrefixes.some((prefix) => url.pathname.startsWith(prefix))
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  if (resolved.status === 200 && request.headers.get("If-None-Match") === tag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    return new Response(null, {
      status: resolved.status,
      headers: { ...headers, "Content-Length": String(info.size) },
    });
  }
  return new Response(file, { status: resolved.status, headers });
}

/**
 * The listener of a started App (Module Standard 4.2): the entrypoint's
 * `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` and `_PORT`, as the runtime manager
 * gives every App it starts.
 */
export function entrypointOf(env) {
  const id = env.LAZURIO_RUNTIME_ENTRYPOINT_ID ?? "";
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const hostname = env[`LAZURIO_RUNTIME_LISTENER_${key}_HOST`] ?? "";
  const port = Number(env[`LAZURIO_RUNTIME_LISTENER_${key}_PORT`]);
  if (!id || !hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Start the static server through the Lazurio lifecycle.");
  }
  return { hostname, port };
}

const usage = "Usage: --root <absolute build directory> --fallback 404|spa";

export function argumentsOf(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--root", "--fallback"].includes(name) || value === undefined || values.has(name)) {
      throw new Error(usage);
    }
    values.set(name, value);
  }
  const root = values.get("--root");
  const fallback = values.get("--fallback");
  if (typeof root !== "string" || !isAbsolute(root) || !["404", "spa"].includes(fallback)) {
    throw new Error(usage);
  }
  return { root, fallback };
}

if (import.meta.main) {
  try {
    const { root, fallback } = argumentsOf(process.argv.slice(2));
    const server = Bun.serve({
      ...entrypointOf(process.env),
      development: false,
      // A browser keeps its connection to an App it uses; Bun's longest idle
      // time instead of its 10 s, as the Platform's server does.
      idleTimeout: 255,
      fetch: (request) => answerStatic(request, { root, fallback })
        .catch(() => new Response("Internal error\n", { status: 500, headers: textHeaders })),
    });
    // SIGTERM ends the App with exit 0 (Module Standard 4.4).
    const end = () => {
      void server.stop(true).finally(() => process.exit(0));
    };
    process.on("SIGTERM", end);
    process.on("SIGINT", end);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
