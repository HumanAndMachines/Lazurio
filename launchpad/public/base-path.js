// One mount path for Launchpad's routes and browser-owned resources.
export function normalizeLaunchpadBasePath(value = "/") {
  if (value === "/") return value;
  if (typeof value !== "string" || !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/$/.test(value)) {
    throw new Error("launchpad_base_path_invalid");
  }
  return value;
}

export function launchpadPath(path, basePath = "/") {
  const base = normalizeLaunchpadBasePath(basePath);
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return path;
  return base + path.slice(1);
}

export function launchpadRoute(pathname, basePath = "/") {
  const base = normalizeLaunchpadBasePath(basePath);
  if (!pathname.startsWith(base)) return null;
  return "/" + pathname.slice(base.length);
}

export const browserBasePath = new URL(".", import.meta.url).pathname;
