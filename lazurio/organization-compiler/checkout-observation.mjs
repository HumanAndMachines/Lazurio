import { spawnSync } from "node:child_process";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { resolveGitExecutableOnPath } from "../core/toolchain-lib.mjs";
import { githubRepositoryUrlIdentity } from "./repository-identity.mjs";

const template = "git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git";
const fetchSpec = name => `+refs/heads/*:refs/remotes/${name}/*`;

// Local declaration/routing observation only. No remote transport is executed;
// this does not attest GitHub grants or immutable template supply-chain identity.
export function readCheckoutRepositoryObservation(root) {
  let phase = "executable";
  try {
    const executable = resolveGitExecutableOnPath();
    if (!executable) return { status: "unavailable", reason: "git_not_on_path" };
    if (Object.keys(process.env).some(key => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|CONFIG|SSH|EXEC_PATH|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)/.test(key))) return { status: "invalid", reason: "git_environment_override" };
    const git = (...args) => {
      phase = args[0];
      const result = spawnSync(executable, ["-C", root, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, shell: false });
      if (result.status !== 0) throw new Error("git observation failed");
      return result.stdout.trimEnd();
    };
    phase = "checkout_paths";
    const actual = realpathSync(root);
    // Git owns cwd-to-checkout resolution, including Windows short-name aliases.
    if (git("rev-parse", "--show-prefix") !== "") return { status: "invalid", reason: "not_checkout_root" };
    const common = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
    const checkoutRoot = dirname(common);
    const gitDir = realpathSync(git("rev-parse", "--absolute-git-dir"));
    const linkedWorktree = relative(gitDir, common) !== ""
      && relative(dirname(gitDir), join(common, "worktrees")) === ""
      && samePhysicalFile(readFileSync(join(gitDir,"gitdir"),"utf8").trim(), join(actual,".git"));
    const parse = text => text.split("\0").filter(Boolean).map(entry => {
      const i = entry.indexOf("\n");
      return [entry.slice(0, i).toLowerCase(), entry.slice(i + 1)];
    });
    const local = parse(git("config", "--local", "--no-includes", "--null", "--list"));
    const effective = parse(git("config", "--includes", "--null", "--list"));
    const values = (entries, key) => entries.filter(([k]) => k === key).map(([,v]) => v);
    const exact = (entries, key, expected) => JSON.stringify(values(entries,key)) === JSON.stringify(expected);
    const relevant = ([key]) => /^(?:remote\.|branch\..*\.(?:remote|pushremote)$)/.test(key);
    const inheritedRouting = JSON.stringify(local.filter(relevant)) !== JSON.stringify(effective.filter(relevant));
    const unsafe = inheritedRouting || effective.some(([key]) => /^remote\./.test(key) && !/^remote\.(?:origin|template)\.(?:url|pushurl|fetch)$/.test(key)) || effective.some(([key]) => /^(?:include\.|includeif\.|url\..*\.(?:insteadof|pushinsteadof)$|core\.sshcommand$|ssh\.variant$)/.test(key) || (key.startsWith("http.") && effective.some(([k,v]) => /^remote\..*\.(?:url|pushurl)$/.test(k) && v.startsWith("https:"))));
    const urls = values(local,"remote.origin.url");
    const identity = urls.length === 1 ? githubRepositoryUrlIdentity(urls[0]) : null;
    const templateUrls = values(local,"remote.template.url");
    const sink = process.platform === "win32" ? "NUL" : "/dev/null";
    const templateReady = exact(local,"remote.template.url",[template]) && exact(local,"remote.template.pushurl",[sink]) && exact(local,"remote.template.fetch",[fetchSpec("template")]);
    const allUrls = local.filter(([key]) => /^remote\..*\.(?:url|pushurl)$/.test(key));
    const originRoutingReady = !unsafe && identity !== null
      && exact(local,"remote.origin.fetch",[fetchSpec("origin")])
      && exact(local,"branch.main.remote",["origin"])
      && local.filter(([key]) => /^branch\..*\.(?:remote|pushremote)$/.test(key)).every(([,v]) => v === "origin")
      && values(local,"remote.pushdefault").length === 0
      && values(local,"remote.origin.pushurl").every(url => githubRepositoryUrlIdentity(url) === identity)
      && [git("remote","get-url","--all","origin"),git("remote","get-url","--push","--all","origin")].every(url => githubRepositoryUrlIdentity(url) === identity)
      && allUrls.every(([key]) => /^remote\.(?:origin|template)\./.test(key));
    return {
      status: identity ? "valid" : urls.length ? "invalid" : "absent",
      identity, checkoutRoot, checkoutPlatform: process.platform,
      currentCheckoutRoot: actual,
      branch: git("symbolic-ref","--short","HEAD"),
      linkedWorktree,
      remoteContract: {
        originRoutingReady,
        templateRemoteState: unsafe ? "invalid" : templateReady ? "ready" : templateUrls.length ? "invalid" : "missing",
        templateRepositoryRemoteNames: [...new Set(allUrls.filter(([,url]) => url === template).map(([key]) => key.split(".")[1]))],
        allRemoteUrlsSafeGithub: allUrls.every(([,url]) => githubRepositoryUrlIdentity(url) !== null),
        verification: "local-routing-only",
      },
    };
  } catch {
    return { status: "unavailable", reason: phase };
  }
}

function samePhysicalFile(first, second) {
  const left = statSync(first, { bigint: true });
  const right = statSync(second, { bigint: true });
  if (!left.isFile() || !right.isFile()) return false;
  if (left.ino !== 0n && right.ino !== 0n) return left.dev === right.dev && left.ino === right.ino;
  return relative(realpathSync(first), realpathSync(second)) === "";
}
