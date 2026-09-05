import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

// First consumer: one Apple Silicon workstation. Hosted profiles follow after acceptance.
export const OPEN_CONNECTOR_RELEASE = Object.freeze({
  version: '1.5.0',
  commit: '0eeed9dc8fecaa3d914c8375125680ff2372eced',
  sha256: '804ae35511a6f995c26b87382f48cba339ce8462ea6da1e7c9e12f8ec3924332',
  url: 'https://github.com/oomol-lab/open-connector/releases/download/v1.5.0/open-connector-darwin-arm64',
});
const label = 'ai.lazurio.open-connector';
const domain = () => `gui/${process.getuid()}`;
export const connectorState = () => join(homedir(), 'Library/Application Support/Lazurio/open-connector');
const configPath = () => join(connectorState(), 'config.json');
const plistPath = () => join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const launch = args => execFileSync('/bin/launchctl', args, { stdio: 'pipe' });
function loaded() { try { launch(['print', `${domain()}/${label}`]); return true; } catch { return false; } }
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function validateRuntimeSecrets(secrets) {
  for (const key of ['admin', 'encryption', 'bootstrap']) {
    if (typeof secrets[key] !== 'string' || !/^[a-f0-9]{64}$/.test(secrets[key])) {
      throw new Error(`Missing or invalid ${key} credential; refusing to start.`);
    }
  }
  return secrets;
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
  copyFileSync(fileURLToPath(import.meta.url), workerPath);
  chmodSync(workerPath, 0o600);
}

export async function connectorApi(path, { body, method = body ? 'POST' : 'GET', runtimeToken } = {}) {
  const config = load(configPath());
  const secrets = load(join(config.custody, 'runtime.json'));
  const response = await fetch(`${config.origin}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeToken ?? secrets.admin}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`OpenConnector ${path}: HTTP ${response.status} (${result.error?.code ?? result.error ?? 'request_failed'})`);
  return result;
}

async function health() {
  if (!existsSync(configPath())) return { installed: false, running: false };
  const config = load(configPath());
  let healthy = false;
  try { await connectorApi('/api/auth/session'); healthy = true; } catch { /* stopped or foreign port */ }
  return { installed: true, running: loaded() && healthy, service_loaded: loaded(), version: config.version, origin: config.origin, mcp_url: `${config.origin}/mcp`, custody: config.custody };
}

async function start() {
  if (!existsSync(configPath())) throw new Error('Run open-connector install first.');
  if (!loaded()) launch(['bootstrap', domain(), plistPath()]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await health();
    if (result.running) return result;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('OpenConnector did not become healthy; inspect its local service log.');
}

async function install(root) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This DEV pilot currently supports Apple Silicon macOS only.');
  if (existsSync(configPath())) {
    const config = load(configPath());
    if (loaded()) launch(['bootout', `${domain()}/${label}`]);
    refreshWorker(config);
    return { ...(await start()), changed: false };
  }
  const owner = load(join(root, 'launchpad.gen3.local.json')).personalspace_owner;
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]+$/.test(owner)) throw new Error('A known local Personalspace owner is required.');
  const personal = join(root, 'personalspace', `${owner}_GEN3`);
  const manifest = load(join(personal, 'personal.gen3.json'));
  if (manifest.owner?.github_username !== owner) throw new Error('Personalspace owner mismatch.');
  const custody = join(personal, 'secrets/open-connector/mac-pilot');
  if (existsSync(custody)) throw new Error('Existing custody without install config: preserve it and reconcile before retrying.');
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
  save(configPath(), config);
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  const argumentsXml = [process.execPath, worker, '--worker'].map(value => `<string>${xml(value)}</string>`).join('');
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argumentsXml}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(state, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(state, 'service.log'))}</string></dict></plist>`;
  writeFileSync(join(state, 'service.log'), '', { mode: 0o600, flag: 'wx' });
  writeFileSync(plistPath(), plist, { mode: 0o600, flag: 'wx' });
  return { ...(await start()), changed: true };
}

async function worker() {
  process.umask(0o077);
  const config = load(configPath());
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

export async function runOpenConnector({ action, root }) {
  if (action === 'install') return install(resolve(root));
  if (action === 'start') return start();
  if (action === 'stop') {
    if (loaded()) launch(['bootout', `${domain()}/${label}`]);
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
    const config = load(configPath());
    const integrity = digest(readFileSync(config.binary)) === config.sha256;
    return { ...status, integrity, ok: status.running && integrity };
  }
  throw new Error('Pilot supports install, start, stop, status, configure and doctor.');
}

if (process.argv[2] === '--worker') await worker();
