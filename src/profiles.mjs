import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, readProfiles } from './storage.mjs';
import { cdpStatus, withChatClient } from './cdp.mjs';
import { evaluateWithWatchdog } from './protocol.mjs';

export function accountType(code) {
  switch (code) {
    case 0: return 'personal';
    case 101: return 'workspace';
    case 102: return 'feishu_enterprise';
    default: return 'unknown';
  }
}

function accountId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^[1-9]\d{5,24}$/u.test(id) ? id : null;
}

function text(value) { return typeof value === 'string' && value.trim() ? value : null; }

function tenantInfo(id, name, userName) {
  const value = typeof id === 'string' || Number.isSafeInteger(id) ? String(id) : '';
  return /^\d+$/u.test(value) ? { id: value, name: text(name), userName: text(userName) } : null;
}

// Preferences map each Chromium directory to its last account. They do not
// contain the enterprise enum, and a missing tenant is not proof of type 0.
export function readCachedProfiles(dataDir = getDataDir()) {
  const metadata = readProfiles(dataDir);
  const root = path.resolve(dataDir);
  return { ...metadata, profiles: metadata.profiles.map(profile => {
    let account = null;
    const directory = path.resolve(root, profile.directory);
    if (directory !== root && directory.startsWith(root + path.sep)) {
      try {
        const user = JSON.parse(fs.readFileSync(path.join(directory, 'Preferences'), 'utf8')).saman?.last_user;
        const id = accountId(user?.user_id);
        if (id) account = { id, name: text(user.name), type: 'unknown', enterpriseUserType: null,
          tenant: tenantInfo(user.tenant?.id, user.tenant?.name, user.tenant?.username), source: 'cache' };
      } catch { /* Missing or unreadable cache leaves this profile unknown. */ }
    }
    return { ...profile, account };
  }) };
}

export function normalizeProfileAccount(profile) {
  const id = accountId(profile?.entity_id);
  if (!id) return null;
  const code = Number.isInteger(profile.enterprise_user_type) ? profile.enterprise_user_type : null;
  return { id, name: text(profile.nickname), type: code === null ? 'unknown' : accountType(code),
    enterpriseUserType: code,
    tenant: tenantInfo(profile.tenant_info?.tenant_id, profile.tenant_info?.tenant_name, profile.tenant_info?.user_name),
    source: 'live' };
}

// Read only account/profile metadata, never passport tokens or session keys.
// Match by ID, not display name, and pin the active identity across the read.
export async function readAccountProfiles(client, ids, expectedActiveId) {
  const requested = [...new Set(ids.filter(id => accountId(id) === id))];
  if (!accountId(expectedActiveId) || !requested.includes(expectedActiveId)) throw new Error('PROFILE_ACCOUNT_CHANGED');
  const rows = await evaluateWithWatchdog(client, `(async () => {
    const ids = ${JSON.stringify(requested)};
    const expected = ${JSON.stringify(expectedActiveId)};
    const before = await window.neotix.account.getLoginUser();
    if (!before?.isLogin || before.userId !== expected) throw new Error('PROFILE_ACCOUNT_CHANGED');
    const req = await new Promise(resolve => {
      window['@flow-web/desktop:stable'].push([['doubao_profiles_' + crypto.randomUUID()], {}, resolve]);
    });
    const matches = Object.entries(req.m || {}).filter(([, factory]) => {
      const source = factory.toString();
      return source.includes('initApiService') && source.includes('"profile"') && source.includes('"skillsFacade"');
    });
    if (matches.length !== 1) throw new Error('Doubao profile service is unavailable or ambiguous; update the CLI');
    const service = Object.values(req(Number(matches[0][0]))).find(value => typeof value?.MultiProfileInfo === 'function');
    if (!service) throw new Error('Doubao profile service is unavailable; update the CLI');
    const result = await service.MultiProfileInfo({ visit_ids: ids });
    const after = await window.neotix.account.getLoginUser();
    if (!after?.isLogin || after.userId !== expected || after.enterpriseUserType !== before.enterpriseUserType) {
      throw new Error('PROFILE_ACCOUNT_CHANGED');
    }
    if (result?.code || !result?.datas || typeof result.datas !== 'object' || Array.isArray(result.datas)) {
      throw new Error('Doubao account profile metadata could not be read');
    }
    return ids.flatMap(id => {
      const profile = result.datas[id]?.profile_brief;
      if (profile?.entity_id !== id) return [];
      if (id === expected && Number.isInteger(before.enterpriseUserType)
        && Number.isInteger(profile.enterprise_user_type) && profile.enterprise_user_type !== before.enterpriseUserType) {
        throw new Error('PROFILE_ACCOUNT_CHANGED');
      }
      return [{ entity_id: id, nickname: profile.nickname, enterprise_user_type: profile.enterprise_user_type,
        tenant_info: profile.tenant_info ? { tenant_id: profile.tenant_info.tenant_id,
          tenant_name: profile.tenant_info.tenant_name, user_name: profile.tenant_info.user_name } : null }];
    });
  })()`, 15_000);
  return rows.map(normalizeProfileAccount).filter(Boolean);
}

export async function listProfiles(dataDir = getDataDir(), { status = cdpStatus, withClient = withChatClient } = {}) {
  const cached = readCachedProfiles(dataDir);
  const activeId = cached.profiles.find(profile => profile.directory === cached.lastUsed)?.account?.id;
  if (!activeId) return { ...cached, accountLookupError: 'account_identity_unavailable' };
  const cdp = await status();
  if (!cdp.available) return { ...cached, accountLookupError: cdp.identityMismatch ? 'cdp_identity_mismatch' : 'cdp_unavailable' };
  try {
    const ids = [...new Set(cached.profiles.map(profile => profile.account?.id).filter(Boolean))];
    const accounts = await withClient(client => readAccountProfiles(client, ids, activeId));
    const latest = readCachedProfiles(dataDir);
    if (latest.lastUsed !== cached.lastUsed || JSON.stringify(latest.profiles.map(p => [p.directory, p.account?.id]))
      !== JSON.stringify(cached.profiles.map(p => [p.directory, p.account?.id]))) {
      return { ...latest, accountLookupError: 'profile_changed' };
    }
    const byId = new Map(accounts.map(account => [account.id, account]));
    return { ...latest, profiles: latest.profiles.map(profile => ({ ...profile,
      account: byId.get(profile.account?.id) || profile.account })),
      accountLookupError: accounts.length === ids.length ? null : 'incomplete_account_metadata' };
  } catch (error) {
    return { ...readCachedProfiles(dataDir), accountLookupError: error.message.includes('PROFILE_ACCOUNT_CHANGED')
      ? 'account_changed' : 'account_lookup_failed' };
  }
}

export function formatProfiles(result) {
  return result.profiles.map(profile => {
    const active = profile.directory === result.lastUsed ? '*' : ' ';
    const account = profile.account;
    return `${active} ${profile.directory}\t${profile.name}\t${account?.id || '-'}\t${account?.type || 'unknown'}\t${account?.tenant?.id || '-'}\t${account?.tenant?.name || '-'}\t${account?.source || '-'}`;
  }).join('\n');
}
