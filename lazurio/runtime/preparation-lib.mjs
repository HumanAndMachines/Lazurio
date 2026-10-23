import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { readJsonWithinCanonicalBoundary } from "../core/path-boundary-lib.mjs";
import { validateAgainstSchema } from "./json-schema-mini.mjs";

let schemaPromise;

// One executor for update and Start/Open; the selected checkout owns all tasks.
export async function prepareApplication({
  checkoutRoot, packagePath, force = false, bunExecutable = process.execPath,
  env = process.env, spawnProcess = Bun.spawn, beforePrepare = null,
}) {
  let stage = "declaration";
  let output = "";
  try {
    const root = await realpath(checkoutRoot);
    const read = (path) => readJsonWithinCanonicalBoundary({ rootPath: checkoutRoot, rootRealPath: root, targetPath: path });
    const app = await read(packagePath);
    const declaration = app.value.lazurio?.preparation;
    if (declaration === undefined) return { ok: true, declared: false, prepared: false };
    schemaPromise ??= Bun.file(join(import.meta.dirname, "..", "schemas", "lazurio-preparation.schema.json")).json();
    const issues = validateAgainstSchema(declaration, await schemaPromise, "lazurio.preparation");
    if (issues.length) throw new Error(issues.join("; "));
    if ((declaration.runtime ?? "bun") !== "bun" || !declaration.owner_package.endsWith("/package.json")) {
      throw new Error("This Launchpad does not support uv preparation yet.");
    }
    const ownerPath = resolve(checkoutRoot, declaration.owner_package);
    const owner = await read(ownerPath);
    for (const key of ["check_script", "prepare_script"]) {
      const name = declaration[key];
      if (name === undefined) continue;
      if (/[\r\n]/.test(name) || typeof owner.value.scripts?.[name] !== "string" || !owner.value.scripts[name].trim()) {
        throw new Error(`${key} ${String(name)} is not a declared owner package script.`);
      }
    }
    const authority = JSON.stringify([app.value, owner.value]);
    const childEnv = { ...env };
    delete childEnv.NODE_PATH;
    delete childEnv.PORT;
    delete childEnv.HOST;
    for (const key of Object.keys(childEnv)) if (key.startsWith("LAZURIO_RUNTIME_")) delete childEnv[key];
    async function verifyAuthority() {
      const currentApp = await read(packagePath);
      const currentOwner = await read(ownerPath);
      if (currentApp.targetRealPath !== app.targetRealPath || currentOwner.targetRealPath !== owner.targetRealPath
          || JSON.stringify([currentApp.value, currentOwner.value]) !== authority) {
        throw new Error("Preparation authority changed during execution; retry from the current source.");
      }
    }
    async function run(name) {
      await verifyAuthority();
      const child = spawnProcess([bunExecutable, "--no-env-file", "run", name], {
        cwd: dirname(owner.targetRealPath), env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        child.stdout ? new Response(child.stdout).text() : "",
        child.stderr ? new Response(child.stderr).text() : "", child.exited,
      ]);
      output = `${name} (exit ${exitCode})\n${stdout}\n${stderr}`.slice(-4000);
      await verifyAuthority();
      return exitCode;
    }
    stage = "check";
    if (!force && await run(declaration.check_script) === 0) return { ok: true, declared: true, prepared: false };
    if (declaration.prepare_script) {
      stage = "prepare";
      if (beforePrepare) await beforePrepare();
      if (await run(declaration.prepare_script) !== 0) throw new Error(output);
    }
    stage = "post_check";
    if (await run(declaration.check_script) !== 0) throw new Error(output);
    return { ok: true, declared: true, prepared: Boolean(declaration.prepare_script) };
  } catch (error) {
    return { ok: false, reason: `preparation_${stage}_failed`, detail: error instanceof Error ? error.message : String(error) };
  }
}
