import { expect, test } from 'bun:test';
import { digest, OPEN_CONNECTOR_RELEASE, validateRuntimeSecrets, runOpenConnector } from './open-connector-lib.mjs';

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
