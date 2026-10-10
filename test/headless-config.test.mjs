import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { configDirectory } from '../src/config.mjs';
import { main } from '../src/cli.mjs';

test('config directory follows platform defaults and explicit overrides', () => {
  assert.equal(configDirectory({}, 'linux', '/home/alice'), '/home/alice/.config/doubao-cli');
  assert.equal(configDirectory({ XDG_CONFIG_HOME: '/run/user/1000/config' }, 'linux', '/home/alice'),
    '/run/user/1000/config/doubao-cli');
  assert.equal(configDirectory({}, 'darwin', '/Users/alice'),
    '/Users/alice/Library/Application Support/doubao-cli');
  assert.equal(configDirectory({ XDG_CONFIG_HOME: '/xdg', DOUBAO_CLI_CONFIG_DIR: '/custom/settings' }, 'linux', '/home/alice'),
    '/custom/settings');
  assert.equal(configDirectory({ DOUBAO_CLI_CONFIG_DIR: '/custom/settings' }, 'darwin', '/Users/alice'),
    '/custom/settings');
});

test('Linux help, status, and capabilities stay on the headless path without network or browser launch', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const environment = Object.fromEntries(['DOUBAO_CLI_CONFIG_DIR', 'DOUBAO_CLI_DISABLE_AUTO_UPDATE', 'DOUBAO_HEADLESS_COOKIE']
    .map(name => [name, process.env[name]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-headless-config-'));
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  process.env.DOUBAO_CLI_CONFIG_DIR = directory;
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  delete process.env.DOUBAO_HEADLESS_COOKIE;

  const output = [];
  t.mock.method(console, 'log', value => output.push(String(value)));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('headless help/status/capabilities must not use the network'));
  t.mock.method(fs, 'existsSync', () => assert.fail('Linux headless routing must not probe installed apps'));
  const originalSpawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('headless commands must not launch a browser or app'));
  syncBuiltinESMExports();

  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await main(['sessions', 'create', '--help']);
  assert.match(output.pop(), /doubao headless sessions create/u);
  await main(['status', '--json']);
  assert.deepEqual(JSON.parse(output.pop()), {
    platform: 'headless', loggedIn: false, loginRequired: true, accountId: null,
    browserRequired: false, appRequired: false,
  });
  await main(['capabilities', '--json']);
  const capabilities = JSON.parse(output.pop());
  assert.equal(capabilities.platform, 'headless');
  assert.equal(capabilities.browserRequired, false);
  assert.equal(capabilities.appRequired, false);

  await assert.rejects(main(['sessions', 'create', '--runtime', 'local', 'must be rejected before dispatch']),
    /--runtime local is not supported on doubao headless/u);
});
