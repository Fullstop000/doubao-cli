import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDirectory } from '../config.mjs';

export const skinSettingsPath = (env = process.env) => path.join(configDirectory(env), 'skin.json');

export function readSkinSettings(env = process.env) {
  const settingsPath = skinSettingsPath(env);
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof settings?.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    return { enabled: settings.enabled, settingsPath };
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: true, settingsPath };
    throw new Error(`Cannot read skin settings: ${error.message}`);
  }
}

export function setSkinEnabled(enabled, env = process.env) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const settingsPath = skinSettingsPath(env);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ enabled }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, settingsPath);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { enabled, settingsPath };
}
