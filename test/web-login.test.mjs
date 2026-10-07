import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { CdpClient } from '../src/cdp.mjs';
import { WEB_STATE, webLogin } from '../src/web.mjs';

const web = resolvePlatform('web', {});
const signedIn = {
  href: 'https://www.doubao.com/chat/', ready: true, loginRequired: false,
  mode: 'chat', modeLabel: '对话', accountId: '123456789012345678', draft: 'keep this draft',
  attachments: 0, generating: false,
};
const loggedOut = { ...signedIn, ready: false, loginRequired: true, accountId: null };

function harness(t, { targets = [], states = [signedIn], version = {}, spawnStatus = null, offlineUntilSpawn = false } = {}) {
  const events = [];
  const browserVersion = { Browser: 'Chrome/140', webSocketDebuggerUrl: 'ws://browser-root', ...version };
  const pages = [...targets];
  let browserStarted = false;
  t.mock.method(globalThis, 'fetch', async url => {
    if (offlineUntilSpawn && !browserStarted) throw new Error('offline');
    if (String(url).endsWith('/json/version')) return Response.json(browserVersion);
    if (String(url).endsWith('/json/list')) return Response.json(pages);
    assert.fail(`unexpected fetch ${url}`);
  });
  t.mock.method(CdpClient.prototype, 'connect', async function () {
    events.push(['connect', this.webSocketUrl]);
    return this;
  });
  t.mock.method(CdpClient.prototype, 'evaluate', async expression => {
    assert.equal(expression, WEB_STATE);
    events.push(['evaluate']);
    return states.length > 1 ? states.shift() : states[0];
  });
  t.mock.method(CdpClient.prototype, 'send', async function (method, params) {
    events.push(['send', this.webSocketUrl, method, params]);
    if (method === 'Target.createTarget') {
      const target = { id: 'created-chat', type: 'page', url: params.url, webSocketDebuggerUrl: 'ws://created-chat' };
      pages.push(target);
      return { targetId: target.id };
    }
    return {};
  });
  t.mock.method(CdpClient.prototype, 'close', function () {
    events.push(['close', this.webSocketUrl]);
  });
  if (spawnStatus !== null) {
    // The launcher is macOS-only; its mocked process must be independent of the CI host.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    const original = childProcess.spawnSync;
    t.mock.method(childProcess, 'spawnSync', (...args) => {
      events.push(['spawn', ...args]);
      browserStarted = true;
      return { status: spawnStatus, stderr: '' };
    });
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.spawnSync = original;
      syncBuiltinESMExports();
    });
  }
  return { events, pages };
}

test('already signed in returns immediately without browser focus or composer/send actions', async t => {
  const { events } = harness(t, { targets: [
    { id: 'one', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://one' },
  ] });
  const result = await withApp({ ...web }, () => webLogin({ timeoutMs: 1000 }));
  assert.equal(result.loggedIn, true);
  assert.equal(result.launched, false);
  assert.equal(result.restarted, false);
  assert.equal(result.accountId, signedIn.accountId);
  assert.ok(events.some(event => event[0] === 'evaluate'));
  assert.ok(events.every(event => event[0] !== 'spawn'));
  assert.ok(events.every(event => event[0] !== 'send' || !['Input.insertText', 'Input.dispatchMouseEvent', 'Page.bringToFront'].includes(event[2])));
});

test('transient about:blank renderer waits for the trusted Doubao page state', async t => {
  const { events } = harness(t, {
    targets: [{ id: 'loading', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://loading' }],
    states: [{ ...signedIn, href: 'about:blank', accountId: null }, signedIn],
  });
  const result = await withApp({ ...web }, () => webLogin({ timeoutMs: 1000 }));
  assert.equal(result.loggedIn, true);
  assert.equal(result.accountId, signedIn.accountId);
  assert.equal(events.filter(event => event[0] === 'evaluate').length, 2);
  assert.ok(events.every(event => event[0] !== 'send' || !['Page.bringToFront', 'Input.insertText', 'Input.dispatchMouseEvent'].includes(event[2])));
  assert.ok(events.every(event => event[0] !== 'spawn'));
});

test('external renderer origin fails closed without accepting its UID or touching the composer', async t => {
  const { events } = harness(t, {
    targets: [{ id: 'external', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://external' }],
    states: [{ ...signedIn, href: 'https://attacker.invalid/chat/', accountId: signedIn.accountId }],
  });
  await withApp({ ...web }, () => assert.rejects(webLogin({ timeoutMs: 1000 }), error => {
    assert.match(error.message, /left the Doubao chat origin/u);
    assert.equal(error.result.loggedIn, false);
    assert.equal(error.result.accountId, undefined);
    return true;
  }));
  assert.ok(events.every(event => event[0] !== 'send' || !['Page.bringToFront', 'Input.insertText', 'Input.dispatchMouseEvent'].includes(event[2])));
  assert.ok(events.every(event => event[0] !== 'spawn'));
});

test('reachable browser with no matching tab creates one chat target through browser CDP', async t => {
  const { events, pages } = harness(t, { states: [loggedOut, signedIn] });
  t.mock.method(console, 'error', () => {});
  const result = await withApp({ ...web }, () => webLogin({ timeoutMs: 2000 }));
  assert.equal(result.loggedIn, true);
  assert.equal(result.targetId, 'created-chat');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, 'https://www.doubao.com/chat/');
  assert.ok(events.some(event => event[0] === 'send' && event[1] === 'ws://browser-root'
    && event[2] === 'Target.createTarget' && event[3].url === 'https://www.doubao.com/chat/'));
  assert.ok(events.every(event => event[0] !== 'spawn'));
  assert.ok(events.some(event => event[0] === 'send' && event[2] === 'Page.bringToFront'));
});

test('ready composer without a real UID times out, keeps browser alive, and never edits the draft', async t => {
  const { events } = harness(t, { targets: [
    { id: 'one', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://one' },
  ], states: [{ ...signedIn, accountId: '0' }] });
  t.mock.method(console, 'error', () => {});
  const result = await withApp(web, async () => {
    await assert.rejects(webLogin({ timeoutMs: 180 }), error => {
      assert.equal(error.code, 'login_timeout');
      assert.equal(error.result.loggedIn, false);
      assert.equal(error.result.loginRequired, false);
      assert.equal(error.result.accountId, '0');
      return true;
    });
  });
  assert.equal(result, undefined);
  assert.equal(events.filter(event => event[0] === 'send' && event[2] === 'Page.bringToFront').length, 1);
  assert.ok(events.every(event => event[0] !== 'spawn'));
  assert.ok(events.every(event => event[0] !== 'send' || !['Input.insertText', 'Input.dispatchMouseEvent', 'Browser.close'].includes(event[2])));
  assert.ok(events.filter(event => event[0] === 'close').every(event => event[1] !== 'ws://browser-root'));
});

test('multiple matching tabs and explicit target miss fail closed before login focus', async t => {
  const targets = [
    { id: 'one', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://one' },
    { id: 'two', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://two' },
  ];
  for (const app of [web, { ...web, targetId: 'missing' }]) {
    const { events } = harness(t, { targets });
    await withApp(app, () => assert.rejects(webLogin({ timeoutMs: 1000 }), /multiple|target .*not found/u));
    assert.ok(events.every(event => event[0] !== 'spawn'));
    assert.ok(events.every(event => event[0] !== 'send' || event[2] !== 'Page.bringToFront'));
  }
});

test('unreachable endpoint starts only the dedicated browser and waits for a real UID', async t => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-web-login-profile-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const { events } = harness(t, { targets: [
    { id: 'fresh', type: 'page', url: signedIn.href, webSocketDebuggerUrl: 'ws://fresh' },
  ], states: [signedIn], spawnStatus: 0, offlineUntilSpawn: true });
  const oldProfile = process.env.DOUBAO_WEB_PROFILE_DIR;
  process.env.DOUBAO_WEB_PROFILE_DIR = profileDir;
  t.after(() => {
    if (oldProfile === undefined) delete process.env.DOUBAO_WEB_PROFILE_DIR;
    else process.env.DOUBAO_WEB_PROFILE_DIR = oldProfile;
  });
  const originalExistsSync = fs.existsSync;
  t.mock.method(fs, 'existsSync', value => value === '/Applications/Google Chrome.app' || originalExistsSync(value));
  const result = await withApp({ ...web, endpoint: 'http://127.0.0.1:9227' }, () => webLogin({ timeoutMs: 3000 }));
  assert.equal(result.loggedIn, true);
  assert.equal(result.launched, true);
  assert.equal(result.restarted, false);
  assert.equal(events.filter(event => event[0] === 'spawn').length, 1);
  assert.ok(events.every(event => event[0] !== 'send' || event[2] !== 'Browser.close'));
});

test('aborted browser discovery cannot trigger a late launch or page action', async t => {
  const events = [];
  let aborted;
  const abortSeen = new Promise(resolve => { aborted = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, { signal } = {}) => {
    events.push(['fetch', String(url)]);
    if (String(url).endsWith('/json/version')) {
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          events.push(['abort']);
          aborted();
          setTimeout(() => resolve(Response.json({ Browser: 'Chrome', webSocketDebuggerUrl: 'ws://browser-root' })), 40);
        }, { once: true });
      });
    }
    if (String(url).endsWith('/json/list')) return Response.json([]);
    assert.fail(`unexpected fetch ${url}`);
  });
  t.mock.method(CdpClient.prototype, 'connect', async function () { events.push(['connect', this.webSocketUrl]); return this; });
  t.mock.method(CdpClient.prototype, 'send', async function (method) {
    events.push(['send', this.webSocketUrl, method]);
    if (method === 'Target.createTarget') return { targetId: 'late-target' };
    return {};
  });
  t.mock.method(CdpClient.prototype, 'close', function () { events.push(['close', this.webSocketUrl]); });
  const spawn = t.mock.method(childProcess, 'spawnSync', (...args) => {
    events.push(['spawn', ...args]);
    return { status: 0, stderr: '' };
  });

  await withApp({ ...web }, async () => {
    await assert.rejects(webLogin({ timeoutMs: 220 }), error => {
      assert.equal(error.code, 'login_timeout');
      assert.equal(error.result.loggedIn, false);
      return true;
    });
    await abortSeen;
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  assert.equal(spawn.mock.callCount(), 0);
  assert.ok(events.every(event => event[0] !== 'send' || !['Target.createTarget', 'Page.bringToFront'].includes(event[2])));
  assert.ok(events.every(event => event[0] !== 'connect'));
});

test('failed CDP startup keeps launched state in timeout result and never closes the browser', async t => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-web-login-offline-profile-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const { events } = harness(t, { spawnStatus: 0, offlineUntilSpawn: true });
  const oldProfile = process.env.DOUBAO_WEB_PROFILE_DIR;
  process.env.DOUBAO_WEB_PROFILE_DIR = profileDir;
  t.after(() => {
    if (oldProfile === undefined) delete process.env.DOUBAO_WEB_PROFILE_DIR;
    else process.env.DOUBAO_WEB_PROFILE_DIR = oldProfile;
  });
  const originalExistsSync = fs.existsSync;
  t.mock.method(fs, 'existsSync', value => value === '/Applications/Google Chrome.app' || originalExistsSync(value));

  await withApp({ ...web, endpoint: 'http://127.0.0.1:9227' }, () =>
    assert.rejects(webLogin({ timeoutMs: 500 }), error => {
      assert.equal(error.code, 'login_timeout');
      assert.equal(error.result.launched, true);
      assert.equal(error.result.loggedIn, false);
      return true;
    }));
  assert.equal(events.filter(event => event[0] === 'spawn').length, 1);
  assert.ok(events.every(event => event[0] !== 'send' || event[2] !== 'Browser.close'));
  assert.ok(events.every(event => event[0] !== 'close' || event[1] !== 'ws://browser-root'));
});

test('non-macOS login without a running browser fails before any launch', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const { events } = harness(t, { offlineUntilSpawn: true });
  const originalSpawn = childProcess.spawnSync;
  const spawn = t.mock.method(childProcess, 'spawnSync', () => { throw new Error('unexpected browser launch'); });
  const mkdir = t.mock.method(fs, 'mkdirSync', () => { throw new Error('unexpected profile creation'); });
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawnSync = originalSpawn;
    syncBuiltinESMExports();
  });
  await withApp({ ...web }, () => assert.rejects(webLogin({ timeoutMs: 1000 }), error => {
    assert.match(error.message, /Automatic Web browser launch currently requires macOS/u);
    assert.equal(error.result.launched, false);
    assert.equal(error.result.loggedIn, false);
    return true;
  }));
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(mkdir.mock.callCount(), 0);
  assert.ok(events.every(event => !['connect', 'send', 'spawn'].includes(event[0])));
});
