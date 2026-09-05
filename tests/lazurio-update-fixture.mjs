import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export async function createLazurioUpdateFixture({
  sandboxRoot = null,
  withModule = false,
  moduleMaterialized = true,
} = {}) {
  const sandbox = sandboxRoot ?? await mkdtemp(join(tmpdir(), "lazurio-update-cli-"));
  await mkdir(sandbox, { recursive: true });
  const remote = join(sandbox, "remote.git");
  const seed = join(sandbox, "seed");
  const contributor = join(sandbox, "contributor");
  const working = join(sandbox, "working");

  git(sandbox, ["init", "--bare", remote]);
  git(sandbox, ["clone", remote, seed]);
  configure(seed);
  git(seed, ["switch", "-c", "main"]);
  await Promise.all([
    mkdir(join(seed, "launchpad"), { recursive: true }),
    mkdir(join(seed, "guide"), { recursive: true }),
    mkdir(join(seed, "manual"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(seed, ".gitignore"), "organizations/\n"),
    writeFile(join(seed, "launchpad", ".keep"), ""),
    writeFile(join(seed, "guide", ".keep"), ""),
    writeFile(join(seed, "manual", ".keep"), ""),
    writeJson(join(seed, "launchpad.gen3.json"), {}),
  ]);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "initial root"]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(sandbox, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(sandbox, ["clone", remote, contributor]);
  git(sandbox, ["clone", remote, working]);
  configure(contributor);
  configure(working);

  const fixture = { sandbox, remote, seed, contributor, working };
  if (withModule) await attachModule(fixture, { moduleMaterialized });
  return fixture;
}

export async function commitRemoteRoot(fixture) {
  await writeFile(join(fixture.contributor, "remote.txt"), "remote\n");
  git(fixture.contributor, ["add", "remote.txt"]);
  git(fixture.contributor, ["commit", "-m", "remote root"]);
  git(fixture.contributor, ["push", "origin", "main"]);
}

export async function commitRemoteModule(fixture) {
  if (!fixture.moduleSeed) throw new Error("Fixture has no module remote.");
  await writeFile(join(fixture.moduleSeed, "remote.txt"), "remote module\n");
  git(fixture.moduleSeed, ["add", "remote.txt"]);
  git(fixture.moduleSeed, ["commit", "-m", "remote module"]);
  git(fixture.moduleSeed, ["push", "origin", "main"]);
}

async function attachModule(fixture, { moduleMaterialized = true } = {}) {
  const organizationRemote = join(fixture.sandbox, "organization.git");
  const organizationSeed = join(fixture.sandbox, "organization-seed");
  const organizationWorking = join(fixture.working, "organizations", "FixtureOrg_GEN3");
  const moduleRemote = join(fixture.sandbox, "module.git");
  const declaredModuleRemote = "git@github.com:FixtureOrg/sample.git";
  const moduleSeed = join(fixture.sandbox, "module-seed");
  const moduleWorking = join(organizationWorking, "workspace", "sample");

  git(fixture.sandbox, ["init", "--bare", organizationRemote]);
  git(fixture.sandbox, ["clone", organizationRemote, organizationSeed]);
  configure(organizationSeed);
  git(organizationSeed, ["switch", "-c", "main"]);
  await Promise.all([
    mkdir(join(organizationSeed, "manual"), { recursive: true }),
    mkdir(join(organizationSeed, "company", "colleagues"), { recursive: true }),
    mkdir(join(organizationSeed, "mission-control", "plans"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(organizationSeed, ".gitignore"), "workspace/\n"),
    writeFile(join(organizationSeed, "manual", ".keep"), ""),
    writeFile(join(organizationSeed, "company", "colleagues", ".keep"), ""),
    writeFile(join(organizationSeed, "mission-control", "plans", ".keep"), ""),
    writeJson(join(organizationSeed, "company.gen3.json"), {
      organization_generation: "gen3",
      company: {
        slug: "FixtureOrg",
        display_name: "Fixture Organization",
        github_org: "FixtureOrg",
        repository: organizationRemote,
      },
      teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    }),
    writeJson(join(organizationSeed, "modules.manifest.json"), {
      organization_generation: "gen3",
      company: "FixtureOrg",
      github_org: "FixtureOrg",
      module_slots: [{
        slug: "sample",
        path: "workspace/sample",
        teams: ["workspace"],
        category: "product",
        git: { url: declaredModuleRemote, branch: "main" },
      }],
    }),
    writeJson(join(organizationSeed, "TODO.tasks.json"), {}),
    writeJson(join(organizationSeed, "DONE.tasks.json"), {}),
    writeJson(join(organizationSeed, "ISSUES.open.json"), {}),
  ]);
  git(organizationSeed, ["add", "."]);
  git(organizationSeed, ["commit", "-m", "initial organization"]);
  git(organizationSeed, ["push", "-u", "origin", "main"]);
  git(fixture.sandbox, ["--git-dir", organizationRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await mkdir(join(fixture.working, "organizations"), { recursive: true });
  git(fixture.sandbox, ["clone", organizationRemote, organizationWorking]);
  configure(organizationWorking);

  git(fixture.sandbox, ["init", "--bare", moduleRemote]);
  git(fixture.sandbox, ["clone", moduleRemote, moduleSeed]);
  configure(moduleSeed);
  git(moduleSeed, ["switch", "-c", "main"]);
  await Promise.all([
    writeFile(join(moduleSeed, "README.md"), "# Sample\n"),
    writeJson(join(moduleSeed, "lazurio.module.json"), {
      schema_version: "lazurio.module.v1",
      id: "sample",
      company: "FixtureOrg",
      tcp_port_policy: { mode: "none" },
      port_leases: [],
      apps: [],
    }),
  ]);
  git(moduleSeed, ["add", "README.md", "lazurio.module.json"]);
  git(moduleSeed, ["commit", "-m", "initial module"]);
  git(moduleSeed, ["push", "-u", "origin", "main"]);
  git(fixture.sandbox, ["--git-dir", moduleRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await mkdir(join(organizationWorking, "workspace"), { recursive: true });
  const sshBridge = join(fixture.sandbox, "fixture-github-ssh.mjs");
  const fixtureSshCommand = [process.execPath, sshBridge, moduleRemote]
    .map((value) => JSON.stringify(value.replaceAll("\\", "/")))
    .join(" ");
  await writeFile(sshBridge, fixtureGitHubSshBridge(), "utf8");
  if (moduleMaterialized) {
    git(fixture.sandbox, ["clone", moduleRemote, moduleWorking]);
    configure(moduleWorking);
    git(moduleWorking, ["remote", "set-url", "origin", declaredModuleRemote]);
    git(moduleWorking, ["config", "core.sshCommand", fixtureSshCommand]);
    git(moduleWorking, ["config", "ssh.variant", "simple"]);
  } else {
    const fixtureHome = join(fixture.sandbox, "home");
    await mkdir(fixtureHome, { recursive: true });
    const globalConfig = join(fixtureHome, ".gitconfig");
    git(fixtureHome, ["config", "--file", globalConfig, "core.sshCommand", fixtureSshCommand]);
    git(fixtureHome, ["config", "--file", globalConfig, "ssh.variant", "simple"]);
    fixture.environment = { ...process.env, HOME: fixtureHome };
  }
  Object.assign(fixture, { organizationWorking, moduleSeed, moduleWorking });
}

function fixtureGitHubSshBridge() {
  return [
    "const [repository, _host, command = ''] = process.argv.slice(2);",
    "const service = command.startsWith('git-upload-pack')",
    "  ? 'upload-pack'",
    "  : command.startsWith('git-receive-pack')",
    "    ? 'receive-pack'",
    "    : null;",
    "if (!service) process.exit(2);",
    "const result = Bun.spawnSync(['git', service, repository], {",
    "  stdin: 'inherit',",
    "  stdout: 'inherit',",
    "  stderr: 'inherit',",
    "});",
    "process.exit(result.exitCode ?? 1);",
    "",
  ].join("\n");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configure(cwd) {
  git(cwd, ["config", "user.name", "Lazurio Test"]);
  git(cwd, ["config", "user.email", "lazurio@example.test"]);
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
}
