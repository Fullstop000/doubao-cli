import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { accountType, listProfiles, normalizeProfileAccount, readAccountProfiles, readCachedProfiles } from '../src/profiles.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-profiles-'));
  const dataDir = path.join(root, 'User Data');
  fs.mkdirSync(path.join(dataDir, 'Default'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'Profile 1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'Local State'), JSON.stringify({
    profile: { last_used: 'Default', info_cache: {
      Default: { name: 'Personal profile' }, 'Profile 1': { name: 'Work profile' },
    } },
  }));
  return { root, dataDir };
}

function writePreferences(dataDir, directory, value) {
  const profilePath = path.join(dataDir, directory);
  fs.mkdirSync(profilePath, { recursive: true });
  fs.writeFileSync(path.join(profilePath, 'Preferences'), JSON.stringify(value));
}

function liveClient({ profiles, before = { isLogin: true, userId: '123456', enterpriseUserType: 0 },
  after = before } = {}) {
  let loginCalls = 0;
  const service = { async MultiProfileInfo() { return { code: 0, datas: profiles }; } };
  const factory = function profileFactory() { return 'initApiService "profile" "skillsFacade"'; };
  const context = vm.createContext({ crypto: { randomUUID: () => 'test-request' }, window: {
    neotix: { account: { getLoginUser: async () => loginCalls++ === 0 ? before : after } },
    '@flow-web/desktop:stable': { push: ([, , resolve]) => resolve(requestModule) },
  } });
  const requestModule = Object.assign(index => ({ profileService: service }), { m: { 0: factory } });
  return { async evaluate(expression) { return vm.runInContext(expression, context); }, close() {} };
}

test('account type recognizes documented values and preserves future values as unknown', () => {
  assert.equal(accountType(0), 'personal');
  assert.equal(accountType(101), 'workspace');
  assert.equal(accountType(102), 'feishu_enterprise');
  assert.equal(accountType(103), 'unknown');
  assert.equal(accountType(999), 'unknown');
  assert.equal(accountType('0'), 'unknown');
  assert.equal(accountType(null), 'unknown');
});

test('cached profile metadata maps each Chromium profile without inferring account type', () => {
  const { root, dataDir } = fixture();
  try {
    writePreferences(dataDir, 'Default', { saman: { last_user: {
      user_id: '123456', name: 'Alice', tenant: { id: '1', name: 'ByteDance', username: 'alice' },
      sec_user_id: 'secret', access_token: 'token', email: 'alice@example.test',
    } } });
    writePreferences(dataDir, 'Profile 1', { saman: { last_user: {
      user_id: '234567', name: 'Bob', tenant: { id: '2', name: 'Acme', username: 'bob' },
    } } });
    const result = readCachedProfiles(dataDir);
    assert.deepEqual(result.profiles.map(item => item.account), [
      { id: '123456', name: 'Alice', type: 'unknown', enterpriseUserType: null,
        tenant: { id: '1', name: 'ByteDance', userName: 'alice' }, source: 'cache' },
      { id: '234567', name: 'Bob', type: 'unknown', enterpriseUserType: null,
        tenant: { id: '2', name: 'Acme', userName: 'bob' }, source: 'cache' },
    ]);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('token'), false);
    assert.equal(JSON.stringify(result).includes('alice@example.test'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cached metadata handles missing Preferences and tenant without inventing a personal account', () => {
  const { root, dataDir } = fixture();
  try {
    writePreferences(dataDir, 'Default', { saman: { last_user: { user_id: '345678', name: 'No tenant' } } });
    const result = readCachedProfiles(dataDir);
    assert.equal(result.profiles[0].account.type, 'unknown');
    assert.equal(result.profiles[0].account.tenant, null);
    assert.equal(result.profiles[1].account, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe Local State profile directory cannot read Preferences outside dataDir', () => {
  const { root, dataDir } = fixture();
  try {
    const outside = path.join(root, 'Preferences');
    fs.writeFileSync(outside, JSON.stringify({ saman: { last_user: { user_id: '987654', name: 'Outside' } } }));
    const localStatePath = path.join(dataDir, 'Local State');
    fs.writeFileSync(localStatePath, JSON.stringify({ profile: {
      last_used: '..', info_cache: { '..': { name: 'Unsafe' } },
    } }));
    const result = readCachedProfiles(dataDir);
    assert.equal(result.profiles[0].account, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live account normalization whitelists identity fields and retains server enum code', () => {
  const result = normalizeProfileAccount({ entity_id: '456789', nickname: 'Casey', enterprise_user_type: 102,
    tenant_info: { tenant_id: '2', tenant_name: 'Enterprise', user_name: 'casey' },
    sec_user_id: 'secret', email: 'casey@example.test', token: 'token' });
  assert.deepEqual(result, { id: '456789', name: 'Casey', type: 'feishu_enterprise', enterpriseUserType: 102,
    tenant: { id: '2', name: 'Enterprise', userName: 'casey' }, source: 'live' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('example.test'), false);
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('live account normalization preserves unrecognized server enum values', () => {
  const result = normalizeProfileAccount({ entity_id: '567890', nickname: 'Future', enterprise_user_type: 999 });
  assert.equal(result.type, 'unknown');
  assert.equal(result.enterpriseUserType, 999);
  assert.equal(result.tenant, null);
});

test('personal account preserves the server tenant sentinel without inferring type from it', () => {
  const tenant_info = { tenant_id: '0', tenant_name: '', user_name: '' };
  const result = normalizeProfileAccount({ entity_id: '123456', enterprise_user_type: 0, tenant_info });
  assert.equal(result.type, 'personal');
  assert.deepEqual(result.tenant, { id: '0', name: null, userName: null });
  assert.equal(normalizeProfileAccount({ entity_id: '123456', tenant_info }).type, 'unknown');
});

test('live profile lookup is per requested id and rejects an account switch before returning data', async () => {
  const client = liveClient({ profiles: {
    123456: { profile_brief: { entity_id: '123456', nickname: 'Active', enterprise_user_type: 0 } },
    234567: { profile_brief: { entity_id: '234567', nickname: 'Other', enterprise_user_type: 102 } },
  } });
  const result = await readAccountProfiles(client, ['123456', '234567'], '123456');
  assert.deepEqual(Array.from(result, account => account.id), ['123456', '234567']);

  const mismatched = liveClient({ profiles: {
    123456: { profile_brief: { entity_id: '234567', nickname: 'Wrong entity', enterprise_user_type: 102 } },
  } });
  assert.equal((await readAccountProfiles(mismatched, ['123456'], '123456')).length, 0,
    'response entity_id must match its requested key');

  const switched = liveClient({ profiles: {}, after: { isLogin: true, userId: '234567', enterpriseUserType: 0 } });
  await assert.rejects(readAccountProfiles(switched, ['123456'], '123456'), /PROFILE_ACCOUNT_CHANGED/u);
  const wrongAccount = liveClient({ profiles: {}, before: { isLogin: true, userId: '234567', enterpriseUserType: 0 } });
  await assert.rejects(readAccountProfiles(wrongAccount, ['123456'], '123456'), /PROFILE_ACCOUNT_CHANGED/u);
});

test('listProfiles stays cache-only while offline and enriches each mapped account when online', async () => {
  const { root, dataDir } = fixture();
  try {
    writePreferences(dataDir, 'Default', { saman: { last_user: { user_id: '123456', name: 'Alice' } } });
    writePreferences(dataDir, 'Profile 1', { saman: { last_user: { user_id: '234567', name: 'Bob' } } });
    const offline = await listProfiles(dataDir, { status: async () => ({ available: false, error: 'offline' }) });
    assert.equal(offline.profiles[0].account.type, 'unknown');
    assert.equal(offline.accountLookupError, 'cdp_unavailable');
    assert.equal(offline.profiles[1].account.type, 'unknown');

    const online = await listProfiles(dataDir, {
      status: async () => ({ available: true }),
      withClient: async callback => callback(liveClient({ profiles: {
        123456: { profile_brief: { entity_id: '123456', nickname: 'Alice Live', enterprise_user_type: 0 } },
        234567: { profile_brief: { entity_id: '234567', nickname: 'Bob Live', enterprise_user_type: 102 } },
      } })),
    });
    assert.equal(online.profiles[0].account.type, 'personal');
    assert.equal(online.profiles[0].account.name, 'Alice Live');
    assert.equal(online.profiles[1].account.name, 'Bob Live');
    assert.equal(online.profiles[1].account.type, 'feishu_enterprise');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changing the profile directory mapping during lookup discards live metadata', async () => {
  const { root, dataDir } = fixture();
  try {
    writePreferences(dataDir, 'Default', { saman: { last_user: { user_id: '123456', name: 'Alice' } } });
    const result = await listProfiles(dataDir, {
      status: async () => ({ available: true }),
      withClient: async callback => {
        const accounts = await callback(liveClient({ profiles: {
          123456: { profile_brief: { entity_id: '123456', nickname: 'Alice Live', enterprise_user_type: 0 } },
        } }));
        writePreferences(dataDir, 'Default', { saman: { last_user: { user_id: '234567', name: 'New account' } } });
        return accounts;
      },
    });
    assert.equal(result.accountLookupError, 'profile_changed');
    assert.equal(result.profiles[0].account.id, '234567');
    assert.equal(result.profiles[0].account.source, 'cache');
    assert.equal(result.profiles[0].account.type, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
