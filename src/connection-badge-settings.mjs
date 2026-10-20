import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDirectory } from './config.mjs';

export function connectionBadgeSettingsPath(env = process.env) {
  return path.join(configDirectory(env), 'connection-badge.json');
}

export function readConnectionBadgeSettings(settingsPath = connectionBadgeSettingsPath(), env = process.env) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof settings?.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    return { enabled: settings.enabled };
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: env.DOUBAO_CLI_CONNECTION_BADGE === '1' };
    throw new Error(`cannot read connection badge settings at ${settingsPath}: ${error.message}`);
  }
}

export function setConnectionBadgeEnabled(enabled, settingsPath = connectionBadgeSettingsPath()) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const settings = { enabled };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, settingsPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return settings;
}
