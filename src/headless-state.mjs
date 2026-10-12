import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDirectory } from './config.mjs';

const ACCOUNT_ID = /^[1-9]\d{5,24}$/u;
const CONVERSATION_ID = /^[1-9]\d{11,23}$/u;
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function validateProfile(profile = 'default') {
  if (typeof profile !== 'string' || !PROFILE_NAME.test(profile) || profile === '.' || profile === '..') {
    throw new TypeError('headless profile must use 1 to 64 letters, digits, underscores, or hyphens');
  }
  return profile;
}

function accountId(value) {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) throw new TypeError('account id must contain 6 to 25 digits');
  return value;
}

function conversationId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !CONVERSATION_ID.test(value)) throw new TypeError('conversation id must contain 12 to 24 digits');
  return value;
}

function cleanDefaults(defaults = {}) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new TypeError('headless defaults must be an object');
  let modelId = defaults.modelId ?? null;
  if (modelId !== null && (typeof modelId !== 'string' || !MODEL_ID.test(modelId))) throw new TypeError('model id is invalid');
  let reasoning = defaults.reasoning ?? null;
  if (reasoning !== null && !REASONING.has(reasoning)) throw new TypeError('reasoning must be low, medium, high, xhigh, or max');
  return { modelId, reasoning };
}

function fresh(account) {
  return { version: 1, accountId: account, currentConversationId: null, defaults: { modelId: null, reasoning: null } };
}

function paths(configDir, profile) {
  const name = validateProfile(profile);
  const root = path.join(configDir || configDirectory(), 'headless');
  // Keep the original default session.json location intact for existing users.
  const directory = name === 'default' ? root : path.join(root, 'profiles', name);
  return {
    directory,
    credentials: path.join(directory, 'session.json'),
    state: path.join(directory, 'state.json'),
  };
}

async function assertNoStateSymlinks(configDir, profile, file) {
  const root = path.join(configDir || configDirectory(), 'headless');
  const name = validateProfile(profile);
  const directories = name === 'default' ? [root] : [root, path.join(root, 'profiles'), path.join(root, 'profiles', name)];
  for (const directory of directories) {
    try {
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error(`headless state path must not be a symlink: ${directory}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`headless state file must not be a symlink: ${file}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function validateHeadlessProfileName(profile) {
  return validateProfile(profile);
}

export function headlessProfilePaths({ configDir, profile = 'default' } = {}) {
  return paths(configDir, profile);
}

/** Return profile names with a persisted credential or selection state. */
export async function listHeadlessProfiles({ configDir } = {}) {
  const root = path.join(configDir || configDirectory(), 'headless');
  const names = new Set();
  const defaultFiles = paths(configDir, 'default');
  for (const file of [defaultFiles.credentials, defaultFiles.state]) {
    try { await fs.access(file); names.add('default'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let entries = [];
  try { entries = await fs.readdir(path.join(root, 'profiles'), { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROFILE_NAME.test(entry.name)) continue;
    const profileFiles = paths(configDir, entry.name);
    for (const file of [profileFiles.credentials, profileFiles.state]) {
      try { await fs.access(file); names.add(entry.name); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return [...names].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b));
}

/** Read selections only when they belong to the authenticated account. */
export async function loadHeadlessState({ configDir, profile = 'default', accountId: owner } = {}) {
  const account = accountId(owner);
  const file = paths(configDir, profile).state;
  await assertNoStateSymlinks(configDir, profile, file);
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fresh(account);
    throw new Error(`headless state file is invalid; remove or repair ${file}`, { cause: error });
  }
  // A profile may be logged into a different account later. Never carry its
  // conversation or model defaults into the new account's view.
  if (parsed?.version !== 1 || parsed.accountId !== account) return fresh(account);
  try {
    return {
      version: 1,
      accountId: account,
      currentConversationId: conversationId(parsed.currentConversationId),
      defaults: cleanDefaults(parsed.defaults),
    };
  } catch (error) {
    throw new Error(`headless state file is invalid; remove or repair ${file}`, { cause: error });
  }
}

/** Atomically persist account-scoped local selections with owner-only access. */
export async function saveHeadlessState({ configDir, profile = 'default', accountId: owner, state } = {}) {
  const account = accountId(owner);
  if (!state || state.accountId !== account) throw new Error('headless state account does not match the authenticated account');
  const normalized = {
    version: 1,
    accountId: account,
    currentConversationId: conversationId(state.currentConversationId),
    defaults: cleanDefaults(state.defaults),
  };
  const file = paths(configDir, profile).state;
  await assertNoStateSymlinks(configDir, profile, file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(normalized)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return normalized;
}

/** Apply local CLI selections; this does not mutate a server conversation. */
export async function updateHeadlessState({ configDir, profile = 'default', accountId: owner, currentConversationId, defaults } = {}) {
  const account = accountId(owner);
  const current = await loadHeadlessState({ configDir, profile, accountId: account });
  const next = {
    ...current,
    ...(currentConversationId !== undefined ? { currentConversationId: conversationId(currentConversationId) } : {}),
    ...(defaults !== undefined ? { defaults: cleanDefaults({ ...current.defaults, ...defaults }) } : {}),
  };
  return saveHeadlessState({ configDir, profile, accountId: account, state: next });
}
