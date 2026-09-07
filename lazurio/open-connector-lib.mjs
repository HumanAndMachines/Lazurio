import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, copyFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

// First consumer: one Apple Silicon workstation. Hosted profiles follow after acceptance.
export const OPEN_CONNECTOR_RELEASE = Object.freeze({
  version: '1.5.0',
  commit: '0eeed9dc8fecaa3d914c8375125680ff2372eced',
  sha256: '804ae35511a6f995c26b87382f48cba339ce8462ea6da1e7c9e12f8ec3924332',
  url: 'https://github.com/oomol-lab/open-connector/releases/download/v1.5.0/open-connector-darwin-arm64',
});
// Explicit DEV-only promotion, not a moving upstream version or installer default.
// Exact upstream CI run 34078620961; ad-hoc signed as its macOS smoke workflow requires.
export const OPEN_CONNECTOR_CANDIDATE = Object.freeze({
  version: '1.5.0-dev.3e36f55e',
  commit: '3e36f55e0b441a8242bf4ec199c7c76393cb70ca',
  sha256: 'ba6acd5498d67799d67d73b4b9d2eadd31453d3c68ec946f218de42dda2c4517',
});
const label = 'ai.lazurio.open-connector';
const apiOrigin = 'http://127.0.0.1:24321';
const domain = () => `gui/${process.getuid()}`;
export const connectorState = () => join(homedir(), 'Library/Application Support/Lazurio/open-connector');
const configPath = () => join(connectorState(), 'config.json');
const plistPath = () => join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const launch = args => execFileSync('/bin/launchctl', args, { stdio: 'pipe' });
export function assertNoSymlinks(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink in OpenConnector path; refusing to follow it.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === dirname(current)) return;
  }
}
export function validateInstallConfig(config, state = connectorState()) {
  const pin = [OPEN_CONNECTOR_RELEASE, OPEN_CONNECTOR_CANDIDATE].find(candidate => candidate.version === config?.version);
  if (!pin || config.sha256 !== pin.sha256 || config.origin !== 'http://localhost:24321' ||
      config.binary !== join(state, `open-connector-${pin.version}`) ||
      typeof config.custody !== 'string' || !isAbsolute(config.custody) ||
      !config.custody.endsWith('/secrets/open-connector/mac-pilot')) {
    throw new Error('Invalid OpenConnector install metadata.');
  }
  return config;
}
function installedConfig() {
  assertNoSymlinks(configPath());
  const config = validateInstallConfig(load(configPath()));
  for (const path of [config.custody, config.binary, join(config.custody, 'runtime.json')]) assertNoSymlinks(path);
  return config;
}
function loaded() { try { launch(['print', `${domain()}/${label}`]); return true; } catch { return false; } }
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function validateRuntimeSecrets(secrets) {
  for (const key of ['admin', 'encryption', 'bootstrap']) {
    if (typeof secrets?.[key] !== 'string' || !/^[a-f0-9]{64}$/.test(secrets[key])) {
      throw new Error(`Missing or invalid ${key} credential; refusing to start.`);
    }
  }
  return secrets;
}

export function clientHeaders(client) {
  if (!['codex', 'claude'].includes(client)) throw new Error('Unknown MCP client.');
  const config = installedConfig();
  assertNoSymlinks(join(config.custody, `${client}.json`));
  const credential = load(join(config.custody, `${client}.json`));
  if (typeof credential.token !== 'string' || !/^oct_[A-Za-z0-9_-]{43}$/.test(credential.token)) {
    throw new Error('Invalid runtime credential.');
  }
  return { Authorization: `Bearer ${credential.token}` };
}

const clientServerName = 'lazurio_open_connector';
const executeAsk = `mcp__${clientServerName}__execute_action`;
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Pure adapter: preserve unrelated config and never replace an existing server.
export function planClientAttachment(client, { source = '', settings = '', executable = process.execPath, worker = join(connectorState(), 'worker.mjs') } = {}) {
  if (!['codex', 'claude'].includes(client)) throw new Error('Attach requires codex or claude.');
  if (![executable, worker].every(path => isAbsolute(path) && !/[\r\n\0]/.test(path))) throw new Error('Invalid helper path.');
  const helper = `${shellQuote(executable)} ${shellQuote(worker)} --headers ${client}`;
  const helpers = [helper];
  // Accept the safe, already-installed pilot spelling without rewriting it.
  if (client === 'claude' && /^[\w/.-]+$/.test(executable) && /^[\w/ .-]+$/.test(worker)) {
    helpers.push(`${executable} "${worker}" --headers claude`);
  }
  const url = 'http://localhost:24321/mcp';
  const conflict = () => { throw new Error('Existing OpenConnector client configuration conflicts; nothing was overwritten. Reconcile it explicitly.'); };
  if (client === 'codex') {
    let parsed;
    try { parsed = Bun.TOML.parse(source); } catch { throw new Error('Invalid Codex TOML; nothing was changed.'); }
    const existing = parsed.mcp_servers?.[clientServerName];
    if (existing) {
      if (existing.url !== url || !helpers.includes(existing.http_headers_helper) ||
          existing.default_tools_approval_mode !== 'prompt' || existing.enabled === false ||
          ['command', 'args', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'oauth'].some(key => key in existing) ||
          (existing.tools?.execute_action?.approval_mode && existing.tools.execute_action.approval_mode !== 'prompt')) conflict();
      return { source, settings };
    }
    const next = `${source}${source.endsWith('\n') || !source ? '' : '\n'}\n[mcp_servers.${clientServerName}]\nurl = ${JSON.stringify(url)}\nhttp_headers_helper = ${JSON.stringify(helper)}\ndefault_tools_approval_mode = "prompt"\n`;
    // Dotted/inline parent tables may prohibit appending. Fail before any write.
    try { Bun.TOML.parse(next); } catch { throw new Error('Codex table layout requires manual reconciliation; nothing was changed.'); }
    return { source: next, settings };
  }
  let config, policy;
  try { config = source ? JSON.parse(source) : {}; policy = settings ? JSON.parse(settings) : {}; }
  catch { throw new Error('Invalid Claude JSON; nothing was changed.'); }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || !object(policy) || (config.mcpServers !== undefined && !object(config.mcpServers)) ||
      (policy.permissions !== undefined && !object(policy.permissions)) ||
      ['ask', 'allow', 'deny'].some(key => policy.permissions?.[key] !== undefined &&
        (!Array.isArray(policy.permissions[key]) || !policy.permissions[key].every(value => typeof value === 'string')))) throw new Error('Invalid Claude configuration shape.');
  const existing = config.mcpServers?.[clientServerName];
  if (existing && (existing.type !== 'http' || existing.url !== url || !helpers.includes(existing.headersHelper) ||
      ['headers', 'oauth', 'command', 'args'].some(key => key in existing))) conflict();
  if (!existing) {
    config.mcpServers = { ...config.mcpServers, [clientServerName]: { type: 'http', url, headersHelper: helper } };
    source = `${JSON.stringify(config, null, 2)}\n`;
  }
  if (!policy.permissions?.ask?.includes(executeAsk)) {
    policy.permissions = { ...policy.permissions, ask: [...(policy.permissions?.ask ?? []), executeAsk] };
    settings = `${JSON.stringify(policy, null, 2)}\n`;
  }
  return { source, settings };
}

function readClientFile(path) {
  assertNoSymlinks(path);
  if (!existsSync(path)) return '';
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw new Error('Client config must be a regular file owned by the current user.');
  return readFileSync(path, 'utf8');
}

export function writeClientFile(path, before, after) {
  if (before === after) return false;
  if (readClientFile(path) !== before) throw new Error('Client config changed concurrently; retry attach.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertNoSymlinks(path);
  const temporary = `${path}.open-connector-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporary, after, { mode: 0o600, flag: 'wx' });
    if (readClientFile(path) !== before) throw new Error('Client config changed concurrently; retry attach.');
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return true;
}

async function attachClient(client) {
  if (process.platform !== 'darwin') throw new Error('Client attachment currently supports the macOS pilot only.');
  if (!['codex', 'claude'].includes(client)) throw new Error('Attach requires codex or claude.');
  if (process.env.CLAUDE_CONFIG_DIR && client === 'claude') throw new Error('Custom CLAUDE_CONFIG_DIR requires explicit configuration; default files were not changed.');
  const config = installedConfig();
  const credentialPath = join(config.custody, `${client}.json`);
  if (!existsSync(credentialPath)) throw new Error('Missing scoped client credential. Configure a separate runtime token in OpenConnector and store it in client custody first; attach never creates grants.');
  clientHeaders(client); // Validate without printing or passing the credential to config writers.
  if ((lstatSync(credentialPath).mode & 0o777) !== 0o600) throw new Error('Client credential must have mode 0600.');
  const worker = join(connectorState(), 'worker.mjs');
  assertNoSymlinks(worker);
  if (!existsSync(worker)) throw new Error('Installed header helper is missing; reconcile the installation first.');
  const file = client === 'codex' ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml') : join(homedir(), '.claude.json');
  if (!isAbsolute(file)) throw new Error('Client configuration directory must be absolute.');
  const policyFile = join(homedir(), '.claude/settings.json');
  const lock = join(connectorState(), 'attach.lock');
  try { save(lock, { pid: process.pid, createdAt: new Date().toISOString() }); }
  catch { throw new Error('Attach lock exists or cannot be created; reconcile its recorded process before retrying.'); }
  try {
    const source = readClientFile(file);
    const settings = client === 'claude' ? readClientFile(policyFile) : '';
    const planned = planClientAttachment(client, { source, settings, worker });
    // Restrictive approval first: a partial failure never exposes an ungated new server.
    let changed = client === 'claude' ? writeClientFile(policyFile, settings, planned.settings) : false;
    changed = writeClientFile(file, source, planned.source) || changed;
    return { ok: true, client, server: clientServerName, status: changed ? 'attached' : 'already_attached', restart_client: changed, grants_changed: false };
  } finally { unlinkSync(lock); }
}

function refreshWorker(config) {
  const secretPath = join(config.custody, 'runtime.json');
  const secrets = load(secretPath);
  // Upgrade only the empty pre-acceptance pilot. Never rotate existing credentials.
  if (secrets.bootstrap === undefined) {
    secrets.bootstrap = randomBytes(32).toString('hex');
    validateRuntimeSecrets(secrets);
    const temporary = `${secretPath}.bootstrap-${randomBytes(6).toString('hex')}`;
    save(temporary, secrets);
    renameSync(temporary, secretPath);
  }
  validateRuntimeSecrets(secrets);
  const workerPath = join(connectorState(), 'worker.mjs');
  assertNoSymlinks(workerPath);
  const temporaryWorker = `${workerPath}.${randomBytes(6).toString('hex')}`;
  writeFileSync(temporaryWorker, readFileSync(fileURLToPath(import.meta.url)), { mode: 0o600, flag: 'wx' });
  renameSync(temporaryWorker, workerPath);
}

export async function connectorApi(path, { body, method = body ? 'POST' : 'GET', runtimeToken } = {}) {
  const config = installedConfig();
  const secrets = load(join(config.custody, 'runtime.json'));
  const response = await fetch(`${apiOrigin}${path}`, {
    method, redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeToken ?? secrets.admin}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`OpenConnector ${path}: HTTP ${response.status} (${result.error?.code ?? result.error ?? 'request_failed'})`);
  return result;
}

async function health() {
  if (!existsSync(configPath())) return { installed: false, running: false };
  const config = installedConfig();
  let healthy = false;
  // Liveness never discloses an admin credential to an unverified listener.
  try {
    const response = await fetch(`${apiOrigin}/api/auth/session`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    const session = await response.json();
    healthy = response.ok && session.authenticated === false && session.adminAuthConfigured === true;
  } catch { /* stopped or foreign port */ }
  return { installed: true, running: loaded() && healthy, service_loaded: loaded(), version: config.version, origin: config.origin, mcp_url: `${config.origin}/mcp`, custody: config.custody };
}

// Public machine-local projection. Never forward custody, credentials or raw errors to Launchpad.
export async function connectorConsoleStatus({ platform = process.platform, readStatus = health } = {}) {
  if (platform !== 'darwin') return { installed: false, running: false };
  try {
    const status = await readStatus();
    if (!status.installed) return { installed: false, running: false };
    // The pilot has one supported console origin; malformed metadata cannot create an external link.
    if (status.origin !== 'http://localhost:24321') return { installed: false, running: false };
    return {
      installed: true,
      running: status.running === true,
      configure_url: status.running === true ? status.origin : null,
    };
  } catch {
    return { installed: false, running: false };
  }
}

async function start() {
  if (!existsSync(configPath())) throw new Error('Run open-connector install first.');
  if (!existsSync(plistPath())) throw new Error(`Missing LaunchAgent: ${plistPath()}; rerun open-connector install.`);
  if (!loaded()) launch(['bootstrap', domain(), plistPath()]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await health();
    if (result.running) return result;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('OpenConnector did not become healthy; inspect its local service log.');
}

async function stop() {
  if (loaded()) launch(['bootout', `${domain()}/${label}`]);
  // launchctl bootout returns before launchd finishes removing the job.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!loaded()) return;
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('OpenConnector service is still stopping; retry after it exits.');
}

async function install(root) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This DEV pilot currently supports Apple Silicon macOS only.');
  assertNoSymlinks(connectorState());
  mkdirSync(connectorState(), { recursive: true, mode: 0o700 });
  const lock = join(connectorState(), 'install.lock');
  try { save(lock, { pid: process.pid, createdAt: new Date().toISOString() }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Install lock exists: ${lock}. Verify its recorded process before reconciling; no credentials were removed.`);
    throw error;
  }
  try { return await installLocked(root); }
  finally { unlinkSync(lock); }
}

async function installLocked(root) {
  assertNoSymlinks(join(root, 'launchpad.gen3.local.json'));
  const owner = load(join(root, 'launchpad.gen3.local.json')).personalspace_owner;
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]+$/.test(owner)) throw new Error('A known local Personalspace owner is required.');
  const personal = join(root, 'personalspace', `${owner}_GEN3`);
  assertNoSymlinks(join(personal, 'personal.gen3.json'));
  const manifest = load(join(personal, 'personal.gen3.json'));
  if (manifest.owner?.github_username !== owner) throw new Error('Personalspace owner mismatch.');
  const custody = join(personal, 'secrets/open-connector/mac-pilot');
  assertNoSymlinks(custody);
  assertNoSymlinks(plistPath());
  if (existsSync(configPath())) {
    const config = installedConfig();
    if (config.custody !== custody) throw new Error('Installed OpenConnector belongs to another Root or owner.');
    const workerPath = join(connectorState(), 'worker.mjs');
    assertNoSymlinks(workerPath);
    const needsRefresh = !existsSync(workerPath) || digest(readFileSync(workerPath)) !== digest(readFileSync(fileURLToPath(import.meta.url))) ||
      !existsSync(plistPath()) || readFileSync(plistPath(), 'utf8') !== renderLaunchAgent();
    if (needsRefresh) {
      await stop();
      refreshWorker(config);
      const temporaryPlist = `${plistPath()}.${randomBytes(6).toString('hex')}`;
      writeFileSync(temporaryPlist, renderLaunchAgent(), { mode: 0o600, flag: 'wx' });
      renameSync(temporaryPlist, plistPath());
    }
    return { ...(await start()), changed: needsRefresh };
  }
  if (existsSync(custody)) throw new Error('Existing custody without install config: preserve it and reconcile before retrying.');
  for (const artifact of [join(connectorState(), 'open-connector-1.5.0'), join(connectorState(), 'worker.mjs'), join(connectorState(), 'service.log'), plistPath()]) {
    if (existsSync(artifact)) throw new Error(`Incomplete install artifact: ${artifact}. Preserve it and reconcile before retrying.`);
  }
  const response = await fetch(OPEN_CONNECTOR_RELEASE.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Release download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== OPEN_CONNECTOR_RELEASE.sha256) throw new Error('Release checksum mismatch.');
  const state = connectorState();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const binary = join(state, 'open-connector-1.5.0');
  writeFileSync(binary, bytes, { mode: 0o700, flag: 'wx' });
  execFileSync('/usr/bin/codesign', ['--verify', binary], { stdio: 'pipe' });
  mkdirSync(custody, { recursive: true, mode: 0o700 });
  mkdirSync(join(custody, 'data'), { mode: 0o700 });
  save(join(custody, 'runtime.json'), { admin: randomBytes(32).toString('hex'), encryption: randomBytes(32).toString('hex'), bootstrap: randomBytes(32).toString('hex') });
  const config = { version: OPEN_CONNECTOR_RELEASE.version, sha256: OPEN_CONNECTOR_RELEASE.sha256, origin: 'http://localhost:24321', custody, binary };
  const worker = join(state, 'worker.mjs');
  copyFileSync(fileURLToPath(import.meta.url), worker);
  chmodSync(worker, 0o600);
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  writeFileSync(join(state, 'service.log'), '', { mode: 0o600, flag: 'wx' });
  writeFileSync(plistPath(), renderLaunchAgent(), { mode: 0o600, flag: 'wx' });
  // Publish the installed marker only after every required artifact exists.
  save(configPath(), config);
  return { ...(await start()), changed: true };
}

async function worker() {
  process.umask(0o077);
  const config = installedConfig();
  if (digest(readFileSync(config.binary)) !== config.sha256) throw new Error('Installed binary integrity check failed.');
  const secrets = validateRuntimeSecrets(load(join(config.custody, 'runtime.json')));
  const child = spawn(config.binary, [], {
    cwd: connectorState(), stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
      HOST: '127.0.0.1', PORT: '24321', OOMOL_CONNECT_ORIGIN: config.origin,
      OOMOL_CONNECT_DATA_DIR: join(config.custody, 'data'),
      OOMOL_CONNECT_ENCRYPTION_KEY: secrets.encryption, OOMOL_CONNECT_ADMIN_TOKEN: secrets.admin,
      OOMOL_CONNECT_RUNTIME_TOKEN: secrets.bootstrap,
      OOMOL_CONNECT_BLOCKED_PROXIES: '*', OOMOL_CONNECT_BLOCKED_ACTIONS: 'github.*',
    },
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
}

export async function runOpenConnector({ action, root, client }) {
  if (action === 'attach') return attachClient(client);
  if (action === 'install') return install(resolve(root));
  if (action === 'start') return start();
  if (action === 'stop') {
    await stop();
    return health();
  }
  if (action === 'status') return health();
  if (action === 'configure') {
    const status = await start();
    return { ...status, configure_url: status.origin, admin_token_file: join(status.custody, 'runtime.json') };
  }
  if (action === 'doctor') {
    const status = await health();
    if (!status.installed) return { ...status, ok: false };
    const config = installedConfig();
    const integrity = existsSync(config.binary) && digest(readFileSync(config.binary)) === config.sha256;
    return { ...status, integrity, ok: status.running && integrity };
  }
  throw new Error('Pilot supports install, start, stop, status, configure and doctor.');
}

export function renderLaunchAgent(executable = process.execPath, state = connectorState()) {
  const argumentsXml = [executable, join(state, 'worker.mjs'), '--worker'].map(value => `<string>${xml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argumentsXml}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(state, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(state, 'service.log'))}</string></dict></plist>`;
}

if (import.meta.main && process.argv[2] === '--worker') await worker();
// Harness-owned credential protocol, never a human-facing CLI status command.
if (import.meta.main && process.argv[2] === '--headers') process.stdout.write(JSON.stringify(clientHeaders(process.argv[3])));
