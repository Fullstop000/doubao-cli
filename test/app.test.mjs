import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { resolveApp, currentApp, withApp, agentWorkspace, isAppTarget } from '../src/app.mjs';
import { cdpStatus, withChatClient } from '../src/cdp.mjs';
import { currentSession } from '../src/storage.mjs';
import { runtimeParameters } from '../src/protocol.mjs';
import { main, parseOptions } from '../src/cli.mjs';
import { conversationDeepLink } from '../src/automation.mjs';

const work = resolveApp('work', {});
const doubao = resolveApp('doubao', {});

test('auto prefers installed Work and only falls back when it is absent', () => {
  assert.equal(resolveApp(undefined, {}, () => true).id, 'work');
  assert.equal(resolveApp(undefined, {}, () => false).id, 'doubao');
  assert.equal(resolveApp('work', {}, () => false).id, 'work');
  assert.equal(resolveApp('doubao', {}, () => true).id, 'doubao');
  assert.equal(work.endpoint, 'http://127.0.0.1:9226');
  assert.equal(doubao.endpoint, 'http://127.0.0.1:9225');
});

test('explicit app and custom paths retain deterministic precedence', () => {
  assert.equal(resolveApp(undefined, { DOUBAO_APP: '/tmp/Doubao.app' }).appPath, '/tmp/Doubao.app');
  assert.equal(resolveApp(undefined, { DOUBAO_APP: '/tmp/DoubaoWork.app' }).id, 'work');
  assert.equal(resolveApp('doubao', { DOUBAO_APP: '/tmp/DoubaoWork.app' }).appPath, '/Applications/Doubao.app');
  assert.equal(parseOptions(['status', '--app', 'work']).app, 'work');
  assert.throws(() => parseOptions(['--app']), /work or doubao/u);
  assert.throws(() => parseOptions(['--app', 'typo']), /work or doubao/u);
  assert.deepEqual(parseOptions(['sessions', 'create', '--', '--app', 'work']).args, ['sessions', 'create', '--app', 'work']);
});

test('app context stays isolated across asynchronous commands', async () => {
  await Promise.all([work, doubao].map(app => withApp(app, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(currentApp(), app);
    assert.ok(agentWorkspace().startsWith(app.dataDir + '/'));
    assert.match(conversationDeepLink('38443439495332098'), new RegExp(`^${app.scheme}://`));
  })));
});

test('page routing and persisted current sessions cannot cross app variants', () => {
  assert.equal(isAppTarget('doubaowork://doubaowork-chat/chat', work), true);
  assert.equal(isAppTarget('chrome://doubaowork-chat/chat/123', work), true);
  assert.equal(isAppTarget('doubao://doubao-chat/chat', work), false);
  assert.equal(isAppTarget('doubaowork://doubaowork-background/', work, 'background'), true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-app-'));
  try {
    fs.mkdirSync(path.join(directory, 'Sessions'));
    fs.writeFileSync(path.join(directory, 'Sessions', 'Tabs_1'),
      'doubao://doubao-chat/chat/38443439495332098\ndoubaowork://doubaowork-chat/chat/38443439495332099');
    assert.equal(withApp(work, () => currentSession(directory)), '38443439495332099');
    assert.equal(withApp(doubao, () => currentSession(directory)), '38443439495332098');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('wrong or unavailable CDP never falls back to the other application', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return Response.json(url.endsWith('/version') ? { Browser: 'Chrome' } : [{
      type: 'page', url: 'doubao://doubao-chat/chat', webSocketDebuggerUrl: 'ws://wrong-app',
    }]);
  });
  await withApp(work, async () => {
    assert.equal((await cdpStatus()).identityMismatch, true);
    await assert.rejects(withChatClient(() => assert.fail('wrong app reached')), /does not belong to DoubaoWork/u);
  });
  assert.ok(urls.every(url => url.startsWith(work.endpoint)));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await withApp(work, async () => {
    const result = await cdpStatus();
    assert.equal(result.available, false);
    assert.equal(result.endpoint, work.endpoint);
  });
});

test('runtime parameters come from the selected renderer and omit credentials', async () => {
  const client = { evaluate: expression => vm.runInNewContext(expression, {
    URL,
    performance: { getEntriesByType: () => [{ name:
      'https://www.doubao.com/im/chain/recent_conv?aid=1044603&device_id=work-device&pc_version=2.30.5&msToken=secret&a_bogus=secret',
    }] },
    window: { neotix: { taskMode: { runtime: { queryRuntimeInfo: async () => ({ env: { environmentId: 'work-env' } }) } } } },
  }) };
  await withApp(work, async () => {
    const result = await runtimeParameters(client);
    assert.equal(result.params.device_id, 'work-device');
    assert.equal(result.clientEnvId, 'work-env');
    assert.doesNotMatch(result.query, /secret|msToken|a_bogus/u);
  });
  await withApp(doubao, () => assert.rejects(runtimeParameters(client), /identity does not match/u));
});

test('an inactive profile cannot silently automate the active profile', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-inactive-profile-'));
  const previous = process.env.DOUBAO_DATA_DIR;
  process.env.DOUBAO_DATA_DIR = directory;
  fs.writeFileSync(path.join(directory, 'Local State'), JSON.stringify({
    profile: { last_used: 'Default', info_cache: { Default: { name: 'Current' }, 'Profile 1': { name: 'Other' } } },
  }));
  t.after(() => {
    if (previous === undefined) delete process.env.DOUBAO_DATA_DIR;
    else process.env.DOUBAO_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => assert.fail('inactive profile must not reach CDP'));
  for (const command of [['sessions', 'send', '38439138239851266', 'hello'], ['sessions', 'open', '38439138239851266'], ['model'], ['mcp', 'list']]) {
    await assert.rejects(main([...command, '--app', 'work', '--profile', 'Other']), /not active in DoubaoWork/u);
  }
});
