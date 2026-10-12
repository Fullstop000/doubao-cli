import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkForUpdate,
  compareVersions,
  maybeAutoUpdate,
  maybeUpdateReminder,
  readUpdateState,
  setAutoUpdate,
  setUpdateNotifications,
  writeUpdateState,
  shouldCheckUpdateReminder,
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
      args: ['install', '--global', 'doubao-cli@0.5.0', '--registry=https://registry.npmjs.org', '--replace-registry-host=never'],
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

test('reminds about updates without installing when auto update is off', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-cli-reminder-test-'));
  const env = { ...process.env, DOUBAO_CLI_CONFIG_DIR: directory };
  try {
    const reminder = await maybeUpdateReminder('0.4.2', {
      env,
      now: Date.parse('2026-09-01T00:00:00.000Z'),
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.5.0' }) }),
    });
    assert.equal(reminder.updateAvailable, true);
    assert.equal(reminder.latestVersion, '0.5.0');

    const throttled = await maybeUpdateReminder('0.4.2', {
      env,
      now: Date.parse('2026-09-01T01:00:00.000Z'),
      fetchImpl: async () => {
        throw new Error('should not check before the interval');
      },
    });
    assert.equal(throttled, null);

    const upToDate = await maybeUpdateReminder('0.5.0', {
      env,
      now: Date.parse('2026-09-03T00:00:00.000Z'),
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.5.0' }) }),
    });
    assert.equal(upToDate, null);

    const state = await readUpdateState(env);
    assert.equal(state.autoUpdate, false);
    assert.equal(state.lastUpdatedVersion, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('skips the reminder when auto update is on or disabled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-cli-reminder-test-'));
  const env = { ...process.env, DOUBAO_CLI_CONFIG_DIR: directory };
  const fetchImpl = async () => {
    throw new Error('should not check the registry');
  };
  try {
    await setAutoUpdate(true, env);
    assert.equal(await maybeUpdateReminder('0.4.2', { env, fetchImpl }), null);

    const disabled = { ...env, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' };
    await setAutoUpdate(false, env);
    assert.equal(await maybeUpdateReminder('0.4.2', { env: disabled, fetchImpl }), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function reminderFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-cli-reminder-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { ...process.env, DOUBAO_CLI_CONFIG_DIR: directory, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '' };
}

test('old update settings enable notifications, and muting preserves automatic update preferences', async t => {
  const env = await reminderFixture(t);
  await writeUpdateState({ autoUpdate: false, lastCheckedAt: '2026-09-01T00:00:00.000Z' }, env);
  assert.equal((await readUpdateState(env)).updateNotifications, true);
  const muted = await setUpdateNotifications(false, env);
  assert.equal(muted.autoUpdate, false);
  assert.equal(muted.lastCheckedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(await maybeUpdateReminder('0.4.2', {
    env, fetchImpl: () => assert.fail('muted reminders must not check the registry'),
  }), null);
  assert.equal((await setUpdateNotifications(true, env)).updateNotifications, true);
});

test('offline attempts are silent and throttled, then retry after the daily interval', async t => {
  const env = await reminderFixture(t);
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  let attempts = 0;
  const offline = { env, now, fetchImpl: async () => { attempts += 1; throw new Error('offline'); } };
  assert.equal(await maybeUpdateReminder('0.4.2', offline), null);
  assert.equal(await maybeUpdateReminder('0.4.2', { ...offline, now: now + 3600_000 }), null);
  assert.equal(attempts, 1);
  assert.equal((await readUpdateState(env)).lastCheckedAt, new Date(now).toISOString());
  const result = await maybeUpdateReminder('0.4.2', {
    env, now: now + 24 * 3600_000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.5.0' }) }),
  });
  assert.equal(result.latestVersion, '0.5.0');
});

test('cached newer versions can remind while offline, but an installed newer version never does', async t => {
  const env = await reminderFixture(t);
  const now = Date.parse('2026-09-02T00:00:00.000Z');
  await writeUpdateState({
    autoUpdate: false, updateNotifications: true, latestVersion: '0.5.0',
    lastCheckedAt: new Date(now).toISOString(), lastNotifiedAt: new Date(now - 24 * 3600_000).toISOString(),
  }, env);
  const fetchImpl = () => assert.fail('cached checks must not reach the registry');
  assert.equal((await maybeUpdateReminder('0.4.2', { env, now, fetchImpl })).latestVersion, '0.5.0');
  assert.equal(await maybeUpdateReminder('0.4.2', { env, now: now + 1000, fetchImpl }), null);
  assert.equal(await maybeUpdateReminder('0.5.0', { env, now, fetchImpl }), null);
  assert.equal(await maybeUpdateReminder('0.6.0', { env, now, fetchImpl }), null);
  await writeUpdateState({ ...await readUpdateState(env), lastCheckedAt: null, lastNotifiedAt: null }, env);
  assert.equal((await maybeUpdateReminder('0.4.2', {
    env, now, fetchImpl: async () => { throw new Error('offline'); },
  })).latestVersion, '0.5.0');
});

test('concurrent commands perform one registry check and emit one reminder', async t => {
  const env = await reminderFixture(t);
  let attempts = 0;
  const options = {
    env, fetchImpl: async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ version: '0.5.0' }) };
    },
  };
  const results = await Promise.all([maybeUpdateReminder('0.4.2', options), maybeUpdateReminder('0.4.2', options)]);
  assert.equal(attempts, 1);
  assert.equal(results.filter(Boolean).length, 1);
});

test('a notification commit cannot overwrite a concurrent notify off preference', async t => {
  const env = await reminderFixture(t);
  const originalRename = fs.rename.bind(fs);
  let renameCount = 0;
  let releaseNotificationSave;
  let notificationSaveStarted;
  const notificationSave = new Promise(resolve => { notificationSaveStarted = resolve; });
  let armed = false;
  let stateLockAttempted;
  const stateLockAttempt = new Promise(resolve => { stateLockAttempted = resolve; });

  t.mock.method(fs, 'rename', async (...args) => {
    renameCount += 1;
    if (renameCount === 3) {
      notificationSaveStarted();
      await new Promise(resolve => { releaseNotificationSave = resolve; });
    }
    return originalRename(...args);
  });
  const originalMkdir = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    if (armed && path.basename(directory) === 'update-state.lock') stateLockAttempted();
    return originalMkdir(directory, ...args);
  });

  const reminder = maybeUpdateReminder('0.4.2', {
    env,
    now: Date.parse('2026-09-01T00:00:00.000Z'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.5.0' }) }),
  });
  await notificationSave;
  armed = true;
  const disableNotifications = setUpdateNotifications(false, env);
  await stateLockAttempt;
  releaseNotificationSave();
  await Promise.all([reminder, disableNotifications]);

  assert.equal((await readUpdateState(env)).updateNotifications, false);
});

test('a timed-out reminder aborts its request and does not retry immediately', async t => {
  const env = await reminderFixture(t);
  let aborted = false;
  assert.equal(await maybeUpdateReminder('0.4.2', {
    env, timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }),
  }), null);
  assert.equal(aborted, true);
  assert.equal(await maybeUpdateReminder('0.4.2', {
    env, fetchImpl: () => assert.fail('timeouts must also be throttled'),
  }), null);
});

test('reminder eligibility excludes automation and maintenance commands', () => {
  const eligible = { command: 'status', stderrIsTTY: true, env: {} };
  assert.equal(shouldCheckUpdateReminder(eligible), true);
  for (const overrides of [
    { json: true }, { stderrIsTTY: false }, { env: { CI: 'true' } },
    { env: { DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' } },
    ...['help', '--help', '-h', 'version', '--version', '-v', 'update', undefined].map(command => ({ command })),
  ]) assert.equal(shouldCheckUpdateReminder({ ...eligible, ...overrides }), false);
  assert.equal(shouldCheckUpdateReminder({ ...eligible, env: { CI: 'false' } }), true);
});
