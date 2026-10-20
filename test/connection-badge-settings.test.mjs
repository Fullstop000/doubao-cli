import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { connectionBadgeSettingsPath, readConnectionBadgeSettings, setConnectionBadgeEnabled } from '../src/connection-badge-settings.mjs';
import { main, parseOptions } from '../src/cli.mjs';
import { CdpClient, refreshConnectionBadgeVisibility } from '../src/cdp.mjs';
import { resolveApp, resolvePlatform, withApp } from '../src/app.mjs';

function settingsDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-badge-settings-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('badge settings default to off and persist atomically in the configured directory', t => {
  const directory = settingsDirectory(t);
  const settingsPath = connectionBadgeSettingsPath({ DOUBAO_CLI_CONFIG_DIR: directory });
  assert.equal(settingsPath, path.join(directory, 'connection-badge.json'));
  assert.deepEqual(readConnectionBadgeSettings(settingsPath), { enabled: false });
  assert.equal(fs.existsSync(settingsPath), false, 'status does not create settings');
  setConnectionBadgeEnabled(false, settingsPath);
  assert.deepEqual(readConnectionBadgeSettings(settingsPath), { enabled: false });
  setConnectionBadgeEnabled(true, settingsPath);
  assert.deepEqual(readConnectionBadgeSettings(settingsPath), { enabled: true });
  assert.deepEqual(fs.readdirSync(directory), ['connection-badge.json']);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
});

test('malformed settings are reported and explicit on/off repairs them', t => {
  const filename = path.join(settingsDirectory(t), 'connection-badge.json');
  for (const value of ['{', '{"enabled":"off"}', 'null']) {
    fs.writeFileSync(filename, value);
    assert.throws(() => readConnectionBadgeSettings(filename), /cannot read connection badge settings/);
  }
  setConnectionBadgeEnabled(false, filename);
  assert.equal(readConnectionBadgeSettings(filename).enabled, false);
  assert.throws(() => setConnectionBadgeEnabled('off', filename), /must be a boolean/);
});

test('config validates action and options before any effects', () => {
  for (const args of [
    ['config'], ['config', 'other'], ['config', 'connection-badge', 'invalid'],
    ['config', 'connection-badge', 'off', 'extra'], ['config', 'connection-badge', 'off', '--wait'],
    ['config', 'connection-badge', '--profile', 'Default'],
  ]) assert.throws(() => parseOptions(args));
  for (const prefix of [[], ['--app', 'work'], ['web'], ['headless']]) {
    assert.equal(parseOptions([...prefix, 'config', 'connection-badge', 'off', '--json']).args[2], 'off');
  }
});

test('status and help are offline; off persists even when the desktop app is unavailable', async t => {
  const directory = settingsDirectory(t);
  const previous = process.env.DOUBAO_CLI_CONFIG_DIR;
  process.env.DOUBAO_CLI_CONFIG_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.DOUBAO_CLI_CONFIG_DIR;
    else process.env.DOUBAO_CLI_CONFIG_DIR = previous;
  });
  const output = [];
  t.mock.method(console, 'log', line => output.push(line));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await main(['config', 'connection-badge', 'status', '--json']);
  assert.equal(JSON.parse(output.pop()).enabled, false);
  assert.equal(fetch.mock.callCount(), 0);
  await main(['config', 'connection-badge', '--help']);
  assert.match(output.pop(), /config connection-badge <on\|off\|status>/);
  assert.equal(fetch.mock.callCount(), 0);
  await main(['config', 'connection-badge', 'off', '--json']);
  const result = JSON.parse(output.pop());
  assert.equal(result.enabled, false);
  assert.equal(result.settingsPath, path.join(directory, 'connection-badge.json'));
  assert.equal(readConnectionBadgeSettings(result.settingsPath).enabled, false);
  fetch.mock.resetCalls();
  await main(['config', 'connection-badge', '--json']);
  assert.equal(JSON.parse(output.pop()).enabled, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('independent CLI invocations retain the saved setting', t => {
  const directory = settingsDirectory(t);
  const cli = new URL('../bin/doubao.mjs', import.meta.url).pathname;
  const invoke = action => {
    const result = spawnSync(process.execPath, [cli, 'config', 'connection-badge', action, '--json'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, DOUBAO_CLI_CONFIG_DIR: directory, DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:1', DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(invoke('off').enabled, false);
  assert.equal(invoke('status').enabled, false);
  assert.equal(invoke('on').enabled, true);
  assert.equal(invoke('status').enabled, true);
});

test('live refresh targets only the selected desktop app and closes the connection', async t => {
  let closed = 0;
  const expressions = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { type: 'page', url: 'doubao://doubao-chat/chat', webSocketDebuggerUrl: 'ws://other' },
    { type: 'page', url: 'doubaowork://doubaowork-chat/chat', webSocketDebuggerUrl: 'ws://work' },
  ]));
  t.mock.method(CdpClient.prototype, 'connect', async function () {
    assert.equal(this.webSocketUrl, 'ws://work'); return this;
  });
  t.mock.method(CdpClient.prototype, 'evaluate', async expression => { expressions.push(expression); return true; });
  t.mock.method(CdpClient.prototype, 'close', () => { closed++; });
  await withApp(resolveApp('work', {}), async () => {
    assert.equal(await refreshConnectionBadgeVisibility(false), true);
    assert.equal(await refreshConnectionBadgeVisibility(true), true);
  });
  assert.equal(closed, 2);
  assert.match(expressions[0], /__doubaoCliBadgeVisible = false/);
  assert.match(expressions[1], /__doubaoCliBadgeVisible = true/);
  assert.equal(await withApp(resolvePlatform('web', {}), () => refreshConnectionBadgeVisibility(false)), false);
  assert.equal(closed, 2);
});

test('a stalled live refresh is bounded and closes the socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { type: 'page', url: 'doubao://doubao-chat/chat', webSocketDebuggerUrl: 'ws://test' },
  ]));
  t.mock.method(CdpClient.prototype, 'connect', () => new Promise(() => {}));
  t.mock.method(CdpClient.prototype, 'close', () => { closed++; });
  const pending = withApp(resolveApp('doubao', {}), () => refreshConnectionBadgeVisibility(false));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(1501);
  assert.equal(await pending, false);
  assert.equal(closed, 1);
});


test('saved preferences override the legacy opt-in environment variable', t => {
  const settingsPath = path.join(settingsDirectory(t), 'connection-badge.json');
  const env = { DOUBAO_CLI_CONNECTION_BADGE: '1' };
  assert.equal(readConnectionBadgeSettings(settingsPath, {}).enabled, false);
  assert.equal(readConnectionBadgeSettings(settingsPath, env).enabled, true);
  setConnectionBadgeEnabled(false, settingsPath);
  assert.equal(readConnectionBadgeSettings(settingsPath, env).enabled, false);
  setConnectionBadgeEnabled(true, settingsPath);
  assert.equal(readConnectionBadgeSettings(settingsPath, {}).enabled, true);
});
