import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { BADGE_ID, badgeExpression, startConnectionBadge } from '../src/connection-badge.mjs';
import { CdpClient, withChatClient } from '../src/cdp.mjs';
import { resolveApp, resolvePlatform, withApp } from '../src/app.mjs';

// A small DOM fixture executes the actual injected script, including its events
// and timers, without a browser dependency or access to the user's account.
function page() {
  const nodes = new Map();
  const timers = new Map();
  let now = 100000;
  let nextTimer = 1;
  const element = () => ({
    style: {}, dataset: {}, hidden: true, offsetHeight: 24,
    listeners: {}, attributes: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect: () => ({ width: 170 }),
    remove() { nodes.delete(this.id); },
    attachShadow() {
      const children = new Map();
      this.shadowRoot = {
        listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
        querySelector(selector) {
          if (!children.has(selector)) children.set(selector, element());
          return children.get(selector);
        },
      };
      return this.shadowRoot;
    },
  });
  const document = {
    body: { appendChild: host => nodes.set(host.id, host) },
    getElementById: id => nodes.get(id),
    createElement: element,
    querySelector: () => null,
  };
  const context = vm.createContext({
    document, window: { innerWidth: 1000 },
    Date: class extends Date { static now() { return now; } },
    setInterval: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
  });
  return {
    document, nodes, timers,
    evaluate: expression => vm.runInContext(expression, context),
    run: (connection, connected = true) => vm.runInContext(badgeExpression(connection, connected), context),
    tick(ms) { now += ms; for (const callback of [...timers.values()]) callback(); },
    host: () => nodes.get(BADGE_ID),
    health: () => nodes.get(BADGE_ID).shadowRoot.querySelector('.pill').dataset.health,
  };
}
const info = { id: 'one', app: 'DoubaoWork', profile: 'Default', endpoint: 'http://127.0.0.1:9226', version: '0.17.0', pid: 42 };
const enabledEnv = { DOUBAO_CLI_CONNECTION_BADGE: '1' };

test('badge defaults off, removes an existing badge, and only accepts explicit opt-in', async () => {
  for (const value of [undefined, '', '0', 'true']) {
    const p = page();
    p.run(info);
    let calls = 0;
    const stop = await startConnectionBadge({ send: async (method, params) => {
      calls++; p.evaluate(params.expression);
    } }, info, { DOUBAO_CLI_CONNECTION_BADGE: value });
    assert.equal(p.nodes.size, 0);
    assert.equal(p.timers.size, 0);
    await stop();
    assert.equal(calls, 1);
  }
});

test('badge shows connection details as text and supports click and keyboard dismissal', () => {
  const p = page();
  p.run({ ...info, profile: '<img src=x onerror=alert(1)>' });
  const root = p.host().shadowRoot;
  assert.equal(p.health(), 'connected');
  assert.equal(root.querySelector('.app').textContent, 'DoubaoWork');
  assert.match(root.querySelector('.details').textContent, /<img src=x onerror=alert\(1\)>/u);
  assert.ok(!root.innerHTML.includes('<img src=x'));
  assert.match(root.querySelector('.details').textContent, /9226/u);
  root.querySelector('.pill').listeners.click();
  assert.equal(root.querySelector('.panel').hidden, false);
  assert.equal(root.querySelector('.pill').attributes['aria-expanded'], 'true');
  root.listeners.keydown({ key: 'Escape' });
  assert.equal(root.querySelector('.panel').hidden, true);
});

test('heartbeats expire after a crashed CLI and resume without duplicate badges or timers', () => {
  const p = page();
  p.run(info); p.run(info);
  assert.equal(p.nodes.size, 1); assert.equal(p.timers.size, 1);
  p.tick(5001); assert.equal(p.health(), 'degraded');
  p.tick(5000); assert.equal(p.health(), 'disconnected');
  assert.equal(p.timers.size, 0);
  p.run(info); assert.equal(p.health(), 'connected');
  assert.equal(p.timers.size, 1);
  p.run(info, false); assert.equal(p.health(), 'disconnected');
  assert.equal(p.timers.size, 0);
});

test('closing one connection preserves another and the latest active connection details', () => {
  const p = page();
  p.run(info); p.tick(10);
  const second = { ...info, id: 'two', pid: 43 };
  p.run(second);
  assert.match(p.host().shadowRoot.querySelector('.details').textContent, /2 个连接/u);
  p.run(second, false);
  assert.equal(p.health(), 'connected');
  assert.match(p.host().shadowRoot.querySelector('.details').textContent, /PID 42/u);
  p.run(info, false); assert.equal(p.health(), 'disconnected');
});

test('a heartbeat remounts after page replacement and works before the search anchor hydrates', () => {
  const p = page();
  p.document.body = null; p.run(info); assert.equal(p.nodes.size, 0);
  p.document.body = { appendChild: host => p.nodes.set(host.id, host) };
  p.run(info); assert.equal(p.health(), 'connected');
  p.nodes.clear(); p.run(info); assert.equal(p.health(), 'connected');
  p.document.querySelector = () => ({ getBoundingClientRect: () => ({ left: 800, top: 8, height: 32, width: 32 }) });
  p.tick(1000); assert.equal(p.host().style.right, '208px');
  p.document.querySelector = () => ({ getBoundingClientRect: () => ({ left: 20, width: 32 }) });
  p.tick(1000); assert.equal(p.host().style.right, '12px');
});

test('heartbeat failures and an unresponsive renderer do not fail or indefinitely block cleanup', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let calls = 0;
  const client = { send: () => { calls++; return new Promise(() => {}); } };
  const starting = startConnectionBadge(client, info, enabledEnv);
  await Promise.resolve();
  t.mock.timers.tick(501);
  const stop = await starting;
  t.mock.timers.tick(10000); await Promise.resolve();
  assert.equal(calls, 1, 'do not accumulate heartbeat requests while a renderer is hung');
  const stopping = stop(); await Promise.resolve();
  t.mock.timers.tick(501); await stopping;
  assert.equal(calls, 2);
  t.mock.timers.tick(10000); assert.equal(calls, 2);
  const failed = await startConnectionBadge({ send: async () => { throw new Error('closed'); } }, info, enabledEnv);
  await failed();
});

test('desktop callbacks retain their results and errors, clean up the badge, and close the client', async t => {
  const previous = process.env.DOUBAO_CLI_CONNECTION_BADGE;
  process.env.DOUBAO_CLI_CONNECTION_BADGE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DOUBAO_CLI_CONNECTION_BADGE;
    else process.env.DOUBAO_CLI_CONNECTION_BADGE = previous;
  });
  const requests = [];
  let closed = 0;
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version') ? {} : [
    { type: 'page', url: 'doubaowork://doubaowork-chat/chat', webSocketDebuggerUrl: 'ws://test' },
  ]));
  t.mock.method(CdpClient.prototype, 'connect', async function () { return this; });
  t.mock.method(CdpClient.prototype, 'send', async (method, params) => { requests.push(params.expression); });
  t.mock.method(CdpClient.prototype, 'close', () => { closed++; });
  await withApp(resolveApp('work', {}), async () => {
    assert.equal(await withChatClient(async () => 42), 42);
    const error = new Error('original failure');
    await assert.rejects(withChatClient(async () => { throw error; }), e => e === error);
  });
  assert.equal(closed, 2);
  assert.equal(requests.length, 4);
  assert.ok(requests[0].endsWith(', true, true)'));
  assert.ok(requests[1].endsWith(', false, true)'));
  assert.ok(requests[3].endsWith(', false, true)'));
});

test('web connections do not inject a desktop badge', async t => {
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version') ? {} : [
    { id: 'web', type: 'page', url: 'https://www.doubao.com/chat/', webSocketDebuggerUrl: 'ws://test' },
  ]));
  t.mock.method(CdpClient.prototype, 'connect', async function () { return this; });
  t.mock.method(CdpClient.prototype, 'send', () => assert.fail('must not inject'));
  t.mock.method(CdpClient.prototype, 'close', () => {});
  assert.equal(await withApp(resolvePlatform('web', {}), () => withChatClient(async () => 'web')), 'web');
});


test('expanded connection details stay within the viewport near either edge', () => {
  const p = page();
  p.run(info);
  const root = p.host().shadowRoot;
  const panel = root.querySelector('.panel');
  panel.getBoundingClientRect = () => ({ left: -60, right: 220 });
  root.querySelector('.pill').listeners.click();
  assert.equal(panel.style.transform, 'translateX(68px)');
  panel.getBoundingClientRect = () => ({ left: 800, right: 1080 });
  p.tick(1000);
  assert.equal(panel.style.transform, 'translateX(-88px)');
});
