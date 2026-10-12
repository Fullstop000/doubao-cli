import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.mjs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const platforms = ['doubao', 'web', 'headless'];

async function withConfig(t, callback) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'doubao-update-cli-'));
  const previousConfig = process.env.DOUBAO_CLI_CONFIG_DIR;
  const previousDisable = process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE;
  const previousCI = process.env.CI;
  process.env.DOUBAO_CLI_CONFIG_DIR = directory;
  delete process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE;
  delete process.env.CI;
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.DOUBAO_CLI_CONFIG_DIR;
    else process.env.DOUBAO_CLI_CONFIG_DIR = previousConfig;
    if (previousDisable === undefined) delete process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE;
    else process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = previousDisable;
    if (previousCI === undefined) delete process.env.CI;
    else process.env.CI = previousCI;
    await fsPromises.rm(directory, { recursive: true, force: true });
  });
  await callback(directory);
}

function setStderrTTY(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
    else delete process.stderr.isTTY;
  });
}

function captureConsole(t, events) {
  t.mock.method(console, 'log', (...values) => events.push(['stdout', values.join(' ')]));
  t.mock.method(console, 'error', (...values) => events.push(['stderr', values.join(' ')]));
}

function registryResponse() {
  const [major, minor, patch] = packageJson.version.split('.').map(Number);
  return { version: `${major}.${minor + 1}.${patch}` };
}

test('update notify status returns the public JSON contract on each backend', async t => {
  await withConfig(t, async directory => {
    for (const platform of platforms) {
      const events = [];
      captureConsole(t, events);
      await main(['--platform', platform, '--json', 'update', 'notify', 'status']);
      const value = JSON.parse(events.at(-1)[1]);
      assert.deepEqual(Object.keys(value).sort(), [
        'enabled', 'lastCheckedAt', 'lastNotifiedAt', 'latestVersion', 'settingsPath',
      ]);
      assert.equal(value.enabled, true);
      assert.equal(value.lastCheckedAt, null);
      assert.equal(value.lastNotifiedAt, null);
      assert.equal(value.latestVersion, null);
      assert.equal(value.settingsPath, path.join(directory, 'update.json'));
    }
  });
});

test('notify on/off persist state and omitted action is status', async t => {
  await withConfig(t, async directory => {
    const events = [];
    captureConsole(t, events);
    await main(['--platform', 'headless', '--json', 'update', 'notify', 'off']);
    assert.equal(JSON.parse(events.at(-1)[1]).enabled, false);
    await main(['--platform', 'headless', '--json', 'update', 'notify', 'on']);
    assert.equal(JSON.parse(events.at(-1)[1]).enabled, true);
    await main(['--platform', 'headless', '--json', 'update', 'notify']);
    const status = JSON.parse(events.at(-1)[1]);
    assert.equal(status.enabled, true);
    assert.equal(status.settingsPath, path.join(directory, 'update.json'));
  });
});

test('notify rejects invalid actions and surplus arguments without fetching', async t => {
  await withConfig(t, async () => {
    let fetchCount = 0;
    t.mock.method(globalThis, 'fetch', async () => { fetchCount += 1; throw new Error('unexpected fetch'); });
    for (const args of [
      ['update', 'notify', 'maybe'],
      ['update', 'notify', 'status', 'extra'],
      ['update', 'notify', 'on', 'extra'],
    ]) {
      await assert.rejects(main(['--platform', 'headless', ...args]));
    }
    const previousExitCode = process.exitCode;
    process.exitCode = 7;
    await assert.rejects(main(['--platform', 'headless', 'command-that-fails']));
    assert.equal(process.exitCode, 7);
    process.exitCode = previousExitCode;
    assert.equal(fetchCount, 0);
  });
});

test('backend update help has no registry or settings access', async t => {
  await withConfig(t, async () => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('help must not fetch'));
    t.mock.method(fsPromises, 'readFile', () => assert.fail('help must not read settings'));
    t.mock.method(fsPromises, 'writeFile', () => assert.fail('help must not write settings'));
    t.mock.method(fsPromises, 'mkdir', () => assert.fail('help must not create settings directory'));
    for (const platform of platforms) {
      const events = [];
      captureConsole(t, events);
      await main(['--platform', platform, 'update', 'notify', '--help']);
      assert.match(events.at(-1)[1], /update notify (?:\[|<)on\|off\|status(?:\]|>)/u);
    }
  });
});

test('interactive reminder fetch runs alongside headless business work and prints after its output', async t => {
  await withConfig(t, async () => {
    setStderrTTY(t, true);
    const events = [];
    captureConsole(t, events);
    let resolveFetch;
    let fetchStarted;
    const started = new Promise(resolve => { fetchStarted = resolve; });
    t.mock.method(globalThis, 'fetch', url => {
      assert.equal(url, 'https://registry.npmjs.org/doubao-cli/latest');
      fetchStarted();
      return new Promise(resolve => { resolveFetch = () => resolve({ ok: true, json: async () => registryResponse() }); });
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const pending = main(['--platform', 'headless', 'capabilities']);
    await started;
    // Let the synchronous business output and parallel registry request reach their first await.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.some(([stream]) => stream === 'stdout'), 'capabilities should print before registry resolves');
    assert.equal(events.some(([stream]) => stream === 'stderr'), false);
    resolveFetch();
    await pending;
    const stdoutIndex = events.findIndex(([stream]) => stream === 'stdout');
    const reminderIndex = events.findIndex(([stream, value]) => stream === 'stderr' && value.includes('update available:'));
    assert.ok(reminderIndex > stdoutIndex, JSON.stringify(events));
    assert.equal(events[reminderIndex][1], `doubao: update available: ${packageJson.version} -> ${registryResponse().version}; run "doubao update"`);
    process.exitCode = previousExitCode;
  });
});

test('non-interactive, CI, JSON, and disabled settings skip reminder fetch', async t => {
  await withConfig(t, async () => {
    setStderrTTY(t, false);
    let fetchCount = 0;
    t.mock.method(globalThis, 'fetch', async () => { fetchCount += 1; throw new Error('unexpected fetch'); });
    for (const args of [
      ['--platform', 'headless', 'capabilities'],
      ['--platform', 'headless', '--json', 'capabilities'],
    ]) {
      const events = [];
      captureConsole(t, events);
      await main(args);
      assert.equal(events.some(([stream]) => stream === 'stderr'), false);
    }

    // Exercise the JSON gate while stderr is interactive so TTY alone cannot enable reminders.
    setStderrTTY(t, true);
    process.env.CI = '';
    process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '';
    await main(['--platform', 'headless', '--json', 'capabilities']);
    assert.equal(fetchCount, 0);

    // Turning notifications off must suppress the normal interactive reminder path.
    await main(['--platform', 'headless', '--json', 'update', 'notify', 'off']);
    await main(['--platform', 'headless', 'capabilities']);
    assert.equal(fetchCount, 0);

    process.env.CI = 'true';
    await main(['--platform', 'headless', 'capabilities']);
    process.env.CI = '';
    process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
    await main(['--platform', 'headless', 'capabilities']);
    assert.equal(fetchCount, 0);
  });
});
