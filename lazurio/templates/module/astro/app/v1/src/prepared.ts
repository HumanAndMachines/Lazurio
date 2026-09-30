// Read-only readiness of the preparation (Lazurio Module Standard,
// `check_script`): `astro sync` (`prepare:app`) has generated the types that
// `astro dev` and `astro check` read. Exit 0 when prepared, 1 otherwise.
import { resolve } from "node:path";

const types = resolve(import.meta.dir, "../.astro/types.d.ts");
if (!(await Bun.file(types).exists())) {
  console.error(`not prepared: ${types} is missing; run \`bun run prepare:app\``);
  process.exit(1);
}
