import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { main, parseOptions } from '../src/cli.mjs';
import { resolvePlatform } from '../src/app.mjs';

const cliPath = new URL('../bin/doubao.mjs', import.meta.url);

test('resolves headless without probing or requiring an installed app', () => {
  const app = resolvePlatform('headless', {}, () => assert.fail('headless resolution must not inspect installed apps'));
  assert.deepEqual(app, {
    id: 'headless', platform: 'headless', name: 'Doubao Headless',
    appPath: null, dataDir: null, endpoint: 'https://www.doubao.com',
  });
});

test('headless namespace and platform selector share the same command options', () => {
  const operations = [
    ['login', '--cookie-file', '/tmp/cookies.json'],
    ['logout'], ['status'], ['capabilities'], ['models'], ['update'],
    ['sessions', 'list'], ['sessions', 'read', '38439138239851266'],
    ['sessions', 'create', '--mode', 'work', '--wait', '--', 'literal', '--model'],
    ['sessions', 'send', '38439138239851266', 'hello', '--wait'],
    ...['status', 'wait', 'stop'].map(action => ['sessions', action, '38439138239851266']),
  ];
  for (const operation of operations) {
    assert.deepEqual(
      parseOptions(['headless', '--json', '--timeout', '4', ...operation]),
      parseOptions(['--platform', 'headless', '--json', '--timeout', '4', ...operation]),
    );
  }
  const created = parseOptions(['headless', 'sessions', 'create', '--mode', 'chat', 'hello']);
  assert.equal(created.mode, 'chat');
  assert.deepEqual(created.args, ['sessions', 'create', 'hello']);
});

test('headless login cookie paths and literal message text parse without changing the payload', () => {
  const login = parseOptions(['headless', 'login', '--cookie-file', '/private/session.json', '--timeout', '8', '--json']);
  assert.equal(login.cookieFile, '/private/session.json');
  assert.equal(login.timeoutMs, 8000);
  const message = parseOptions(['headless', 'sessions', 'create', '--', 'help', '--help', 'web']);
  assert.equal(message.helpPath, undefined);
  assert.deepEqual(message.args, ['sessions', 'create', 'help', '--help', 'web']);
});

test('headless rejects conflicting selectors, desktop selection, and misplaced headless options', () => {
  for (const selector of [['--platform', 'web'], ['--platform', 'work'], ['--platform', 'doubao']]) {
    assert.throws(() => parseOptions(['headless', ...selector, 'status']), /conflicts/u);
  }
  assert.throws(() => parseOptions(['headless', '--app', 'doubao', 'status']), /conflicts/u);
  assert.throws(() => parseOptions(['--platform', 'headless', '--app', 'work', 'status']), /different backends/u);
  assert.throws(() => parseOptions(['headless', 'status', '--target', '123']), /--target is not supported/u);
  assert.throws(() => parseOptions(['headless', 'sessions', 'read', '38439138239851266', '--mode', 'chat']), /--mode requires/u);
  assert.throws(() => parseOptions(['headless', 'status', '--cookie-file', '/tmp/cookies.json']), /requires doubao headless login/u);
});

test('headless scoped help documents account login and has no browser or desktop controls', () => {
  for (const args of [['headless'], ['headless', 'help'], ['headless', 'sessions', 'create', '--help'], ['--platform', 'headless', 'help']]) {
    const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1', DOUBAO_DATA_DIR: '/missing-headless-profile' },
    });
    assert.equal(result.status, 0, result.stderr);
    if (args.includes('create')) {
      assert.match(result.stdout, /doubao headless sessions create/u);
    } else {
      assert.match(result.stdout, /doubao headless login/u);
      assert.match(result.stdout, /scan the terminal QR code/u);
      assert.match(result.stdout, /No installed browser or local Doubao app is required/u);
      assert.match(result.stdout, /Cloud Work is supported/u);
    }
    assert.doesNotMatch(result.stdout, /CDP|--profile|--app/u);
  }
});

test('Linux commands and help default to headless routing', async t => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  try {
    const parsed = parseOptions(['sessions', 'create', 'hello', '--mode', 'work']);
    assert.equal(parsed.platform, undefined);
    assert.equal(parsed.mode, 'work');
    assert.deepEqual(parsed.args, ['sessions', 'create', 'hello']);
    await main(['sessions', 'create', '--help']);
    assert.match(output[0], /doubao headless sessions create/u);
    assert.doesNotMatch(output[0], /doubao sessions create|--profile/u);
  } finally {
    t.mock.restoreAll();
    Object.defineProperty(process, 'platform', original);
  }
});
