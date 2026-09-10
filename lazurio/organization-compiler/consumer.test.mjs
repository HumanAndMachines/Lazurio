import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, symlink, link, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureWorkspace } from "./fixture.test-support.mjs";
import { compileOrganization } from "./index.mjs";
import { readCheckoutRepositoryObservation } from "./checkout-observation.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function git(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
async function fixture() {
  const container = await mkdtemp(join(tmpdir(), "compiler-consumer-")); roots.push(container);
  const primary = join(container,"FixtureCompany_GEN3");
  await rename(await createFixtureWorkspace(),primary);
  const file = join(primary,"company.gen3.json");
  const company = await Bun.file(file).json();
  company.company.repository = "git@github.com:FixtureOrg/FixtureCompany_GEN3.git";
  company.company.root_repository = "FixtureOrg/FixtureCompany_GEN3";
  await Bun.write(file,JSON.stringify(company));
  git(primary,"init","-b","main");
  git(primary,"remote","add","origin",company.company.repository);
  git(primary,"config","branch.main.remote","origin");
  git(primary,"remote","add","template","git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git");
  git(primary,"config","remote.template.pushurl",process.platform === "win32" ? "NUL" : "/dev/null");
  git(primary,"add",".");
  git(primary,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-m","Fixture");
  const review = join(container,"review");
  git(primary,"worktree","add","-b","codex/review",review);
  return { primary, review };
}

test("real primary dry-run and linked review write are deterministic", async () => {
  const { primary, review } = await fixture();
  const observation = readCheckoutRepositoryObservation(primary);
  expect(observation).toMatchObject({status:"valid", remoteContract:{originRoutingReady:true}});
  expect((await compileOrganization({organizationRoot: primary, repositoryObservation: observation})).changed_target_count).toBe(4);
  await expect(compileOrganization({organizationRoot: primary,write:true})).rejects.toThrow("linked review worktree");
  expect((await compileOrganization({organizationRoot: review,write:true})).changed_target_count).toBe(4);
  expect((await compileOrganization({organizationRoot: review,write:true})).changed_target_count).toBe(0);
});

test("write rejects caller schemas and observation", async () => {
  const { review } = await fixture();
  await expect(compileOrganization({organizationRoot:review,write:true,schemaDocuments:{}})).rejects.toThrow("caller schemas");
  await expect(compileOrganization({organizationRoot:review,write:true,repositoryObservation:{status:"valid"}})).rejects.toThrow("pozorování");
});

test("a separate git directory does not turn a primary checkout into a review worktree", async () => {
  const primary=await createFixtureWorkspace(); roots.push(primary);
  const metadata=await mkdtemp(join(tmpdir(),"compiler-git-metadata-")); roots.push(metadata);
  git(primary,"init","-b","codex/review",`--separate-git-dir=${join(metadata,"repo.git")}`);
  expect(readCheckoutRepositoryObservation(primary).linkedWorktree).toBe(false);
  await expect(compileOrganization({organizationRoot:primary,write:true})).rejects.toThrow("linked review worktree");
});

test("conflicting canonical Organization authority blocks legacy generation", async () => {
  const {review}=await fixture();
  await Bun.write(join(review,"lazurio.organization.json"),JSON.stringify({organization:{id:"unrelated"}}));
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("Organization authority conflict");
});

test("write rejects traversal through external generated directory without touching victim", async () => {
  const { review } = await fixture();
  const outside = await mkdtemp(join(tmpdir(),"compiler-victim-")); roots.push(outside);
  const victim = join(outside,"company-summary.json"); await Bun.write(victim,"protected");
  await symlink(outside,join(review,"generated"),process.platform === "win32" ? "junction" : "dir");
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("Unsafe compiler path");
  expect(await readFile(victim,"utf8")).toBe("protected");
});

for (const kind of ["symlink", "hardlink"]) {
const linkTest = kind === "symlink" && !(await supportsFileSymlinks()) ? test.skip : test;
linkTest(`write rejects ${kind} from a derived output to authoritative input`, async () => {
  const {review}=await fixture();
  const authority=join(review,"company.gen3.json");
  const original=await readFile(authority,"utf8");
  await mkdir(join(review,"generated"));
  const output=join(review,"generated/modules.index.json");
  if(kind==="symlink") await symlink(authority,output); else await link(authority,output);
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("Unsafe compiler path");
  expect(await readFile(authority,"utf8")).toBe(original);
});
}

test.each([
  ["remote.origin.pushurl","git@github.com:OtherOrg/Other_GEN3.git"],
  ["remote.origin.mirror","true"],
  ["remote.origin.push","refs/heads/*:refs/heads/*"],
  ["branch.codex/review.pushRemote","template"],
  ["remote.template.pushurl","git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git"],
  ["url.ssh://evil.invalid/.insteadOf","git@github.com:"],
])("write rejects unsafe routing %s", async (key,value) => {
  const {review}=await fixture(); git(review,"config",key,value);
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow();
});

test("child db uses active mount identity and refuses missing parent and non-db nesting", async () => {
  const {review}=await fixture();
  const companyPath=join(review,"company.gen3.json"), manifestPath=join(review,"modules.manifest.json");
  const company=await Bun.file(companyPath).json(), manifest=await Bun.file(manifestPath).json();
  const module={slug:"deals-data",path:"workspace/deals/db",category:"data",source_of_truth:"repository-db:v3",repo:"git@github.com:FixtureOrg/deals-data.git",access:{default:"role_based",roles:["sales"]}};
  company.modules.push(module);
  const slot={status:"active",materialization:"repository_db_mount",slug:module.slug,path:module.path,category:"data",source_of_truth:module.source_of_truth,default_access:"role_based",required_roles:["sales"],git:{url:module.repo,branch:"v3"}};
  manifest.module_slots.push(slot);
  const save=async()=>{await Bun.write(companyPath,JSON.stringify(company));await Bun.write(manifestPath,JSON.stringify(manifest));};
  await save();
  await compileOrganization({organizationRoot:review,write:true});
  const index=await Bun.file(join(review,"generated/modules.index.json")).json();
  expect(index.manifest_slots.find(item=>item.slug==="deals-data")).toMatchObject({ materialization:"repository_db_mount", git: {branch:"v3"} });
  slot.git.url="git@github.com:FixtureOrg/other-data.git";await save();
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("validací");
  slot.git.url=module.repo;slot.source_of_truth=module.source_of_truth="git-native";await save();
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("validací");
  slot.source_of_truth=module.source_of_truth="repository-db:v3";
  const parentGit=manifest.module_slots[0].git;
  delete manifest.module_slots[0].git;await save();
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("validací");
  manifest.module_slots[0].git=parentGit;
  manifest.module_slots[0].status="planned_slot";await save();
  await expect(compileOrganization({organizationRoot:review,write:true})).rejects.toThrow("validací");
});
