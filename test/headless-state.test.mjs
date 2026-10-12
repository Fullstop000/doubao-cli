import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  headlessProfilePaths,
  listHeadlessProfiles,
  loadHeadlessState,
  saveHeadlessState,
  updateHeadlessState,
  validateHeadlessProfileName,
} from '../src/headless-state.mjs';

const ACCOUNT_A = '123456789012';
const ACCOUNT_B = '987654321012';
const CONVERSATION_A = '1234567890123456';

async function temporaryConfig(t, name = 'headless-state-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('headless state is isolated by profile and authenticated account', async t => {
  const configDir = await temporaryConfig(t);
  await updateHeadlessState({ configDir, profile: 'default', accountId: ACCOUNT_A,
    currentConversationId: CONVERSATION_A, defaults: { modelId: 'model-x', reasoning: 'high' } });
  assert.deepEqual(await loadHeadlessState({ configDir, profile: 'default', accountId: ACCOUNT_A }), {
    version: 1, accountId: ACCOUNT_A, currentConversationId: CONVERSATION_A,
    defaults: { modelId: 'model-x', reasoning: 'high' },
  });
  assert.deepEqual(await loadHeadlessState({ configDir, profile: 'default', accountId: ACCOUNT_B }), {
    version: 1, accountId: ACCOUNT_B, currentConversationId: null,
    defaults: { modelId: null, reasoning: null },
  });
  assert.deepEqual(await loadHeadlessState({ configDir, profile: 'work', accountId: ACCOUNT_A }), {
    version: 1, accountId: ACCOUNT_A, currentConversationId: null,
    defaults: { modelId: null, reasoning: null },
  });
  assert.deepEqual(await listHeadlessProfiles({ configDir }), ['default']);
});

test('state writes are atomic and owner-only; default credentials retain their path', async t => {
  const configDir = await temporaryConfig(t);
  const defaultPaths = headlessProfilePaths({ configDir });
  assert.equal(defaultPaths.credentials, path.join(configDir, 'headless', 'session.json'));
  const saved = await saveHeadlessState({ configDir, profile: 'secondary', accountId: ACCOUNT_A,
    state: { accountId: ACCOUNT_A, currentConversationId: CONVERSATION_A,
      defaults: { modelId: 'model-x', reasoning: 'medium' } } });
  assert.equal(saved.currentConversationId, CONVERSATION_A);
  const profilePaths = headlessProfilePaths({ configDir, profile: 'secondary' });
  assert.equal(profilePaths.credentials, path.join(configDir, 'headless', 'profiles', 'secondary', 'session.json'));
  const stat = await fs.stat(profilePaths.state);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(profilePaths.directory), ['state.json']);
  assert.deepEqual(await listHeadlessProfiles({ configDir }), ['secondary']);
});

test('profile names, conversation IDs, model IDs, and defaults are validated', async t => {
  const configDir = await temporaryConfig(t);
  assert.equal(validateHeadlessProfileName('default'), 'default');
  for (const profile of ['../escape', 'two/parts', '', '.hidden', 'name with spaces']) {
    assert.throws(() => headlessProfilePaths({ configDir, profile }), /profile/u);
  }
  await assert.rejects(updateHeadlessState({ configDir, accountId: ACCOUNT_A, currentConversationId: '1234' }), /12 to 24 digits/u);
  await assert.rejects(updateHeadlessState({ configDir, accountId: ACCOUNT_A, defaults: { modelId: '../model' } }), /model id/u);
  await assert.rejects(updateHeadlessState({ configDir, accountId: ACCOUNT_A, defaults: { reasoning: 'off' } }), /reasoning/u);
});

test('headless state rejects symlinked directories and state files', async t => {
  const configDir = await temporaryConfig(t);
  const outside = await temporaryConfig(t, 'headless-state-outside-');
  const root = path.join(configDir, 'headless');
  await fs.symlink(outside, root, 'dir');
  await assert.rejects(updateHeadlessState({ configDir, accountId: ACCOUNT_A,
    currentConversationId: CONVERSATION_A }), /symlink/u);

  await fs.rm(root);
  await fs.mkdir(path.join(root, 'profiles'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'profiles', 'redirect'), 'dir');
  await assert.rejects(updateHeadlessState({ configDir, profile: 'redirect', accountId: ACCOUNT_A,
    currentConversationId: CONVERSATION_A }), /symlink/u);

  const defaultPaths = headlessProfilePaths({ configDir });
  const externalState = path.join(outside, 'state.json');
  await fs.writeFile(externalState, JSON.stringify({ version: 1, accountId: ACCOUNT_A,
    currentConversationId: CONVERSATION_A, defaults: { modelId: null, reasoning: null } }));
  await fs.symlink(externalState, defaultPaths.state);
  await assert.rejects(loadHeadlessState({ configDir, accountId: ACCOUNT_A }), /symlink/u);
  await assert.rejects(updateHeadlessState({ configDir, accountId: ACCOUNT_A,
    currentConversationId: null }), /symlink/u);
  assert.equal(JSON.parse(await fs.readFile(externalState, 'utf8')).currentConversationId, CONVERSATION_A);
});

test('supported reasoning defaults match the CLI effort contract', async t => {
  const configDir = await temporaryConfig(t);
  for (const reasoning of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const state = await updateHeadlessState({ configDir, accountId: ACCOUNT_A, defaults: { reasoning } });
    assert.equal(state.defaults.reasoning, reasoning);
  }
  await assert.rejects(updateHeadlessState({ configDir, accountId: ACCOUNT_A, defaults: { reasoning: 'off' } }), /low, medium, high, xhigh, or max/u);
});
