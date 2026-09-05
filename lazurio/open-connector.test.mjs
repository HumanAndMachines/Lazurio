import { expect, test } from 'bun:test';
import { digest, OPEN_CONNECTOR_RELEASE, validateRuntimeSecrets, validateInstallConfig, assertNoSymlinks, runOpenConnector } from './open-connector-lib.mjs';
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('release is immutable and checksum comparison detects altered bytes', () => {
  expect(Object.isFrozen(OPEN_CONNECTOR_RELEASE)).toBe(true);
  expect(OPEN_CONNECTOR_RELEASE.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(OPEN_CONNECTOR_RELEASE.url).toContain('/v1.5.0/');
  expect(digest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(digest('abc')).not.toBe(digest('abcd'));
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
    { version: 'latest' }, { sha256: '0'.repeat(64) }, { custody: '../secrets/open-connector/mac-pilot' }]) {
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
