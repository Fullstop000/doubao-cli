import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkForUpdate,
  compareVersions,
  maybeAutoUpdate,
  readUpdateState,
  setAutoUpdate,
} from '../src/update.mjs';

test('compares stable and prerelease semantic versions', () => {
  assert.equal(compareVersions('0.5.0', '0.4.2'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.10'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('checks the npm registry without installing', async () => {
  const result = await checkForUpdate('0.4.2', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: '0.5.0' }),
    }),
  });

  assert.deepEqual(result, {
    currentVersion: '0.4.2',
    latestVersion: '0.5.0',
    updateAvailable: true,
  });
});

test('persists opt-in automatic updates and runs them only when due', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-cli-update-test-'));
  const env = { ...process.env, DOUBAO_CLI_CONFIG_DIR: directory };
  const installs = [];
  try {
    const enabled = await setAutoUpdate(true, env);
    assert.equal(enabled.autoUpdate, true);

    const first = await maybeAutoUpdate('0.4.2', {
      env,
      now: Date.parse('2026-09-01T00:00:00.000Z'),
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.5.0' }) }),
      spawnImpl: (command, args) => {
        installs.push({ command, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(first.updated, true);
    assert.deepEqual(installs, [{
      command: 'npm',
      args: ['install', '--global', 'doubao-cli@0.5.0'],
    }]);

    const second = await maybeAutoUpdate('0.4.2', {
      env,
      now: Date.parse('2026-09-01T01:00:00.000Z'),
      fetchImpl: async () => {
        throw new Error('should not check before the interval');
      },
      spawnImpl: () => {
        throw new Error('should not install before the interval');
      },
    });
    assert.equal(second.skipped, 'not-due');

    const state = await readUpdateState(env);
    assert.equal(state.lastUpdatedVersion, '0.5.0');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
