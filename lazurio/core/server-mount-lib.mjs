// Server identity and locator own the native API mount contract.
export function normalizeServerMountPath(value = "/") {
  if (value === "/") return value;
  if (typeof value !== "string" || !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/$/.test(value)) {
    throw new TypeError("server_mount_path_invalid");
  }
  return value;
}
