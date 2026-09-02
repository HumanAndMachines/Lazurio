import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The short-lived CLI launcher may live in the mutable checkout, but the
// update engine itself runs from this complete bundle in a separate directory.
// Hosted Launchpad does not use this escape hatch: its long-running runtime
// must be installed outside the working root and passes that exact runtime root
// to runLazurioUpdate.
export async function runIsolatedLazurioUpdate({
  rootPath,
  organizations = null,
  environment = process.env,
}) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-update-runtime-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dirname, "lazurio-update-runtime.mjs")],
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
    });
    if (!build.success || build.outputs.length !== 1) {
      throw new Error(build.logs.map((log) => log.message).join("\n") || "Updater runtime bundle se nepodařilo sestavit.");
    }
    // Zachovej stejnou relativní strukturu jako instalovaný @lazurio/runtime.
    // Bundlované import.meta.dirname pak dál ukazuje na lazurio/runtime a
    // discovery čte jedinou kanonickou kopii schemas z lazurio/schemas.
    const runtimeSourceRoot = join(directory, "lazurio", "runtime");
    const runtimeSchemaRoot = join(directory, "lazurio", "schemas");
    await mkdir(runtimeSourceRoot, { recursive: true });
    await cp(join(import.meta.dirname, "..", "schemas"), runtimeSchemaRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const runtimePath = join(runtimeSourceRoot, "lazurio-update-runtime.mjs");
    await Bun.write(runtimePath, build.outputs[0]);
    const runtimeArgs = [process.execPath, runtimePath, "--root", rootPath, "--runtime-root", directory];
    if (organizations !== null) {
      const organizationScopePath = join(directory, "organization-scope.json");
      await Bun.write(organizationScopePath, `${JSON.stringify(organizations)}\n`);
      runtimeArgs.push("--organizations-file", organizationScopePath);
    }
    const child = Bun.spawn(
      runtimeArgs,
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let report;
    try {
      report = JSON.parse(stdout.trim());
    } catch {
      throw new Error(stderr.trim() || stdout.trim() || `Updater runtime skončil kódem ${exitCode}.`);
    }
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
