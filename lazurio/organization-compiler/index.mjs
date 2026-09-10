import { randomUUID } from "node:crypto";
import { inspectCanonicalPathBoundary } from "../core/path-boundary-lib.mjs";
import { readOrganizationRoot } from "../core/organization-root-reader-lib.mjs";
import { lstat, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readCheckoutRepositoryObservation } from "./checkout-observation.mjs";
import {
  OrganizationCompilerError,
  prepareOrganizationCompilation,
} from "./compiler-core.mjs";

export {
  buildCompanyTargets,
  compilerVersion,
  formatCompilerReport,
  OrganizationCompilerError,
  WorkspaceCompilerError,
} from "./compiler-core.mjs";

export async function compileOrganization(options = {}) {
  const {
    organizationRoot,
    workspaceRoot,
    write = false,
    repositoryObservation = null,
    repositoryObservationReader,
    ...rest
  } = options;
  const rootInput = organizationRoot ?? workspaceRoot;
  if (!rootInput) {
    throw new OrganizationCompilerError(
      "compileOrganization vyžaduje organizationRoot",
    );
  }
  if (repositoryObservationReader !== undefined) {
    throw new OrganizationCompilerError(
      "Compiler nepřijímá callerem dodaný repositoryObservationReader; write vždy používá kanonický checkout reader",
    );
  }
  if (write && repositoryObservation?.status === "offline") {
    throw new OrganizationCompilerError(
      "Offline repository validace je pouze read-only/dry-run a nesmí autorizovat compiler write",
    );
  }
  if (write && repositoryObservation !== null) {
    throw new OrganizationCompilerError(
      "Compiler write nepřijímá callerem předané repository pozorování; identitu vždy čte přímo z cílového checkoutu",
    );
  }

  const root = resolve(rootInput);
  const effectiveRepositoryObservation = write
    ? readCheckoutRepositoryObservation(root)
    : repositoryObservation;
  if (
    write &&
    effectiveRepositoryObservation?.status !== "valid" &&
    effectiveRepositoryObservation?.status !== "absent"
  ) {
    throw new OrganizationCompilerError(
      "Compiler write vyžaduje kanonickým readerem důvěryhodně zjištěný checkout; unavailable, invalid ani offline stav nesmí autorizovat zápis",
    );
  }
  if (write && rest.schemaDocuments !== undefined) throw new OrganizationCompilerError("Write cannot use caller schemas");
  if (write && (!effectiveRepositoryObservation.linkedWorktree || ["main", "master", "v3"].includes(effectiveRepositoryObservation.branch))) {
    throw new OrganizationCompilerError("Write requires a linked review worktree on a non-canonical branch");
  }
  const resolution = readOrganizationRoot({ organizationRoot: root });
  if (resolution.document_presence.canonical && !["current", "transition"].includes(resolution.state)) {
    throw new OrganizationCompilerError(`Organization authority conflict: ${resolution.state}`);
  }
  for (const path of ["company.gen3.json", "modules.manifest.json", "generated/company-summary.json", "generated/business-context.md", "generated/modules.index.json", "generated/generation-policy.md"]) {
    await assertCompilerPath(root, path);
  }
  const prepared = await prepareOrganizationCompilation({
    ...rest,
    organizationRoot: root,
    write,
    repositoryObservation: effectiveRepositoryObservation,
  });
  if (write) {
    for (const target of prepared.writes) {
      const targetPath = join(root, target.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await assertCompilerPath(root, target.path);
      const temporary = `${targetPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, target.content, { flag: "wx" });
        await assertCompilerPath(root, target.path);
        await rename(temporary, targetPath);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    }
  }
  return prepared.report;
}

// Deprecated aliasy (CAC-0016): odstranit po migraci konzumentů
// (task-2026-06-12-017).
export const compileCompanyWorkspace = compileOrganization;

async function assertCompilerPath(root, path) {
  const unsafe = () => new OrganizationCompilerError(`Unsafe compiler path: ${path}`);
  if (!(await inspectCanonicalPathBoundary({ rootPath: root, targetPath: join(root,path), allowMissingTarget: true })).ok) throw unsafe();
  const parts = path.split("/");
  for (let i=1; i<=parts.length; i++) {
    let entry;
    try { entry = await lstat(join(root,...parts.slice(0,i))); }
    catch(error) { if(error.code === "ENOENT") continue; throw error; }
    if (entry.isSymbolicLink() || (i<parts.length ? !entry.isDirectory() : !entry.isFile() || entry.nlink > 1)) throw unsafe();
  }
}
