import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { configDirectory } from './config.mjs';

const PACKAGE_NAME = 'doubao-cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE = Object.freeze({
  autoUpdate: false,
  updateNotifications: true,
  lastCheckedAt: null,
  latestVersion: null,
  lastNotifiedAt: null,
  lastUpdatedVersion: null,
});

function parseVersion(version) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(version || '').trim());
  if (!match) throw new Error(`invalid semantic version "${version}"`);
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') || [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumber = /^\d+$/u.test(left[index]) ? Number(left[index]) : null;
    const rightNumber = /^\d+$/u.test(right[index]) ? Number(right[index]) : null;
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return Math.sign(left[index].localeCompare(right[index], 'en-US'));
  }
  return 0;
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (let index = 0; index < left.numbers.length; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return Math.sign(left.numbers[index] - right.numbers[index]);
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function updateStatePath(env = process.env) {
  const directory = configDirectory(env);
  return path.join(directory, 'update.json');
}

export async function readUpdateState(env = process.env) {
  const statePath = updateStatePath(env);
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return { ...DEFAULT_STATE, ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_STATE };
    throw new Error(`cannot read update settings at ${statePath}: ${error.message}`);
  }
}

export async function writeUpdateState(state, env = process.env) {
  const statePath = updateStatePath(env);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, statePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return state;
}

export async function setAutoUpdate(enabled, env = process.env) {
  return modifyUpdateState(state => ({
    ...state,
    autoUpdate: Boolean(enabled),
    ...(enabled ? { lastCheckedAt: null } : {}),
  }), env);
}

export async function setUpdateNotifications(enabled, env = process.env) {
  return modifyUpdateState(state => ({
    ...state,
    updateNotifications: Boolean(enabled),
    ...(enabled ? { lastNotifiedAt: null } : {}),
  }), env);
}

export async function cacheUpdateCheck(check, env = process.env) {
  try {
    return await modifyUpdateState(state => ({
      ...state,
      latestVersion: check.latestVersion,
      lastCheckedAt: new Date().toISOString(),
      ...(check.updated ? { lastUpdatedVersion: check.latestVersion } : {}),
    }), env);
  } catch {
    return null;
  }
}

export async function checkForUpdate(currentVersion, options = {}) {
  parseVersion(currentVersion);
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const payload = await response.json();
    parseVersion(payload.version);
    return {
      currentVersion,
      latestVersion: payload.version,
      updateAvailable: compareVersions(currentVersion, payload.version) < 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function installUpdate(version, options = {}) {
  parseVersion(version);
  const spawnImpl = options.spawnImpl || spawnSync;
  const result = spawnImpl('npm', [
    'install', '--global', `${PACKAGE_NAME}@${version}`,
    '--registry=https://registry.npmjs.org', '--replace-registry-host=never',
  ], {
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw new Error(`failed to run npm: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `npm exited with status ${result.status}`);
  }
  return { updated: true, version };
}

function automaticUpdatesDisabled(env) {
  return /^(?:1|true|yes)$/iu.test(env.DOUBAO_CLI_DISABLE_AUTO_UPDATE || '');
}

export function shouldCheckUpdateReminder({ command, json, stderrIsTTY = process.stderr.isTTY, env = process.env }) {
  const ci = Boolean(env.CI) && !/^(?:0|false)$/iu.test(env.CI);
  return Boolean(stderrIsTTY) && !json && !automaticUpdatesDisabled(env)
    && !ci
    && Boolean(command) && !['help', '--help', '-h', 'version', '--version', '-v', 'update'].includes(command);
}

function withinInterval(timestamp, now, interval) {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= 0 && age < interval;
}

// Registry checks and short settings writes use separate locks. A killed
// process's lock expires after a minute.
async function lockUpdates(env, name, wait = false) {
  const directory = path.dirname(updateStatePath(env));
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, name);
  const deadline = Date.now() + 1500;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      return () => fs.rmdir(lockPath).catch(() => {});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 60_000) {
        try { await fs.rmdir(lockPath); }
        catch (removalError) { if (removalError.code !== 'ENOENT') throw removalError; }
        continue;
      }
      if (!wait) return null;
      if (Date.now() >= deadline) throw new Error('update settings are busy; retry the command');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function modifyUpdateState(modify, env) {
  const unlock = await lockUpdates(env, 'update-state.lock', true);
  try {
    const state = await readUpdateState(env);
    const next = modify(state);
    return next === state ? state : await writeUpdateState(next, env);
  } finally {
    await unlock();
  }
}

// Checks and notifications are separately throttled. Record attempts before
// fetching so offline commands do not retry on every invocation.
export async function maybeUpdateReminder(currentVersion, options = {}) {
  const env = options.env || process.env;
  if (automaticUpdatesDisabled(env)) return null;
  let unlock;
  try {
    let state = await readUpdateState(env);
    if (state.autoUpdate || !state.updateNotifications) return null;
    unlock = await lockUpdates(env, 'update-reminder.lock');
    if (!unlock) return null;
    state = await readUpdateState(env);
    if (state.autoUpdate || !state.updateNotifications) return null;
    const now = options.now ?? Date.now();
    const interval = options.intervalMs ?? CHECK_INTERVAL_MS;
    if (!withinInterval(state.lastCheckedAt, now, interval)) {
      state = await modifyUpdateState(current => ({ ...current, lastCheckedAt: new Date(now).toISOString() }), env);
      if (state.autoUpdate || !state.updateNotifications) return null;
      try {
        const check = await checkForUpdate(currentVersion, { ...options, timeoutMs: options.timeoutMs ?? 1000 });
        await modifyUpdateState(current => ({ ...current, latestVersion: check.latestVersion }), env);
      } catch {
        // Keep the previous successful version available while offline.
      }
      state = await readUpdateState(env);
    }
    let notification = null;
    await modifyUpdateState(current => {
      if (current.autoUpdate || !current.updateNotifications || !current.latestVersion
        || compareVersions(currentVersion, current.latestVersion) >= 0
        || withinInterval(current.lastNotifiedAt, now, interval)) return current;
      notification = { currentVersion, latestVersion: current.latestVersion, updateAvailable: true };
      return { ...current, lastNotifiedAt: new Date(now).toISOString() };
    }, env);
    return notification;
  } catch {
    return null;
  } finally {
    await unlock?.();
  }
}

export async function maybeAutoUpdate(currentVersion, options = {}) {
  const env = options.env || process.env;
  if (automaticUpdatesDisabled(env)) return { skipped: 'disabled' };
  try {
    const state = await readUpdateState(env);
    if (!state.autoUpdate) return { skipped: 'not-enabled' };

    const now = options.now || Date.now();
    const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0;
    if (Number.isFinite(lastCheckedAt) && now - lastCheckedAt < (options.intervalMs || CHECK_INTERVAL_MS)) {
      return { skipped: 'not-due', state };
    }

    const check = await checkForUpdate(currentVersion, options);
    await modifyUpdateState(current => ({
      ...current,
      lastCheckedAt: new Date(now).toISOString(),
      latestVersion: check.latestVersion,
    }), env);
    if (!check.updateAvailable) {
      return { ...check, updated: false };
    }
    installUpdate(check.latestVersion, options);
    await modifyUpdateState(current => ({
      ...current,
      lastUpdatedVersion: check.latestVersion,
    }), env);
    return { ...check, updated: true };
  } catch (error) {
    return { error: error.message };
  }
}
