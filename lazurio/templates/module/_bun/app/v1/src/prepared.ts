// Read-only readiness of the preparation (Lazurio Module Standard,
// `check_script`). The Vite dev server needs no build; the App is prepared
// when every dependency of this package is installed. Exit 0 when prepared,
// 1 otherwise.
import { resolve } from "node:path";
import manifest from "../package.json";

const app = resolve(import.meta.dir, "..");
const names = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)];
const missing: string[] = [];
for (const name of names) {
  if (!(await Bun.file(resolve(app, "node_modules", name, "package.json")).exists())) {
    missing.push(name);
  }
}
if (missing.length > 0) {
  console.error(
    `not prepared: ${missing.join(", ")} not installed; run \`bun install --frozen-lockfile\``,
  );
  process.exit(1);
}
