#!/usr/bin/env bun

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { renderHumanDoctorReport } from "./runtime/doctor-output-lib.mjs";
import { DOCTOR_EXIT_CODES } from "./runtime/doctor-surface-lib.mjs";
import { createHostedWorkspaceConfiguration } from "./runtime/hosted-app-url-lib.mjs";
import { formatUpdateLaneReport } from "./runtime/update-cli-lib.mjs";
import { runIsolatedLazurioUpdate } from "./runtime/lazurio-update-runner-lib.mjs";
import { buildLazurioContext, buildLazurioDoctorReport } from "./lib.mjs";
import {
  buildLazurioCliIdentity,
  inspectLazurioCliInstallation,
  installLazurioCli,
  renderHumanCliIdentity,
  renderHumanCliInstallation,
} from "./cli-install-lib.mjs";
import { buildLazurioCliProvenance } from "./core/cli-provenance-lib.mjs";
import {
  moduleLifecycleExitCode,
  renderHumanModuleLifecycle,
  runModuleLifecycle,
} from "./core/module-lifecycle-client-lib.mjs";
import {
  canonicalLazurioRoot,
  inspectLazurioInstallation,
  installExitCode,
} from "./core/install-core-lib.mjs";
import {
  renderHumanInstallReport,
  selectInstallLanguage,
} from "./install-output-lib.mjs";
import { runLaunchpadInstall } from "./launchpad-install-lib.mjs";
import { runLaunchpadServe } from "./launchpad-serve-lib.mjs";
import {
  moduleLocationRepairExitCode,
  renderHumanModuleLocationRepair,
  runModuleLocationRepair,
} from "./runtime/module-location-repair-lib.mjs";
import {
  moduleSetupExitCode,
  renderHumanModuleSetup,
  setupModule,
} from "./module-setup-lib.mjs";
import {
  checkOrganizationActivation,
  organizationActivationExitCode,
  renderHumanOrganizationActivation,
} from "./organization-activation-lib.mjs";
import {
  installOrganization,
  organizationInstallExitCode,
  renderHumanOrganizationInstall,
} from "./organization-install-lib.mjs";
import {
  buildLazurioSearchStatus,
  searchLazurioExact,
  searchLazurioQmd,
  updateLazurioQmdIndex,
} from "./search-lib.mjs";

if (import.meta.main) {
  try {
    process.exitCode = await run(Bun.argv.slice(2));
  } catch (error) {
    console.error(`lazurio: ${error.message}`);
    process.exitCode = error.lazurioExitCode ?? (Bun.argv[2] === "module" ? 3 : 2);
  }
}

async function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.version) {
    const provenance = buildLazurioCliProvenance({ root: cliCodeRoot() });
    console.log(options.json ? JSON.stringify(provenance, null, 2) : renderHumanVersion(provenance));
    return provenance.status === "resolved" ? 0 : 1;
  }

  if (options.command === "install") {
    const codeRoot = cliCodeRoot();
    const provenance = buildLazurioCliProvenance({ root: codeRoot });
    const root = operatedRootForCliProvenance({ codeRoot, provenance });
    const report = inspectLazurioInstallation({ root });
    const language = selectInstallLanguage({ requested: options.language });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderHumanInstallReport(report, { language }));
    }
    return installExitCode(report);
  }

  if (options.command === "organization") {
    if (options.organizationAction === "activate") {
      const report = checkOrganizationActivation({
        githubOrganizationId: options.githubOrganizationId,
      });
      console.log(options.json
        ? JSON.stringify(report, null, 2)
        : renderHumanOrganizationActivation(report));
      return organizationActivationExitCode(report);
    }
    options.root ??= defaultOperatedRoot();
    const report = await installOrganization({
      rootPath: options.root,
      githubLogin: options.organizationLogin,
    });
    console.log(options.json
      ? JSON.stringify(report, null, 2)
      : renderHumanOrganizationInstall(report));
    return organizationInstallExitCode(report);
  }

  if (options.command === "module" && options.moduleAction !== "setup") {
    const report = await runModuleLifecycle({
      action: options.moduleAction,
      selector: options.moduleSelector,
      appPackage: options.appPackage,
      confirmReplaceAppId: options.confirmReplaceAppId,
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderHumanModuleLifecycle(report));
    return moduleLifecycleExitCode(report);
  }

  options.root ??= defaultOperatedRoot();

  if (options.command === "module") {
    const report = await setupModule({
      lazurioRoot: options.root,
      moduleRoot: options.moduleRoot,
      apply: options.apply,
      noApp: options.noApp,
      appPackage: options.appPackage,
      appId: options.appId,
      title: options.title,
      devScript: options.devScript,
      healthPath: options.healthPath,
      surface: options.surface,
      tags: options.tags,
      adoptPort: options.adoptPort,
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderHumanModuleSetup(report));
    return moduleSetupExitCode(report);
  }

  if (options.command === "repair") {
    const report = await runModuleLocationRepair({
      rootPath: options.root,
      organizationSlug: options.repairOrganization,
      moduleSlug: options.repairModule,
      apply: options.apply,
      expectedFingerprint: options.expectedFingerprint,
    });
    console.log(options.json
      ? JSON.stringify(report, null, 2)
      : renderHumanModuleLocationRepair(report));
    return moduleLocationRepairExitCode(report);
  }

  if (options.command === "context") {
    const context = await buildLazurioContext({
      root: options.root,
      organization: options.organization,
    });
    console.log(options.json ? JSON.stringify(context, null, 2) : renderHumanContext(context));
    return 0;
  }

  if (options.command === "doctor") {
    try {
      const workspaceProfile = createHostedWorkspaceConfiguration({
        profile: process.env.LAZURIO_WORKSPACE_PROFILE,
        organizationSlug: process.env.LAZURIO_ORGANIZATION_SLUG,
        teamId: process.env.LAZURIO_TEAM_ID,
        domain: process.env.LAZURIO_HOSTED_DOMAIN,
      });
      const result = await buildLazurioDoctorReport({
        root: options.root,
        checkToolUpdates: options.toolUpdates,
        refreshWorktreePullRequests: options.refreshPrs,
        activeTeamId: workspaceProfile.profile === "hosted" ? workspaceProfile.team_id : null,
      });
      console.log(options.json
        ? JSON.stringify(result.report, null, 2)
        : renderHumanDoctorReport(result.report));
      return result.exit_code;
    } catch (error) {
      error.lazurioExitCode ??= DOCTOR_EXIT_CODES.no_report;
      throw error;
    }
  }

  if (options.command === "update") {
    const report = await runIsolatedLazurioUpdate({ rootPath: options.root });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatUpdateLaneReport(report));
    return report.ok ? 0 : 1;
  }

  if (options.command === "launchpad") {
    return options.launchpadAction === "serve"
      ? runLaunchpadServe({
          root: options.root,
          organization: options.organization,
          personalspace: options.personalspace,
          codeRoot: cliCodeRoot(),
        })
      : runLaunchpadInstall({ root: options.root });
  }

  if (options.command === "cli") {
    if (options.cliAction === "identity") {
      const identity = buildLazurioCliIdentity({ root: options.root });
      console.log(options.json ? JSON.stringify(identity, null, 2) : renderHumanCliIdentity(identity));
      return 0;
    }
    const report = options.cliAction === "install"
      ? installLazurioCli({ root: options.root })
      : inspectLazurioCliInstallation({ root: options.root });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderHumanCliInstallation(report));
    return 0;
  }

  if (options.command === "search") {
    if (options.searchAction === "status") {
      const status = await buildLazurioSearchStatus({
        root: options.root,
        scopeId: options.scope,
      });
      console.log(options.json ? JSON.stringify(status, null, 2) : renderSearchStatus(status));
      return 0;
    }
    if (options.searchAction === "update") {
      const status = await updateLazurioQmdIndex({
        root: options.root,
        scopeId: options.scope,
        embed: options.embed,
      });
      console.log(options.json ? JSON.stringify(status, null, 2) : renderSearchStatus(status));
      return 0;
    }

    const result = options.mode === "exact"
      ? await searchLazurioExact({
          root: options.root,
          scopeId: options.scope,
          query: options.query,
          limit: options.limit,
        })
      : await searchLazurioQmd({
          root: options.root,
          scopeId: options.scope,
          query: options.query,
          mode: options.mode,
          limit: options.limit,
        });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderSearchResults(result));
    return 0;
  }

  throw new Error(`Neznámý příkaz '${options.command ?? ""}'.\n${usage()}`);
}

function parseArgs(argv) {
  const parsed = {
    command: null,
    root: null,
    rootExplicit: false,
    organization: null,
    personalspace: false,
    language: null,
    json: false,
    help: false,
    version: false,
    scope: "lazurio",
    mode: "exact",
    limit: 50,
    embed: false,
    status: false,
    update: false,
    check: false,
    toolUpdates: false,
    refreshPrs: false,
    githubOrganizationId: null,
    apply: false,
    applyPresent: false,
    noApp: false,
    appPackage: null,
    appId: null,
    title: null,
    devScript: null,
    healthPath: "/health",
    surface: "internal",
    tags: [],
    adoptPort: null,
    confirmReplaceAppId: null,
    repairOrganization: null,
    repairModule: null,
    expectedFingerprint: null,
    moduleFlags: new Set(),
    operands: [],
    searchFlags: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!parsed.command && !arg.startsWith("-")) {
      parsed.command = arg;
      continue;
    }
    if (["search", "launchpad", "cli", "organization", "module", "repair"].includes(parsed.command) && !arg.startsWith("-")) {
      parsed.operands.push(arg);
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      parsed.version = true;
      continue;
    }
    if (arg === "--embed") {
      parsed.embed = true;
      parsed.searchFlags.add("--embed");
      continue;
    }
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--tool-updates") {
      parsed.toolUpdates = true;
      continue;
    }
    if (arg === "--refresh-prs") {
      parsed.refreshPrs = true;
      continue;
    }
    if (arg === "--apply" || arg === "--no-app") {
      if (arg === "--apply") {
        parsed.apply = true;
        parsed.applyPresent = true;
      } else {
        parsed.noApp = true;
        parsed.moduleFlags.add(arg);
      }
      continue;
    }
    if (["--org", "--module", "--expect"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} vyžaduje hodnotu.`);
      assignRepairOption(parsed, arg, value);
      index += 1;
      continue;
    }
    const inlineRepairFlag = ["--org", "--module", "--expect"]
      .find((name) => arg.startsWith(`${name}=`));
    if (inlineRepairFlag) {
      assignRepairOption(parsed, inlineRepairFlag, requiredInlineValue(arg, inlineRepairFlag));
      continue;
    }
    if (["--app-package", "--app-id", "--title", "--dev-script", "--health-path", "--surface", "--tags", "--adopt-port", "--confirm-replace"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} vyžaduje hodnotu.`);
      if (arg === "--confirm-replace") parsed.confirmReplaceAppId = value;
      else {
        assignModuleOption(parsed, arg, value);
        parsed.moduleFlags.add(arg);
      }
      index += 1;
      continue;
    }
    const inlineModuleFlag = ["--app-package", "--app-id", "--title", "--dev-script", "--health-path", "--surface", "--tags", "--adopt-port"]
      .find((name) => arg.startsWith(`${name}=`));
    if (inlineModuleFlag) {
      assignModuleOption(parsed, inlineModuleFlag, requiredInlineValue(arg, inlineModuleFlag));
      parsed.moduleFlags.add(inlineModuleFlag);
      continue;
    }
    if (arg.startsWith("--confirm-replace=")) {
      parsed.confirmReplaceAppId = requiredInlineValue(arg, "--confirm-replace");
      continue;
    }
    if (arg === "--github-id") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--github-id vyžaduje immutable GitHub Organization ID.");
      parsed.githubOrganizationId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--github-id=")) {
      parsed.githubOrganizationId = requiredInlineValue(arg, "--github-id");
      continue;
    }
    if (arg === "--status" || arg === "--update") {
      parsed[arg.slice(2)] = true;
      parsed.searchFlags.add(arg);
      continue;
    }
    if (arg === "--scope" || arg === "--mode" || arg === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} vyžaduje hodnotu.`);
      if (arg === "--scope") parsed.scope = value;
      if (arg === "--mode") parsed.mode = value;
      if (arg === "--limit") parsed.limit = Number(value);
      parsed.searchFlags.add(arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      parsed.scope = requiredInlineValue(arg, "--scope");
      parsed.searchFlags.add("--scope");
      continue;
    }
    if (arg.startsWith("--mode=")) {
      parsed.mode = requiredInlineValue(arg, "--mode");
      parsed.searchFlags.add("--mode");
      continue;
    }
    if (arg.startsWith("--limit=")) {
      parsed.limit = Number(requiredInlineValue(arg, "--limit"));
      parsed.searchFlags.add("--limit");
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--root vyžaduje cestu.");
      parsed.root = resolve(value);
      parsed.rootExplicit = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length);
      if (!value) throw new Error("--root vyžaduje cestu.");
      parsed.root = resolve(value);
      parsed.rootExplicit = true;
      continue;
    }
    if (arg === "--organization") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--organization vyžaduje slug.");
      parsed.organization = value;
      index += 1;
      continue;
    }
    if (arg === "--personalspace") {
      parsed.personalspace = true;
      continue;
    }
    if (arg === "--language") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--language vyžaduje cs nebo en.");
      parsed.language = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--language=")) {
      parsed.language = requiredInlineValue(arg, "--language");
      continue;
    }
    if (arg.startsWith("--organization=")) {
      parsed.organization = requiredInlineValue(arg, "--organization");
      continue;
    }
    throw new Error(`Neznámý argument '${arg}'.`);
  }
  if (parsed.command === "search") {
    if (parsed.status && parsed.update) {
      throw new Error("--status a --update se vzájemně vylučují.");
    }
    parsed.searchAction = parsed.status ? "status" : parsed.update ? "update" : "query";
    parsed.query = parsed.searchAction === "query" ? parsed.operands.join(" ") : null;
    if (!new Set(["exact", "lexical", "semantic", "hybrid"]).has(parsed.mode)) {
      throw new Error(`--mode musí být exact, lexical, semantic nebo hybrid.`);
    }
    if (parsed.searchAction === "query" && !parsed.query) {
      throw new Error("search vyžaduje dotaz, --status nebo --update.");
    }
    if (parsed.searchAction !== "query" && parsed.operands.length > 0) {
      throw new Error("--status a --update nepřijímají search dotaz.");
    }
    if (parsed.embed && parsed.searchAction !== "update") {
      throw new Error("--embed lze použít pouze s `lazurio search --update`.");
    }
    if (parsed.searchAction !== "query" && ["--mode", "--limit"].some((flag) => parsed.searchFlags.has(flag))) {
      throw new Error("--mode a --limit lze použít pouze se search dotazem.");
    }
  } else if (parsed.command === "module") {
    if (parsed.searchFlags.size > 0) {
      throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
    }
    const action = parsed.operands[0];
    if (!new Set(["setup", "status", "start", "open", "stop"]).has(action)) {
      throw new Error("module vyžaduje `setup`, `status`, `start`, `open` nebo `stop`.");
    }
    parsed.moduleAction = action;
    if (action === "setup") {
      if ((!parsed.help && parsed.operands.length !== 2) || (parsed.help && parsed.operands.length > 2)) {
        throw new Error("module setup vyžaduje <module-root>.");
      }
      parsed.moduleRoot = parsed.operands[1] ? resolve(parsed.operands[1]) : null;
      if (parsed.surface && !new Set(["internal", "manual", "admin", "public-preview"]).has(parsed.surface)) {
        throw new Error("--surface musí být internal, manual, admin nebo public-preview.");
      }
      if (parsed.adoptPort !== null && !Number.isInteger(parsed.adoptPort)) {
        throw new Error("--adopt-port musí být celé číslo.");
      }
      if (parsed.confirmReplaceAppId !== null) {
        throw new Error("--confirm-replace lze použít pouze s module start nebo module open.");
      }
    } else {
      const selectorOptional = action === "status";
      const expectedLengths = selectorOptional ? new Set([1, 2]) : new Set([2]);
      if (!expectedLengths.has(parsed.operands.length)) {
        throw new Error(`module ${action} ${selectorOptional ? "přijímá volitelný" : "vyžaduje"} selector Organization/Module.`);
      }
      parsed.moduleSelector = parsed.operands[1] ?? null;
      const setupOnlyFlags = [...parsed.moduleFlags].filter((flag) => flag !== "--app-package");
      if (parsed.applyPresent) setupOnlyFlags.push("--apply");
      if (setupOnlyFlags.length > 0) {
        throw new Error(`${setupOnlyFlags.join(", ")} lze použít pouze s \`lazurio module setup\`.`);
      }
      if (parsed.rootExplicit) {
        throw new Error(`module ${action} ovládá přesnou instanci z per-user Server locatoru a nepřijímá --root.`);
      }
      if (parsed.confirmReplaceAppId !== null && !["start", "open"].includes(action)) {
        throw new Error("--confirm-replace lze použít pouze s module start nebo module open.");
      }
    }
  } else if (parsed.command === "repair") {
    if (parsed.searchFlags.size > 0) {
      throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
    }
    if ((!parsed.help && parsed.operands.length !== 1) || parsed.operands[0] !== "module-location") {
      throw new Error("repair vyžaduje jedinou akci `module-location`.");
    }
    if (!parsed.help && (!parsed.repairOrganization || !parsed.repairModule)) {
      throw new Error("repair module-location vyžaduje --org <slug> a --module <slug>.");
    }
    if (parsed.apply && !parsed.expectedFingerprint) {
      throw new Error("--apply vyžaduje fingerprint z check-only kroku přes --expect <fingerprint>.");
    }
    if (!parsed.apply && parsed.expectedFingerprint) {
      throw new Error("--expect lze použít pouze společně s --apply.");
    }
    parsed.repairAction = "module-location";
  } else if (parsed.command === "launchpad") {
    if (parsed.searchFlags.size > 0) {
      throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
    }
    if (parsed.operands.length !== 1 || !new Set(["install", "serve"]).has(parsed.operands[0])) {
      throw new Error("launchpad vyžaduje jedinou akci `install` nebo `serve`.");
    }
    if (parsed.json) {
      throw new Error(`\`lazurio launchpad ${parsed.operands[0]}\` nepodporuje --json; předává živý výstup procesu.`);
    }
    parsed.launchpadAction = parsed.operands[0];
    if (parsed.launchpadAction === "install" && (parsed.organization !== null || parsed.personalspace)) {
      throw new Error("--organization a --personalspace lze použít pouze s `lazurio launchpad serve`.");
    }
    if (parsed.organization !== null && parsed.personalspace) {
      throw new Error("--organization a --personalspace se vzájemně vylučují.");
    }
  } else if (parsed.command === "cli") {
    if (parsed.searchFlags.size > 0) {
      throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
    }
    if (parsed.operands.length === 1 && parsed.operands[0] === "uninstall") {
      throw new Error("`lazurio cli uninstall` není veřejná v0 operace. Exact odregistrování provede Lazurio updater mimo běžící Windows shim.");
    }
    if (parsed.operands.length !== 1 || !new Set(["install", "status", "identity"]).has(parsed.operands[0])) {
      throw new Error("cli vyžaduje jedinou akci `install` nebo `status`.");
    }
    parsed.cliAction = parsed.operands[0];
  } else if (parsed.command === "organization") {
    if (parsed.searchFlags.size > 0) {
      throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
    }
    const action = parsed.operands[0];
    if (!new Set(["activate", "install"]).has(action)) {
      throw new Error("organization vyžaduje `activate` nebo `install`.");
    }
    parsed.organizationAction = action;
    if (action === "activate") {
      if (parsed.operands.length !== 1) throw new Error("organization activate nepřijímá GitHub login.");
      if (!parsed.check) {
        throw new Error("Remote writer zatím není veřejný; použij `lazurio organization activate --check --github-id <id>`.");
      }
      if (parsed.githubOrganizationId === null) {
        throw new Error("organization activate --check vyžaduje --github-id <immutable GitHub Organization ID>.");
      }
      if (parsed.rootExplicit) {
        throw new Error("organization activate --check pracuje s GitHubem a nepřijímá --root.");
      }
    } else {
      if (parsed.operands.length !== 2) {
        throw new Error("organization install vyžaduje <github-login>.");
      }
      if (parsed.check || parsed.githubOrganizationId !== null) {
        throw new Error("organization install přijímá GitHub login, ne --check nebo --github-id.");
      }
      if (parsed.rootExplicit) {
        throw new Error("organization install vždy používá kanonický Lazurio Root v home a nepřijímá --root.");
      }
      parsed.organizationLogin = parsed.operands[1];
    }
  } else if (parsed.searchFlags.size > 0) {
    throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
  }
  if (parsed.moduleFlags.size > 0 && parsed.command !== "module") {
    throw new Error(`${[...parsed.moduleFlags].join(", ")} lze použít pouze s příkazem \`lazurio module\`.`);
  }
  if (parsed.applyPresent && !new Set(["module", "repair"]).has(parsed.command)) {
    throw new Error("--apply lze použít pouze s module setup nebo repair module-location.");
  }
  if (
    (parsed.repairOrganization !== null || parsed.repairModule !== null || parsed.expectedFingerprint !== null)
    && parsed.command !== "repair"
  ) {
    throw new Error("--org, --module a --expect lze použít pouze s repair module-location.");
  }
  if (parsed.confirmReplaceAppId !== null && parsed.command !== "module") {
    throw new Error("--confirm-replace lze použít pouze s module start nebo module open.");
  }
  if (
    parsed.organization !== null
    && parsed.command !== "context"
    && !(parsed.command === "launchpad" && parsed.launchpadAction === "serve")
  ) {
    throw new Error("--organization lze použít pouze s příkazem context nebo launchpad serve.");
  }
  if (parsed.personalspace && !(parsed.command === "launchpad" && parsed.launchpadAction === "serve")) {
    throw new Error("--personalspace lze použít pouze s příkazem launchpad serve.");
  }
  if (parsed.language !== null && parsed.command !== "install") {
    throw new Error("--language lze použít pouze s příkazem install.");
  }
  if (parsed.command === "install" && parsed.rootExplicit) {
    throw new Error("`lazurio install` používá vždy canonical Lazurio Root v domovské složce a nepřijímá --root.");
  }
  if (parsed.check && parsed.command !== "organization") {
    throw new Error("--check lze použít pouze s `lazurio organization activate`.");
  }
  if (parsed.toolUpdates && parsed.command !== "doctor") {
    throw new Error("--tool-updates lze použít pouze s `lazurio doctor`.");
  }
  if (parsed.refreshPrs && parsed.command !== "doctor") {
    throw new Error("--refresh-prs lze použít pouze s `lazurio doctor`.");
  }
  if (parsed.githubOrganizationId !== null && parsed.command !== "organization") {
    throw new Error("--github-id lze použít pouze s `lazurio organization activate`.");
  }
  if (parsed.version && parsed.command !== null) {
    throw new Error("--version nelze kombinovat s příkazem.");
  }
  if (parsed.version && parsed.rootExplicit) {
    throw new Error("--version popisuje nainstalované CLI a nepřijímá --root.");
  }
  return parsed;
}

function requiredInlineValue(arg, name) {
  const value = arg.slice(name.length + 1);
  if (!value) throw new Error(`${name} vyžaduje hodnotu.`);
  return value;
}

function assignModuleOption(parsed, name, value) {
  if (name === "--app-package") parsed.appPackage = value;
  if (name === "--app-id") parsed.appId = value;
  if (name === "--title") parsed.title = value;
  if (name === "--dev-script") parsed.devScript = value;
  if (name === "--health-path") parsed.healthPath = value;
  if (name === "--surface") parsed.surface = value;
  if (name === "--tags") parsed.tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (name === "--adopt-port") parsed.adoptPort = Number(value);
}

function assignRepairOption(parsed, name, value) {
  if (name === "--org") parsed.repairOrganization = value;
  if (name === "--module") parsed.repairModule = value;
  if (name === "--expect") parsed.expectedFingerprint = value;
}

function cliCodeRoot() {
  const packageRoot = realpathSync.native(import.meta.dirname);
  const sourceOrResidentRoot = realpathSync.native(resolve(packageRoot, ".."));
  if ([".git", "lazurio.resident.json", "launchpad.gen3.json"].some(
    (marker) => existsSync(join(sourceOrResidentRoot, marker)),
  )) {
    return sourceOrResidentRoot;
  }
  return packageRoot;
}

function defaultOperatedRoot() {
  const codeRoot = cliCodeRoot();
  const provenance = buildLazurioCliProvenance({ root: codeRoot });
  return operatedRootForCliProvenance({ codeRoot, provenance });
}

function operatedRootForCliProvenance({ codeRoot, provenance }) {
  if (["package", "resident"].includes(provenance.root_kind)) {
    return canonicalLazurioRoot();
  }
  return codeRoot;
}

function usage() {
  return [
    "Lazurio CLI v0 (unstable)",
    "",
    "Použití:",
    "  lazurio --version [--json]",
    "  lazurio install [--language cs|en] [--json]",
    "  lazurio organization activate --check --github-id <id> [--json]",
    "  lazurio organization install <github-login> [--json]",
    "  lazurio context [--organization <slug>] [--json] [--root <cesta>]",
    "  lazurio doctor [--tool-updates] [--refresh-prs] [--json] [--root <cesta>]",
    "  lazurio update [--json] [--root <cesta>]",
    "  lazurio repair module-location --org <slug> --module <slug> [--json] [--root <cesta>]",
    "  lazurio repair module-location --org <slug> --module <slug> --apply --expect <fingerprint> [--json] [--root <cesta>]",
    "  lazurio module setup <module-root> [--apply] [--json] [--root <cesta>]",
    "    nový no-app Module: --no-app",
    "    nová App: --app-package <package.json> --app-id <id> --title <název> --dev-script <script>",
    "    volitelně: --health-path </health> --surface <typ> --tags <a,b> --adopt-port <N>",
    "  lazurio module status [Organization/Module] [--app-package <package.json>] [--json]",
    "  lazurio module start|open <Organization/Module> [--app-package <package.json>] [--confirm-replace <app-id>] [--json]",
    "  lazurio module stop <Organization/Module> [--app-package <package.json>] [--json]",
    "  lazurio cli install [--json] [--root <cesta>]",
    "  lazurio cli status [--json] [--root <cesta>]",
    "  lazurio launchpad install [--root <cesta>]",
    "  lazurio launchpad serve [--organization <slug> | --personalspace] [--root <cesta>]",
    "  lazurio search <dotaz> [--mode exact|lexical|semantic|hybrid] [--scope lazurio] [--limit N] [--json] [--root <cesta>]",
    "  lazurio search --status [--scope lazurio] [--json] [--root <cesta>]",
    "  lazurio search --update [--embed] [--scope lazurio] [--json] [--root <cesta>]",
  ].join("\n");
}

function renderHumanVersion(provenance) {
  if (provenance.status !== "resolved") {
    return `Lazurio CLI · verzi nelze určit (${provenance.reason})`;
  }
  if (provenance.root_kind === "source") {
    return `Lazurio CLI ${provenance.version} · development · ${provenance.source.dirty ? "dirty" : "clean"}`;
  }
  if (provenance.root_kind === "package") {
    return `Lazurio CLI ${provenance.version} · package · npm provenance`;
  }
  const commit = provenance.source.commit.slice(0, 12);
  return `Lazurio CLI ${provenance.version} · ${commit} · ${provenance.artifact.target}`;
}

function renderHumanContext(context) {
  const lines = [
    "Lazurio context v0 · unstable · read-only",
    `Root: ${context.root.kind}`,
    `Principál: ${context.principal.github_username ?? "nezjištěn"} · ${stateText(context.principal)}`,
    `Mašina: ${context.machine.platform}/${context.machine.architecture}`,
    `Personalspace: mount ${stateText(context.personalspace.mount)} · access ${stateText(context.personalspace.access)}`,
  ];

  if (context.organizations_scope === "none") {
    lines.push(`Organization: nevybrána · ${stateText(context.organizations_state)}`);
    return lines.join("\n");
  }

  const [organization] = context.organizations;
  lines.push(
    `Organization: ${organization.display_name} (${organization.slug}) · access ${stateText(organization.access)}`,
    `  Git: ${gitText(organization.git)}`,
    "  Teamy:",
  );
  for (const team of organization.teams) {
    lines.push(
      `    - ${team.display_name} (${team.slug}) · ${team.modules.length} modulů · access ${stateText(team.access)}`,
    );
  }
  lines.push("  Moduly:");
  for (const module of organization.modules) {
    const appSummary = module.apps
      ? ` · Apps ${module.apps.state}${module.apps.open_target_app_id ? ` → ${module.apps.open_target_app_id}` : ""}`
      : "";
    lines.push(
      `    - ${module.slug} · ${module.path} · ${stateText(module.materialization)} · access ${stateText(module.access)} · git ${gitText(module.git)}${appSummary}`,
    );
  }
  lines.push("  Aplikace:");
  if (organization.apps.length === 0) lines.push("    - žádné objevené aplikace");
  for (const app of organization.apps) {
    lines.push(`    - ${app.title} (${app.id}) · ${app.path} · access ${stateText(app.access)}`);
  }
  lines.push(
    "  Vstupní body:",
    `    - AGENTS.md: ${stateText(organization.entrypoints.agents)}${pathSuffix(organization.entrypoints.agents)}`,
    `    - Mission Control: ${stateText(organization.entrypoints.mission_control)}${pathSuffix(organization.entrypoints.mission_control)}`,
    `    - Knowledgebase: ${stateText(organization.entrypoints.knowledgebase)}${pathSuffix(organization.entrypoints.knowledgebase)}`,
  );
  return lines.join("\n");
}

function stateText(value) {
  return `${value.status} (${value.reason})`;
}

function gitText(git) {
  const branch = git.branch ? ` · branch ${git.branch}` : "";
  return `${stateText(git)}${branch} · origin ${stateText(git.origin)}`;
}

function pathSuffix(value) {
  return value.path ? ` · ${value.path}` : "";
}

function renderSearchResults(result) {
  const lines = [
    `${result.scope.display_name} · ${result.mode} · ${result.result_count} výsledků`,
  ];
  for (const item of result.results) {
    lines.push(`${item.path}:${item.line}:${item.column}: ${item.text}`);
  }
  return lines.join("\n");
}

function renderSearchStatus(status) {
  return [
    `${status.scope.display_name} search`,
    `Exact: ${status.exact.status} · ${status.exact.file_count} textových souborů · live`,
    `QMD: ${status.qmd.status} (${status.qmd.reason}) · verze ${status.qmd.version ?? "nezjištěna"}`,
    `Index: ${status.qmd.index.state} · freshness ${status.qmd.freshness.status}`,
  ].join("\n");
}
