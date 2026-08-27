import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const exactStableVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export function bunVersionFromPackageManager(packageManager) {
  const match = /^bun@(.+)$/u.exec(packageManager ?? "");
  if (!match || !exactStableVersionPattern.test(match[1])) {
    throw new Error("package.json#packageManager must pin an exact stable Bun version");
  }
  return match[1];
}

export function readRequiredBunVersion({
  root = resolve(import.meta.dirname, ".."),
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  let sourcePackage;
  try {
    sourcePackage = JSON.parse(readText(resolve(root, "package.json")));
  } catch (error) {
    throw new Error(
      `Lazurio Bun version authority cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bunVersionFromPackageManager(sourcePackage.packageManager);
}

export function classifyBunRuntime({ currentVersion, requiredVersion }) {
  if (!exactStableVersionPattern.test(requiredVersion ?? "")) {
    throw new Error("required Bun version must be an exact stable version");
  }
  if (typeof currentVersion !== "string" || currentVersion === "") {
    return Object.freeze({ status: "unavailable", current_version: null, required_version: requiredVersion });
  }
  return Object.freeze({
    status: currentVersion === requiredVersion ? "current" : "mismatch",
    current_version: currentVersion,
    required_version: requiredVersion,
  });
}
