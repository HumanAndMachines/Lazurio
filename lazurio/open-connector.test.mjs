import { expect, test } from 'bun:test';
import { digest, OPEN_CONNECTOR_RELEASE, OPEN_CONNECTOR_CANDIDATE, validateRuntimeSecrets, validateInstallConfig, assertNoSymlinks, runOpenConnector, renderLaunchAgent, connectorConsoleStatus, planClientAttachment, writeClientFile } from './open-connector-lib.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync, realpathSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('release is immutable and checksum comparison detects altered bytes', () => {
  expect(Object.isFrozen(OPEN_CONNECTOR_RELEASE)).toBe(true);
  expect(OPEN_CONNECTOR_RELEASE.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(OPEN_CONNECTOR_RELEASE.url).toContain('/v1.5.0/');
  expect(digest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(digest('abc')).not.toBe(digest('abcd'));
});

const attachmentFixture = { executable: '/opt/bun', worker: '/state with spaces/worker.mjs' };
test('DEV candidate pin is exact and cannot mix a stable filename or checksum', () => {
  const state = '/Users/example/state';
  const candidate = { version: OPEN_CONNECTOR_CANDIDATE.version, sha256: OPEN_CONNECTOR_CANDIDATE.sha256,
    origin: 'http://localhost:24321', binary: join(state, `open-connector-${OPEN_CONNECTOR_CANDIDATE.version}`),
    custody: '/Users/example/personalspace/owner_GEN3/secrets/open-connector/mac-pilot' };
  expect(Object.isFrozen(OPEN_CONNECTOR_CANDIDATE)).toBe(true);
  expect(validateInstallConfig(candidate, state)).toEqual(candidate);
  for (const delta of [{ sha256: OPEN_CONNECTOR_RELEASE.sha256 }, { binary: join(state, 'open-connector-1.5.0') },
    { version: '1.5.0-dev.latest' }, { sha256: '6bf8be3c243d8927988c04f0be2e0925f90039c855a577ed8ce83e6cd7f67dc0' }]) {
    expect(() => validateInstallConfig({ ...candidate, ...delta }, state)).toThrow('Invalid');
  }
});
test('Codex attachment preserves existing text and is byte-idempotent', () => {
  const source = '# Keep my comment\nmodel = "example"\n[mcp_servers.other]\nurl = "https://example.test/mcp"\n';
  const planned = planClientAttachment('codex', { ...attachmentFixture, source });
  expect(planned.source.startsWith(source)).toBe(true);
  const server = Bun.TOML.parse(planned.source).mcp_servers.lazurio_open_connector;
  expect(server.default_tools_approval_mode).toBe('prompt');
  expect(server.http_headers_helper).toContain("'/state with spaces/worker.mjs'");
  expect(server.http_headers).toBeUndefined();
  expect(planClientAttachment('codex', { ...attachmentFixture, ...planned })).toEqual(planned);
  expect(() => planClientAttachment('codex', { ...attachmentFixture, source: planned.source.replace('"prompt"', '"approve"') })).toThrow('conflicts');
  expect(() => planClientAttachment('codex', { ...attachmentFixture, source: planned.source + '\n[mcp_servers.lazurio_open_connector.tools.execute_action]\napproval_mode = "approve"\n' })).toThrow('conflicts');
});

test('Claude attachment preserves other servers and policies and gates execution first', () => {
  const source = JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'http', url: 'https://example.test' } } });
  const settings = JSON.stringify({ permissions: { allow: ['Read'], deny: ['Bash'], ask: ['Write'] } });
  const planned = planClientAttachment('claude', { ...attachmentFixture, source, settings });
  expect(JSON.parse(planned.source).mcpServers.other).toEqual(JSON.parse(source).mcpServers.other);
  expect(JSON.parse(planned.source).theme).toBe('dark');
  expect(JSON.parse(planned.settings).permissions).toEqual({ allow: ['Read'], deny: ['Bash'], ask: ['Write', 'mcp__lazurio_open_connector__execute_action'] });
  expect(planClientAttachment('claude', { ...attachmentFixture, ...planned })).toEqual(planned);
  expect(() => planClientAttachment('claude', { ...attachmentFixture, source: planned.source.replace('http://localhost:24321/mcp', 'https://example.test') })).toThrow('conflicts');
});

test('attachment rejects malformed input without echoing secret-bearing contents', () => {
  for (const client of ['claude', 'codex']) {
    expect(() => planClientAttachment(client, { ...attachmentFixture, source: 'DO_NOT_ECHO_SECRET = [' })).toThrow(client === 'codex' ? 'Invalid Codex TOML' : 'Invalid Claude JSON');
  }
  expect(() => planClientAttachment('other', attachmentFixture)).toThrow('codex or claude');
  expect(() => planClientAttachment('claude', { ...attachmentFixture, settings: '[]' })).toThrow('shape');
});

test('CLI attach rejects missing or unknown clients before touching the machine', () => {
  for (const operands of [['attach'], ['attach', 'unknown'], ['status', 'codex']]) {
    const child = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.mjs'), 'open-connector', ...operands], { encoding: 'utf8', timeout: 10000 });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('attach codex|claude');
  }
});

test.skipIf(process.platform === 'win32')('client config writes are private, idempotent and reject changed files and symlinks', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'lazurio-attach-test-'));
  const file = join(dir, 'config.json');
  try {
    expect(writeClientFile(file, '', '{"test":true}\n')).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(writeClientFile(file, '{"test":true}\n', '{"test":true}\n')).toBe(false);
    writeFileSync(file, 'changed');
    expect(() => writeClientFile(file, '{"test":true}\n', 'replacement')).toThrow('concurrently');
    expect(readFileSync(file, 'utf8')).toBe('changed');
    symlinkSync(file, join(dir, 'alias'));
    expect(() => writeClientFile(join(dir, 'alias'), 'changed', 'replacement')).toThrow('Symlink');
  } finally { rmSync(dir, { recursive: true }); }
});

test('console discovery exposes only a healthy local link and never custody or secrets', async () => {
  const status = { installed: true, running: true, origin: 'http://localhost:24321', custody: '/private/owner', token: 'secret' };
  expect(await connectorConsoleStatus({ platform: 'darwin', readStatus: async () => status })).toEqual({
    installed: true, running: true, configure_url: 'http://localhost:24321',
  });
  expect(await connectorConsoleStatus({ platform: 'darwin', readStatus: async () => ({ ...status, running: false }) })).toEqual({
    installed: true, running: false, configure_url: null,
  });
  for (const origin of ['https://example.com', 'javascript:alert(1)', 'http://localhost:24321/?token=secret']) {
    expect(await connectorConsoleStatus({ platform: 'darwin', readStatus: async () => ({ ...status, origin }) })).toEqual({ installed: false, running: false });
  }
  expect(await connectorConsoleStatus({ platform: 'darwin', readStatus: async () => { throw new Error('/private/secret'); } })).toEqual({ installed: false, running: false });
  let reads = 0;
  expect(await connectorConsoleStatus({ platform: 'linux', readStatus: async () => { reads++; return status; } })).toEqual({ installed: false, running: false });
  expect(reads).toBe(0);
});

test('importing the library cannot invoke either private executable entrypoint', () => {
  for (const flag of ['--headers', '--worker']) {
    const code = `process.argv[2] = ${JSON.stringify(flag)}; process.argv[3] = 'claude'; await import(${JSON.stringify(new URL('./open-connector-lib.mjs', import.meta.url).href)});`;
    const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('');
  }
});

test('LaunchAgent rendering tracks the actual interpreter and escapes XML paths', () => {
  const before = renderLaunchAgent('/old/bun', '/state');
  const after = renderLaunchAgent('/new/bun', '/state');
  expect(before).not.toBe(after);
  expect(after).toContain('<string>/new/bun</string>');
  expect(renderLaunchAgent('/a&b/bun', '/state')).toContain('/a&amp;b/bun');
});

test('worker fails closed before spawning when any startup credential is absent', () => {
  const valid = { admin: 'a'.repeat(64), encryption: 'b'.repeat(64), bootstrap: 'c'.repeat(64) };
  expect(validateRuntimeSecrets(valid)).toEqual(valid);
  for (const key of Object.keys(valid)) {
    for (const value of [undefined, '', 'short', 42, 'z'.repeat(64)]) {
      expect(() => validateRuntimeSecrets({ ...valid, [key]: value })).toThrow('refusing to start');
    }
  }
});

test('unknown operations do not mutate the workstation', async () => {
  await expect(runOpenConnector({ action: 'unknown', root: '/' })).rejects.toThrow('Pilot supports');
});

test('install metadata cannot redirect credentials or select another binary', () => {
  const state = '/Users/example/state';
  const valid = { version: OPEN_CONNECTOR_RELEASE.version, sha256: OPEN_CONNECTOR_RELEASE.sha256,
    origin: 'http://localhost:24321', binary: join(state, 'open-connector-1.5.0'),
    custody: '/Users/example/personalspace/owner_GEN3/secrets/open-connector/mac-pilot' };
  expect(validateInstallConfig(valid, state)).toEqual(valid);
  for (const delta of [{ origin: 'https://example.com' }, { binary: '/bin/sh' },
    { version: 'latest' }, { sha256: OPEN_CONNECTOR_CANDIDATE.sha256 }, { sha256: '0'.repeat(64) }, { custody: '../secrets/open-connector/mac-pilot' }]) {
    expect(() => validateInstallConfig({ ...valid, ...delta }, state)).toThrow('Invalid');
  }
  expect(() => validateRuntimeSecrets(null)).toThrow('refusing to start');
});

test.skipIf(process.platform === 'win32')('symlink ancestors are rejected even when the target file is absent', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'lazurio-connector-test-'));
  try {
    symlinkSync(dir, join(dir, 'alias'));
    expect(() => assertNoSymlinks(join(dir, 'alias', 'absent.json'))).toThrow('Symlink');
    expect(() => assertNoSymlinks(join(dir, 'absent.json'))).not.toThrow();
  } finally { rmSync(dir, { recursive: true }); }
});
