import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readSkinSettings, setSkinEnabled } from '../src/skin/settings.mjs';
import { applyDesktopSkin, findSkinRoot, refreshDesktopSkin } from '../src/skin/index.mjs';
import { resolveApp, resolvePlatform, withApp } from '../src/app.mjs';
import { CdpClient, withChatClient } from '../src/cdp.mjs';
import { parseOptions } from '../src/cli.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-skin-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'skill');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), 'fixture');
  fs.writeFileSync(path.join(root, 'src/integration.mjs'), `
    export const INSTALLED_SKIN_SCRIPT = 'probe';
    export const REMOVE_SKIN_SCRIPT = 'remove';
    export async function buildApplyScript() { return 'apply'; }
  `);
  const env = { DOUBAO_CLI_CONFIG_DIR: directory, DOUBAO_SKIN_ROOT: root };
  const app = { ...resolveApp('doubao', {}), dataDir: directory, profile: 'Profile 1' };
  let installed = false;
  const calls = [];
  const client = { send: async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    calls.push(params.expression);
    if (params.expression === 'apply') installed = true;
    if (params.expression === 'remove') installed = false;
    return { result: { value: params.expression === 'probe' ? installed : true } };
  } };
  return { directory, root, env, app, calls, client };
}

function useEnvironment(t, env) {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('skin defaults on without writing a file, persists off, and repairs malformed settings', t => {
  const { env } = fixture(t);
  const initial = readSkinSettings(env);
  assert.equal(initial.enabled, true);
  assert.equal(fs.existsSync(initial.settingsPath), false);
  setSkinEnabled(false, env);
  assert.equal(readSkinSettings(env).enabled, false);
  fs.writeFileSync(initial.settingsPath, '{');
  assert.throws(() => readSkinSettings(env));
  setSkinEnabled(true, env);
  assert.equal(readSkinSettings(env).enabled, true);
  assert.equal(fs.statSync(initial.settingsPath).mode & 0o777, 0o600);
});

test('discovery uses the selected app and profile, with an explicit root override', t => {
  const { root, app, env } = fixture(t);
  const selected = path.join(app.dataDir, app.profile, '.doubao/agent_mode/workspace/.user_skills/doubao-skin');
  fs.mkdirSync(selected, { recursive: true });
  fs.writeFileSync(path.join(selected, 'SKILL.md'), 'fixture');
  assert.equal(findSkinRoot(app, {}), selected);
  assert.equal(findSkinRoot({ ...app, profile: 'Default' }, {}), null);
  assert.equal(findSkinRoot({ ...app, id: 'work', scheme: 'doubaowork' }, {}), null);
  assert.equal(findSkinRoot(app, env), root);
});

test('automatic loading is idempotent and on/off takes effect on the same renderer', async t => {
  const { app, env, client, calls } = fixture(t);
  assert.equal((await applyDesktopSkin(client, app, { env })).state, 'applied');
  assert.equal((await applyDesktopSkin(client, app, { env })).state, 'already-applied');
  assert.deepEqual(calls, ['probe', 'apply', 'probe']);
  setSkinEnabled(false, env);
  assert.equal((await applyDesktopSkin(client, app, { env })).state, 'disabled');
  assert.equal(calls.at(-1), 'remove');
  setSkinEnabled(true, env);
  assert.equal((await applyDesktopSkin(client, app, { env })).state, 'applied');
});

test('missing/old skills, headless and nonlocal endpoints do not inject', async t => {
  const { root, app, env, client, calls } = fixture(t);
  assert.equal((await applyDesktopSkin(client, resolvePlatform('headless', {}), { env })).state, 'unsupported');
  assert.equal((await applyDesktopSkin(client, { ...app, endpoint: 'http://example.com:9225' }, { env })).state, 'unsupported');
  assert.equal((await applyDesktopSkin(client, app, { env: { ...env, DOUBAO_SKIN_ROOT: '' } })).state, 'not-installed');
  fs.unlinkSync(path.join(root, 'src/integration.mjs'));
  assert.equal((await applyDesktopSkin(client, app, { env })).state, 'update-required');
  assert.deepEqual(calls, []);
});

test('a timed-out build cannot inject later, and renderer errors are cosmetic', async t => {
  const { root, app, env, client, calls } = fixture(t);
  fs.writeFileSync(path.join(root, 'src/integration.mjs'), `
    export const INSTALLED_SKIN_SCRIPT = 'probe';
    export async function buildApplyScript() {
      await new Promise(r => setTimeout(r, 80)); return 'apply';
    }
  `);
  const result = await applyDesktopSkin(client, app, { env, timeoutMs: 20 });
  assert.equal(result.state, 'unavailable');
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!calls.includes('apply'));
  const failed = await applyDesktopSkin({ send: async () => { throw new Error('renderer closed'); } }, app, { env });
  assert.equal(failed.state, 'unavailable');
});

test('desktop integration reuses its existing socket and preserves callback errors', async t => {
  const { env, app, client, calls } = fixture(t);
  useEnvironment(t, { ...env, DOUBAO_CLI_CONNECTION_BADGE: '0' });
  let connects = 0;
  let closes = 0;
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version') ? {} : [
    { type: 'page', url: 'doubao://doubao-chat/chat', webSocketDebuggerUrl: 'ws://test' },
  ]));
  t.mock.method(CdpClient.prototype, 'connect', async function () { connects++; return this; });
  t.mock.method(CdpClient.prototype, 'close', () => { closes++; });
  t.mock.method(CdpClient.prototype, 'send', async (method, params) => {
    if (['probe', 'apply', 'remove'].includes(params.expression)) return client.send(method, params);
    return {};
  });
  const original = new Error('business failure');
  await withApp(app, async () => {
    assert.equal(await withChatClient(async () => 42), 42);
    await assert.rejects(withChatClient(async () => { throw original; }), error => error === original);
  });
  assert.equal(connects, 2);
  assert.equal(closes, 2);
  assert.deepEqual(calls, ['probe', 'apply', 'probe']);
});

test('explicit refresh closes a stalled socket within its own budget', async t => {
  const { env, app } = fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return Response.json([
      { type: 'page', url: 'doubao://doubao-chat/chat', webSocketDebuggerUrl: 'ws://test' },
    ]);
  });
  let closes = 0;
  t.mock.method(CdpClient.prototype, 'connect', () => new Promise(() => {}));
  t.mock.method(CdpClient.prototype, 'close', () => { closes++; });
  assert.equal((await refreshDesktopSkin(app, { env, timeoutMs: 30 })).state, 'unavailable');
  assert.equal(closes, 1);
  assert.deepEqual(requests, [`${app.endpoint}/json/list`]);
});

test('skin CLI validates before effects and retains preferences across processes without CDP', t => {
  const { env } = fixture(t);
  for (const args of [['skin', 'bad'], ['skin', 'off', 'extra'], ['skin', 'off', '--wait'], ['skin', 'off', '--profile', 'other']]) {
    assert.throws(() => parseOptions(args));
  }
  const invoke = action => {
    const result = spawnSync(process.execPath, ['bin/doubao.mjs', 'skin', action, '--json'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ...env, DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(invoke('status').enabled, true);
  assert.equal(invoke('off').enabled, false);
  assert.equal(invoke('status').enabled, false);
  assert.equal(invoke('on').enabled, true);
  assert.equal(invoke('status').enabled, true);
});
