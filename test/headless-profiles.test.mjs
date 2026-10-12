import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listHeadlessProfileMetadata } from '../src/headless.mjs';

async function fixture(t, sessions = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-headless-profiles-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  for (const [name, accountId] of Object.entries(sessions)) {
    const directory = name === 'default'
      ? path.join(configDir, 'headless')
      : path.join(configDir, 'headless', 'profiles', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify({
      accountId,
      cookies: [{ name: 'sessionid', value: `private-${name}` }],
    }), { mode: 0o600 });
  }
  return configDir;
}

const liveAccount = (id, name) => ({
  id,
  name,
  type: 'personal',
  enterpriseUserType: null,
  tenant: null,
  source: 'live',
});

test('profiles with no persisted sessions do not attempt metadata lookup', async t => {
  const configDir = await fixture(t);
  let clientCalls = 0;
  const result = await listHeadlessProfileMetadata({
    configDir,
    clientFactory: async () => { clientCalls++; throw new Error('should not be called'); },
  });

  assert.deepEqual(result, {
    defaultProfile: 'default',
    metadataProfile: null,
    profiles: [],
    accountLookupError: 'account_identity_unavailable',
  });
  assert.equal(clientCalls, 0);
});

test('named-only setup selects the named saved profile as metadata source', async t => {
  const configDir = await fixture(t, { work: '12345678' });
  const calls = [];
  const result = await listHeadlessProfileMetadata({
    configDir,
    timeoutMs: 1000,
    clientFactory: async (timeoutMs, name, session) => {
      calls.push({ timeoutMs, name, accountId: session.accountId });
      return { accountId: session.accountId };
    },
    metadataReader: async (client, ids, timeoutMs) => {
      calls.push({ ids, timeoutMs, clientId: client.accountId });
      return { accounts: { '12345678': liveAccount('12345678', 'Work Account') }, incompleteReason: null };
    },
  });

  assert.equal(result.defaultProfile, 'default');
  assert.equal(result.metadataProfile, 'work');
  assert.deepEqual(result.profiles.map(row => row.name), ['work']);
  assert.deepEqual(result.profiles[0].account, liveAccount('12345678', 'Work Account'));
  assert.equal(result.accountLookupError, null);
  assert.deepEqual(calls[0], { timeoutMs: calls[0].timeoutMs, name: 'work', accountId: '12345678' });
  assert.deepEqual(calls[1], { ids: ['12345678'], timeoutMs: calls[1].timeoutMs, clientId: '12345678' });
  assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 1000);
  assert.ok(calls[1].timeoutMs > 0 && calls[1].timeoutMs <= calls[0].timeoutMs);
});

test('default session supplies metadata lookup for default and named account ids', async t => {
  const configDir = await fixture(t, { default: '11111111', work: '22222222' });
  const calls = [];
  const result = await listHeadlessProfileMetadata({
    configDir,
    clientFactory: async (_timeoutMs, name, session) => {
      calls.push({ name, accountId: session.accountId });
      return { accountId: session.accountId };
    },
    metadataReader: async (_client, ids) => {
      calls.push({ ids });
      return { accounts: {
        '11111111': liveAccount('11111111', 'Default Account'),
        '22222222': liveAccount('22222222', 'Work Account'),
      }, incompleteReason: null };
    },
  });

  assert.equal(result.metadataProfile, 'default');
  assert.deepEqual(calls, [
    { name: 'default', accountId: '11111111' },
    { ids: ['11111111', '22222222'] },
  ]);
  assert.deepEqual(result.profiles.map(row => row.account.name), ['Default Account', 'Work Account']);
});

test('partial metadata preserves cached identity and returns the incomplete reason', async t => {
  const configDir = await fixture(t, { default: '11111111', work: '22222222' });
  const result = await listHeadlessProfileMetadata({
    configDir,
    clientFactory: async (_timeoutMs, _name, session) => ({ accountId: session.accountId }),
    metadataReader: async () => ({
      accounts: { '11111111': liveAccount('11111111', 'Default Account') },
      incompleteReason: 'incomplete_account_metadata',
    }),
  });

  assert.deepEqual(result.profiles[0].account, liveAccount('11111111', 'Default Account'));
  assert.deepEqual(result.profiles[1].account, {
    id: '22222222', name: null, type: 'unknown', enterpriseUserType: null, tenant: null, source: 'cache',
  });
  assert.equal(result.accountLookupError, 'incomplete_account_metadata');
});

test('login failure retains cached rows without exposing credential contents', async t => {
  const configDir = await fixture(t, { default: '11111111' });
  const result = await listHeadlessProfileMetadata({
    configDir,
    clientFactory: async () => { throw Object.assign(new Error('login required'), { code: 'login_required' }); },
  });

  assert.equal(result.metadataProfile, 'default');
  assert.equal(result.accountLookupError, 'login_required');
  assert.equal(result.profiles[0].account.source, 'cache');
  assert.equal(JSON.stringify(result).includes('private-default'), false);
});
