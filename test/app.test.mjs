import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { resolveApp, resolvePlatform, currentApp, withApp, agentWorkspace, isAppTarget } from '../src/app.mjs';
import { cdpStatus, findChatTarget, findBackgroundTarget, withChatClient, withBackgroundClient } from '../src/cdp.mjs';
import { currentSession } from '../src/storage.mjs';
import { runtimeParameters } from '../src/protocol.mjs';
import { main, parseOptions } from '../src/cli.mjs';
import { conversationDeepLink } from '../src/automation.mjs';

const work = resolveApp('work', {});
const doubao = resolveApp('doubao', {});
const web = resolvePlatform('web', {});

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

test('web platform has separate metadata and ignores desktop path overrides', () => {
  const resolved = resolvePlatform('web', {
    DOUBAO_APP: '/tmp/DoubaoWork.app', DOUBAO_DATA_DIR: '/tmp/work-data',
  }, () => assert.fail('web must not inspect installed desktop apps'));
  assert.deepEqual(resolved, {
    id: 'web', platform: 'web', name: 'Doubao Web', port: 9227,
    appPath: null, dataDir: null, endpoint: 'http://127.0.0.1:9227',
  });
  assert.equal(resolvePlatform('web', { DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:9311/' }).endpoint, 'http://127.0.0.1:9311');
  assert.equal(resolvePlatform(undefined, {}, () => true).platform, 'work');
  assert.equal(resolvePlatform(undefined, {}, () => false).platform, 'doubao');
  for (const id of ['work', 'doubao']) {
    assert.deepEqual(resolvePlatform(id, {}), { ...resolveApp(id, {}), platform: id });
  }
  assert.throws(() => resolvePlatform('chrome', {}), /--platform requires work, doubao, or web/u);
});

test('web chat routing rejects spoofed origins, credentials and unrelated routes', () => {
  for (const url of [
    'https://www.doubao.com/chat', 'https://www.doubao.com/chat/',
    'https://doubao.com/chat/38439138239851266',
    'https://www.doubao.com:443/chat/38439138239851266/?x=1#reply',
    'https://www.doubao.com/chat/123456789012',
    'https://www.doubao.com/chat/123456789012345678901234',
  ]) assert.equal(isAppTarget(url, web), true, url);
  for (const url of [
    'http://www.doubao.com/chat/', 'https://www.doubao.com:444/chat/',
    'https://www.doubao.com.evil.invalid/chat/', 'https://evil.doubao.com/chat/',
    'https://www.doubao.com@evil.invalid/chat/', 'https://user@www.doubao.com/chat/',
    'https://user:pass@www.doubao.com/chat/', 'https://www.doubao.com./chat/',
    'https://www.doubao.com/', 'https://www.doubao.com/chatting/',
    'https://www.doubao.com/chat/not-a-conversation', 'https://www.doubao.com/chat/123',
    'https://www.doubao.com/chat/12345678901',
    'https://www.doubao.com/chat/1234567890123456789012345',
    'https://www.doubao.com/chat/38439138239851266/other',
    'https://www.doubao.com/chat//', 'https://www.doubao.com/chat/%31%32%33',
    'doubao://doubao-chat/chat/38439138239851266',
    'chrome://doubaowork-chat/chat/38439138239851266', 'not a URL',
  ]) assert.equal(isAppTarget(url, web), false, url);
  assert.equal(isAppTarget('https://www.doubao.com/chat/', web, 'background'), false);
});

test('web CDP status accepts only matching page targets and does not fall back to desktop', async t => {
  const urls = [];
  let targets = [
    { id: 'iframe', type: 'iframe', url: 'https://www.doubao.com/chat/' },
    { id: 'desktop', type: 'page', url: 'doubao://doubao-chat/chat' },
    { id: 'spoof', type: 'page', url: 'https://www.doubao.com.evil.invalid/chat/' },
  ];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return Response.json(url.endsWith('/version') ? { Browser: 'Chrome', 'Protocol-Version': '1.3' } : targets);
  });
  await withApp(web, async () => {
    const status = await cdpStatus();
    assert.equal(status.available, false);
    assert.equal(status.identityMismatch, true);
    assert.deepEqual(status.targetIds, []);
    assert.match(status.error, /no matching Doubao Web chat page/u);
    await assert.rejects(withChatClient(() => assert.fail('invalid target reached')), /no matching Doubao Web chat page/u);
    targets.push({ id: 'valid', type: 'page', url: 'https://www.doubao.com/chat/', webSocketDebuggerUrl: 'ws://valid' });
    const ready = await cdpStatus();
    assert.equal(ready.available, true);
    assert.equal(ready.app, 'web');
    assert.deepEqual(ready.targetIds, ['valid']);
    assert.equal((await findChatTarget()).id, 'valid');
  });
  assert.ok(urls.every(url => url.startsWith(web.endpoint)));
});

test('multiple web chat pages require an explicit valid target without leaking page content', async t => {
  const targets = [
    { id: 'first', type: 'page', url: 'https://www.doubao.com/chat/', title: 'private title', webSocketDebuggerUrl: 'ws://first' },
    { id: 'second', type: 'page', url: 'https://doubao.com/chat/38439138239851266', title: 'other private title', webSocketDebuggerUrl: 'ws://second' },
    { id: 'unrelated', type: 'page', url: 'https://example.com/chat/', webSocketDebuggerUrl: 'ws://wrong' },
    { id: 'iframe', type: 'iframe', url: 'https://www.doubao.com/chat/', webSocketDebuggerUrl: 'ws://iframe' },
  ];
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version') ? { Browser: 'Chrome' } : targets));
  await withApp(web, async () => {
    const status = await cdpStatus();
    assert.deepEqual(status.targetIds, ['first', 'second']);
    await assert.rejects(findChatTarget(), error => {
      assert.match(error.message, /multiple Doubao Web chat pages/u);
      assert.match(error.message, /first, second/u);
      assert.doesNotMatch(error.message, /private title|38439138239851266|example\.com|unrelated|iframe/u);
      return true;
    });
  });
  await withApp({ ...web, targetId: 'second' }, async () => {
    assert.equal((await cdpStatus()).targetId, 'second');
    assert.equal((await findChatTarget()).webSocketDebuggerUrl, 'ws://second');
  });
  for (const targetId of ['missing', 'unrelated', 'iframe']) {
    await withApp({ ...web, targetId }, async () => {
      assert.equal((await cdpStatus()).available, false);
      await assert.rejects(findChatTarget(), /available matching target IDs: first, second/u);
      await assert.rejects(withChatClient(() => assert.fail('wrong explicit target reached')), /was not found/u);
    });
  }
});

test('web refuses desktop background operations before any network request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('web background operations must not reach CDP'));
  await withApp(web, async () => {
    await assert.rejects(findBackgroundTarget(), /does not support desktop background/u);
    await assert.rejects(withBackgroundClient(() => assert.fail('background callback called')), /does not support desktop background/u);
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test('a matched web target without a debugger URL never falls back to another page', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { id: 'web-no-socket', type: 'page', url: 'https://www.doubao.com/chat/' },
    { id: 'other', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://wrong' },
  ]));
  for (const app of [web, { ...web, targetId: 'web-no-socket' }]) {
    await withApp(app, () => assert.rejects(findChatTarget(), /web-no-socket has no CDP WebSocket debugger URL/u));
  }
});

test('web unavailable CDP errors instruct browser setup without suggesting a desktop launch', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); throw new Error('offline'); });
  await withApp(web, async () => {
    const status = await cdpStatus();
    assert.equal(status.available, false);
    assert.equal(status.endpoint, web.endpoint);
    await assert.rejects(withChatClient(() => assert.fail('offline web callback called')), error => {
      assert.match(error.message, /browser with remote debugging enabled/u);
      assert.doesNotMatch(error.message, /--app web|DoubaoWork/u);
      return true;
    });
  });
  assert.ok(urls.every(url => url.startsWith(web.endpoint)));
});
