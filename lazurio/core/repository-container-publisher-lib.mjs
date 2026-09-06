import { constants, openSync, closeSync, fstatSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// macOS's documented exclusive rename is invoked through its system bridge.
// No compiler, FFI dependency, shell interpolation or check-then-rename fallback.
const exclusiveRenameProgram = `
ObjC.bindFunction("renameatx_np", ["int", ["int", "char *", "int", "char *", "unsigned int"]]);
function run(argv) {
  if (argv.length !== 2 || argv.some(function (name) { return !name || name === "." || name === ".." || name.indexOf("/") !== -1; })) throw Error("invalid child name");
  if ($.renameatx_np(3, argv[0], 4, argv[1], 4) !== 0) throw Error("exclusive rename refused");
  return "moved";
}`;

function identity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(stat, expected) { return stat.dev === expected.dev && stat.ino === expected.ino; }
function problem(code, preserveStaging = false) { return Object.assign(new Error(code), { code, preserveStaging }); }

export function inspectRepositoryContainer(path, childName, platform = process.platform) {
  if (platform !== "darwin") throw problem("repository_parent_recovery_platform_unsupported");
  if (childName !== "db") throw problem("repository_parent_recovery_child_invalid");
  const container = lstatSync(path);
  const child = lstatSync(join(path, childName));
  if (!container.isDirectory() || container.isSymbolicLink() || !child.isDirectory() || child.isSymbolicLink()) {
    throw problem("repository_parent_recovery_layout_unsafe");
  }
  const entries = readdirSync(path);
  if (entries.length !== 1 || entries[0] !== childName) throw problem("repository_parent_recovery_content_unknown");
  return { ...identity(container), child: { name: childName, ...identity(child) } };
}

export function renameExclusive(sourceFd, sourceName, targetFd, targetName) {
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", exclusiveRenameProgram, sourceName, targetName], {
    stdio: ["ignore", "pipe", "pipe", sourceFd, targetFd],
    timeout: 10_000,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
  });
  if (result.status !== 0 || result.stdout.toString().trim() !== "moved") throw problem("repository_parent_exclusive_publish_refused");
}

// A full snapshot also detects additions or edits inside a directory we created.
// Rollback must preserve such concurrent work, not merely trust the top inode.
function snapshot(path) {
  const stat = lstatSync(path);
  const item = { ...identity(stat), mode: stat.mode, size: stat.size };
  if (stat.isSymbolicLink()) return { ...item, link: readlinkSync(path) };
  if (stat.isDirectory()) return { ...identity(stat), mode: stat.mode, children: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) };
  if (!stat.isFile()) throw problem("repository_parent_staging_type_unsupported");
  return { ...item, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
function identical(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

/** Called in a Core child pinned to the physical target parent. */
export async function publishRepositoryContainer({ stagingPath, targetPath, expectedContainer, beforeMove = async () => {}, afterMove = async () => {}, platform = process.platform }) {
  if (platform !== "darwin") return { ok: false, code: "repository_parent_recovery_platform_unsupported" };
  if (expectedContainer?.child?.name !== "db") return { ok: false, code: "repository_parent_recovery_child_invalid" };
  let stageFd;
  let targetFd;
  const moved = [];
  let names = [];
  const snapshots = new Map();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let preserveStaging = false;
  try {
    stageFd = openSync(stagingPath, flags);
    targetFd = openSync(targetPath, flags);
    if (!sameIdentity(fstatSync(targetFd), expectedContainer)) throw problem("repository_parent_identity_changed");
    const target = targetPath;
    const stage = stagingPath;
    const stageIdentity = identity(fstatSync(stageFd));
    const childName = expectedContainer.child.name;
    const assertChild = () => {
      const child = lstatSync(join(target, childName));
      if (!child.isDirectory() || child.isSymbolicLink() || !sameIdentity(child, expectedContainer.child)) throw problem("repository_db_identity_changed");
    };
    const assertTarget = () => {
      if (!sameIdentity(lstatSync(stagingPath), stageIdentity)) throw problem("repository_parent_staging_identity_changed");
      if (!sameIdentity(lstatSync(targetPath), expectedContainer)) throw problem("repository_parent_identity_changed");
      assertChild();
      const current = readdirSync(target).sort();
      if (!identical(current, [childName, ...moved].sort())) throw problem("repository_parent_recovery_content_unknown");
      for (const name of moved) if (!identical(snapshot(join(target, name)), snapshots.get(name))) throw problem("repository_parent_published_content_changed");
    };
    assertTarget();
    names = readdirSync(stage).sort((a, b) => a === ".git" ? 1 : b === ".git" ? -1 : a.localeCompare(b));
    if (!names.includes(".git") || names.some((name) => name.toLowerCase() === childName.toLowerCase())) throw problem("repository_parent_staging_collision");
    if (!lstatSync(join(stage, ".git")).isDirectory()) throw problem("repository_parent_staging_git_invalid");
    for (const name of names) snapshots.set(name, snapshot(join(stage, name)));
    for (const [index, name] of names.entries()) {
      await beforeMove({ name, index, target, stage });
      assertTarget();
      // Record the attempt first: a native child may complete the rename but
      // lose its acknowledgement. Exclusive rollback is safe even if no move
      // happened, because the original staging name still exists in that case.
      moved.push(name);
      renameExclusive(stageFd, name, targetFd, name);
      await afterMove({ name, index, target, stage });
    }
    assertTarget();
    return { ok: true };
  } catch (error) {
    // First quarantine by exclusive rename; then verify ownership. A path swap
    // can never make cleanup delete someone else's replacement. Unknown content
    // is restored, or retained with explicit recovery evidence if restoration races.
    for (const name of moved.reverse()) {
      try {
        renameExclusive(targetFd, name, stageFd, name);
        const recovered = snapshot(join(stagingPath, name));
        if (!identical(recovered, snapshots.get(name))) {
          preserveStaging = true;
          // Git is activation metadata: restoring a raced .git would activate
          // a partial checkout while the remaining app entries roll back.
          if (name !== ".git") try { renameExclusive(stageFd, name, targetFd, name); } catch {}
        }
      } catch { preserveStaging = true; }
    }
    return { ok: false, code: error.code ?? "repository_parent_recovery_failed", preserveStaging };
  } finally {
    if (stageFd !== undefined) closeSync(stageFd);
    if (targetFd !== undefined) closeSync(targetFd);
    // Leave the empty stage on success. A path-based rmdir after releasing the
    // directory capability could remove somebody else's replacement directory.
  }
}
