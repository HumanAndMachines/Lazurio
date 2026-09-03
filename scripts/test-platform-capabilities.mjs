import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const unsupportedSymlinkErrors = new Set([
  "EACCES",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

let fileSymlinkSupport;

export function supportsFileSymlinks() {
  fileSymlinkSupport ??= probeFileSymlinkSupport();
  return fileSymlinkSupport;
}

async function probeFileSymlinkSupport() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-file-symlink-probe-"));
  try {
    await writeFile(join(root, "target"), "probe\n");
    await symlink("target", join(root, "link"), "file");
    return true;
  } catch (error) {
    if (unsupportedSymlinkErrors.has(error?.code)) return false;
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
