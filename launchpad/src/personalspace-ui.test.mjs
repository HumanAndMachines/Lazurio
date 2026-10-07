import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

// Windows checkouts may carry CRLF; the source assertions below compare LF text.
const readSource = async (path) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n");

const publicRoot = join(import.meta.dirname, "..", "public");
const schemasRoot = join(import.meta.dirname, "..", "..", "lazurio", "schemas");

test("personalspace.js markdown render neinjektuje raw HTML z obsahu vaultu", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");
  // Obsah se nejdřív escapuje (žádný raw HTML z vaultu do DOM).
  expect(js).toContain('.replace(/&/g, "&amp;")');
  expect(js).toContain('.replace(/</g, "&lt;")');
});

test("kanonická Personalspace schema kopie zůstává base kontraktem s privátními consts", async () => {
  const schema = JSON.parse(await readFile(join(schemasRoot, "personal.gen3.schema.json"), "utf8"));
  expect(schema.$comment).toBeUndefined();
  expect(schema.$id).toBe("https://rozjedeme.ai/schemas/personal.gen3.schema.json");
  expect(schema.required).toContain("schema_version");
  expect(schema.properties.schema_version.const).toBe("humanandmachines.personal.gen3.v1");
  // Tvrdá privátní hranice v kontraktu.
  expect(schema.properties.privacy.properties.shared_outputs.const).toBe("metadata-only");
  expect(schema.properties.repository.properties.visibility.const).toBe("private");
  expect(schema.properties.gbrain.properties.default_shared.const).toBe(false);
  expect(schema.properties.shared_spaces.maxItems).toBe(0);
  expect(schema.properties.gbrain.properties.agent_access.const).toBe("mcp-only");
  expect(schema.properties.buddy.properties.display_name).toBeUndefined();
  expect(schema.properties.buddy.properties.runtime.required).toContain("deployment_target");
  expect(schema.properties.buddy.properties.runtime.required).toContain("local_execution");
  expect(schema.properties.buddy.properties.runtime.properties.deployment_target.const)
    .toBe("owner-dedicated-personalspace-vps");
  expect(schema.properties.buddy.properties.runtime.properties.local_execution.const).toBe("forbidden");
  // Identity invariant stavební kameny (patterny na repo/mount).
  expect(schema.properties.repository.properties.github_repo.pattern).toContain("_GEN3");
  expect(schema.properties.repository.properties.mount_path.pattern).toContain("personalspace/");
});

test("Buddy presentation overlay je oddělený neautoritativní draft", async () => {
  const schema = JSON.parse(await readFile(join(schemasRoot, "personal-buddy-presentation.draft.schema.json"), "utf8"));
  expect(schema.$id).toContain("personal-buddy-presentation.draft.schema.json");
  expect(schema.properties.application.properties.type.enum).toContain("telegram");
  const mapShape = schema.properties.recurring_tasks.anyOf.find((shape) => shape.type === "object");
  const arrayShape = schema.properties.recurring_tasks.anyOf.find((shape) => shape.type === "array");
  expect(mapShape.additionalProperties.required).toContain("schedule_label");
  expect(mapShape.propertyNames.pattern).toContain("[a-z0-9]");
  expect(arrayShape.items.required).toContain("id");
});

test("shared Team Machine: the UI knows the server refusal code and the server refuses before any Personalspace handling", async () => {
  const [appJs, server, setupLib] = await Promise.all([
    readSource(join(publicRoot, "app.js")),
    readSource(join(import.meta.dirname, "server.mjs")),
    import(join(import.meta.dirname, "setup-github-lib.mjs")),
  ]);
  // The UI keeps its own copy of the error code; it must stay equal to the server's.
  expect(appJs).toContain(`const PERSONALSPACE_TEAM_MACHINE_ERROR = "${setupLib.PERSONALSPACE_TEAM_MACHINE_ERROR}";`);
  // Server: read once at start-up, refused right after the trust check, and no Doctor lane.
  expect(server).toContain("const personalspaceOffered = machineOffersPersonalspace(readMachineAssignment());");
  const forbidden = server.indexOf('return jsonResponse({ error: "personalspace_request_forbidden" }, 403);');
  const refusal = server.indexOf("personalspaceRouteRefusal(url.pathname, { offered: personalspaceOffered })");
  expect(forbidden).toBeGreaterThan(-1);
  expect(refusal).toBeGreaterThan(forbidden);
  expect(refusal).toBeLessThan(server.indexOf("if (isMutatingApiRequest(request, url)) {", forbidden));
  expect(server).toContain("personalspaceOffered ? buildPersonalspace({ verifyRepositoryPrivacy: true }) : null");
  expect(server).toContain("personalspaceDoctorCheck({}, { teamMachine: true })");
});
