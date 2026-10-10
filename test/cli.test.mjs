import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import { main, parseOptions } from '../src/cli.mjs';
import { resolvePermission } from '../src/permissions.mjs';

const cliPath = new URL('../bin/doubao.mjs', import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('reports the installed package version', () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, '--version'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test('documents model selection commands', () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doubao models \[--json\]/u);
  assert.match(result.stdout, /doubao model select <model>/u);
  assert.match(result.stdout, /--model <model>/u);
  assert.match(result.stdout, /doubao sessions create \[message\]/u);
  assert.match(result.stdout, /--attach <path>/u);
  assert.match(result.stdout, /doubao update \[--json\]/u);
  assert.match(result.stdout, /doubao update auto <on\|off\|status>/u);
  assert.match(result.stdout, /doubao sessions stop <conversation-id>/u);
  assert.match(result.stdout, /doubao mcp register <name> --command <path>/u);
  assert.match(result.stdout, /--mcp <connector-id>/u);
  assert.match(result.stdout, /--permission <mode>/u);
  assert.match(result.stdout, /doubao projects create <name> \[--workspace <path>\]/u);
});

test('web namespace preserves the legacy backend options and literal message text', () => {
  for (const operation of [
    ['login'], ['status'], ['capabilities'], ['cdp', 'status'], ['cdp', 'launch'],
    ['sessions', 'list'], ['sessions', 'current'],
    ['sessions', 'create', '--mode', 'work', '--runtime', 'cloud', '--wait', '--', 'web', '--model'],
    ['sessions', 'send', '38439138239851266', 'web', '--wait', '--expect-json'],
    ...['open', 'read', 'status', 'wait', 'stop'].map(command => ['sessions', command, '38439138239851266']),
  ]) {
    const flags = ['--json', '--target', 'selected-web-tab', '--timeout', '3'];
    assert.deepEqual(parseOptions(['web', ...flags, ...operation]), parseOptions(['--platform', 'web', ...flags, ...operation]));
    assert.deepEqual(parseOptions(['--json', 'web', '--target', 'selected-web-tab', '--timeout', '3', ...operation]), parseOptions(['--platform', 'web', ...flags, ...operation]));
  }
  assert.deepEqual(parseOptions(['sessions', 'create', 'web']).args, ['sessions', 'create', 'web']);
  const literal = parseOptions(['--', 'web', 'status']);
  assert.equal(literal.platform, undefined);
  assert.deepEqual(literal.args, ['web', 'status']);
});

test('web namespace rejects conflicting desktop selectors and unsupported options before connection', () => {
  for (const selector of [['--app', 'work'], ['--app', 'doubao'], ['--platform', 'work'], ['--platform', 'doubao']]) {
    assert.throws(() => parseOptions(['web', ...selector, 'status']), /doubao web conflicts/u);
    assert.throws(() => parseOptions([...selector, 'web', 'status']), /doubao web conflicts/u);
  }
  assert.equal(parseOptions(['web', '--platform', 'web', 'status']).platform, 'web');
  assert.throws(() => parseOptions(['web', 'sessions', 'create', 'must not send', '--model', 'Turbo']), /not supported/u);
  assert.throws(() => parseOptions(['web', 'status', '--unknown']), /Unknown Web option/u);
  assert.throws(() => parseOptions(['web', 'login', 'someone']), /accepts no positional arguments/u);
  assert.throws(() => parseOptions(['web', 'login', '--wait']), /--wait requires sessions create\/send/u);
  assert.throws(() => parseOptions(['web', 'sessions', 'read', '38439138239851266', '--mode', 'work']), /--mode requires/u);
});

test('web help is scoped and runs without connecting to a browser', () => {
  for (const args of [['web'], ['web', 'help'], ['web', '--help'], ['--platform', 'web', 'help']]) {
    const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
      encoding: 'utf8', env: { ...process.env, DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:1', DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /doubao web sessions create/u);
    assert.match(result.stdout, /doubao web login \[--timeout <seconds>\]/u);
    assert.match(result.stdout, /doubao web sessions wait/u);
    assert.match(result.stdout, /--platform web <command> remains supported/u);
    assert.doesNotMatch(result.stdout, /doubao profiles|doubao mcp register|--permission <mode>/u);
  }
  const version = spawnSync(process.execPath, [cliPath.pathname, 'web', '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageJson.version);
});

test('every desktop and web command exposes scoped help before executing', () => {
  const desktop = [
    'status', 'usage', 'profiles', 'runtimes', 'capabilities', 'models',
    'projects', 'projects list', 'projects create',
    'sessions', ...['list', 'current', 'create', 'open', 'read', 'send', 'status', 'wait', 'stop'].map(action => `sessions ${action}`),
    'mcp', 'mcp register', 'mcp list', 'mcp remove',
    'model', 'model current', 'model select', 'model reasoning',
    'cdp', 'cdp status', 'cdp launch',
    'update', 'update check', 'update auto', 'version',
  ];
  const web = ['login', 'status', 'capabilities', 'sessions',
    ...['list', 'current', 'create', 'open', 'read', 'send', 'status', 'wait', 'stop'].map(action => `sessions ${action}`),
    'cdp', 'cdp status', 'cdp launch', 'update', 'update check', 'update auto', 'version'];
  for (const [prefix, topics] of [[[], desktop], [['web'], web]]) {
    for (const topic of topics) {
      const argv = [...prefix, ...topic.split(' '), '--help'];
      const result = spawnSync(process.execPath, [cliPath.pathname, ...argv], {
        encoding: 'utf8', timeout: 3000,
        env: { ...process.env, DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:1', DOUBAO_DATA_DIR: '/missing-help-profile', DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' },
      });
      assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage:\n/u);
      assert.equal(result.stderr, '');
      const usage = topic === 'version' ? '--version' : topic;
      assert.ok(result.stdout.includes(`  doubao${prefix.length ? ' web' : ''} ${usage}`), argv.join(' '));
      if (topic === 'sessions create') assert.doesNotMatch(result.stdout, /sessions send/u);
      if (prefix.length) assert.doesNotMatch(result.stdout, /--permission|--profile|--app/u);
    }
  }
});

test('help aliases select the same command and work with operands and backend selectors', () => {
  for (const argv of [
    ['sessions', 'create', '--help'], ['sessions', 'create', '-h'], ['sessions', 'create', 'help'],
    ['help', 'sessions', 'create'], ['sessions', 'help', 'create'],
    ['--help', 'sessions', 'create'], ['sessions', '-h', 'create'],
    ['sessions', 'create', 'a message', '--help'],
  ]) assert.deepEqual(parseOptions(argv).helpPath, ['sessions', 'create']);
  for (const argv of [
    ['web', 'sessions', 'send', '-h'], ['web', 'help', 'sessions', 'send'],
    ['help', 'web', 'sessions', 'send'], ['web', 'sessions', 'help', 'send'],
    ['--platform', 'web', 'sessions', 'send', '--help'],
  ]) {
    const options = parseOptions(argv);
    assert.equal(options.platform, 'web');
    assert.deepEqual(options.helpPath, ['sessions', 'send']);
  }
  for (const argv of [['--', 'help'], ['--', '--help']]) assert.deepEqual(parseOptions(argv).helpPath, []);
  assert.deepEqual(parseOptions(['sessions', 'help']).helpPath, ['sessions']);
});

test('help skips network, native app, profile, workspace, schema and update access', async t => {
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  t.mock.method(globalThis, 'fetch', () => assert.fail('help must not reach the network'));
  for (const method of ['readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync']) {
    t.mock.method(fs, method, () => assert.fail(`help must not call fs.${method}`));
  }
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('help must not launch a process'));
  syncBuiltinESMExports();
  try {
    for (const argv of [
      ['sessions', 'create', '--runtime', 'local', '--profile', 'missing', '--reply-schema', '/missing-schema', '--help'],
      ['sessions', 'send', '--mcp', '123456', '-h'],
      ['projects', 'create', '--workspace', '/missing-workspace', 'help'],
      ['mcp', 'register', '--help'], ['mcp', 'remove', '--help'],
      ['cdp', 'launch', '--yes', '--help'], ['update', 'auto', 'on', '--help'],
      ['update', '--help'], ['web', 'login', '--help'],
      ['web', 'sessions', 'create', '--runtime', 'cloud', '--help'],
      ['--profile', 'missing', '--', 'help'],
    ]) await main(argv);
    assert.equal(output.length, 11);
    assert.ok(output.every(value => value.startsWith('Usage:')));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('help and help flags after -- or consumed as option values remain literal', () => {
  for (const prefix of [[], ['web']]) {
    for (const text of ['help', '--help', '-h']) {
      const options = parseOptions([...prefix, 'sessions', 'create', '--', text]);
      assert.equal(options.helpPath, undefined);
      assert.deepEqual(options.args, ['sessions', 'create', text]);
    }
    const options = parseOptions([...prefix, 'sessions', 'send', '38439138239851266', 'help']);
    assert.equal(options.helpPath, undefined);
    assert.equal(options.args[3], 'help');
  }
  assert.equal(parseOptions(['sessions', 'create', 'help', 'me']).helpPath, undefined);
  assert.equal(parseOptions(['projects', 'create', '--', 'help']).helpPath, undefined);
  const mcp = parseOptions(['mcp', 'register', 'tools', '--command', '/usr/bin/node', '--arg', '--help']);
  assert.equal(mcp.helpPath, undefined);
  assert.deepEqual(mcp.commandArgs, ['--help']);
  const group = parseOptions(['sessions', '--help', '--', 'create']);
  assert.deepEqual(group.helpPath, ['sessions']);
});

test('unknown help topics and conflicting backend selectors fail before executing', () => {
  for (const argv of [
    ['typo', '--help'], ['sessions', 'typo', '--help'], ['help', 'typo'],
    ['web', 'projects', 'create', '--help'], ['web', 'mcp', '--help'],
  ]) assert.throws(() => parseOptions(argv), /Unknown help topic/u);
  assert.throws(() => parseOptions(['web', '--app', 'work', 'sessions', '--help']), /conflicts/u);
});

test('parses repeated attachments and option terminators', () => {
  const parsed = parseOptions([
    'sessions', 'send', '38439138239851266', 'review',
    '--attach', '/tmp/one.pdf', '--attach', '/tmp/two.txt',
    '--', '--model', 'is message text',
  ]);

  assert.deepEqual(parsed.attachments, ['/tmp/one.pdf', '/tmp/two.txt']);
  assert.deepEqual(parsed.args, [
    'sessions', 'send', '38439138239851266', 'review', '--model', 'is message text',
  ]);
  assert.equal(parsed.model, undefined);
});

test('parses explicit CDP restart confirmation', () => {
  const parsed = parseOptions(['cdp', 'launch', '--yes', '--json']);

  assert.equal(parsed.yes, true);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.args, ['cdp', 'launch']);
});

test('parses the reasoning effort option', () => {
  const parsed = parseOptions(['sessions', 'create', 'hello', '--reasoning', 'xhigh']);

  assert.equal(parsed.reasoning, 'xhigh');
  assert.deepEqual(parsed.args, ['sessions', 'create', 'hello']);
});

test('rejects an attachment option without a path', () => {
  assert.throws(() => parseOptions(['sessions', 'create', '--attach']), /requires a file path/u);
  assert.throws(() => parseOptions(['sessions', 'create', '--attach', '--wait']), /requires a file path/u);
});

test('parses the isolation options', () => {
  const parsed = parseOptions(['sessions', 'create', 'hello', '--workspace', '/tmp/ws', '--no-skills']);

  assert.equal(parsed.workspace, '/tmp/ws');
  assert.equal(parsed.noSkills, true);
  assert.deepEqual(parsed.args, ['sessions', 'create', 'hello']);
});

test('rejects a workspace option without a path', () => {
  assert.throws(() => parseOptions(['sessions', 'create', '--workspace']), /requires a directory path/u);
  assert.throws(() => parseOptions(['sessions', 'create', '--workspace', '--wait']), /requires a directory path/u);
});

test('parses the reply validation options', () => {
  const parsed = parseOptions(['sessions', 'send', '38439138239851266', 'hi', '--wait', '--expect-json', '--reply-schema', '/tmp/s.json']);

  assert.equal(parsed.expectJson, true);
  assert.equal(parsed.replySchema, '/tmp/s.json');
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--reply-schema']), /requires a JSON schema file path/u);
});

test('parses the mcp options', () => {
  const parsed = parseOptions(['sessions', 'create', 'hi', '--wait', '--mcp', '369247068674', '--mcp', '123456']);

  assert.deepEqual(parsed.mcps, ['369247068674', '123456']);
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--mcp', 'abc']), /requires a numeric connector id/u);
});

test('resolves MCP execution permissions and defaults to FullAccess', () => {
  assert.equal(resolvePermission(parseOptions([]).permission), 2);
  for (const [mode, value] of [['AlwaysAsk', 0], ['AskOnRisk', 1], ['FullAccess', 2], ['always-ask', 0], ['ask_on_risk', 1], ['fullaccess', 2]]) {
    const parsed = parseOptions(['sessions', 'create', 'hi', '--wait', '--mcp', '123456', '--permission', mode]);
    assert.equal(resolvePermission(parsed.permission), value);
    assert.deepEqual(parsed.args, ['sessions', 'create', 'hi']);
  }
});

test('rejects reply validation and MCP requests before sending when required input is missing', async () => {
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--expect-json']), /require --wait/u);
  assert.throws(() => parseOptions(['sessions', 'create', '--wait', '--expect-json']), /require a message/u);
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--mcp', '123456']), /requires --wait/u);
  assert.throws(() => parseOptions(['sessions', 'create', '--wait', '--mcp', '123456']), /requires a message/u);
  assert.throws(() => parseOptions(['sessions', 'send', '38439138239851266', 'hi', '--wait', '--mcp', '123456', '--attach', '/tmp/file']), /not supported with attachments/u);
  await assert.rejects(main(['sessions', 'create', 'must not be sent', '--wait', '--reply-schema', '/missing-doubao-e2e-schema.json']), /cannot read reply schema/u);
});

test('rejects invalid or ignored MCP permissions before calling the app', () => {
  for (const value of ['', '--wait', 'typo', '0', '3']) {
    assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--mcp', '123456', '--permission', value]), /permission/u);
  }
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--permission', 'AlwaysAsk']), /requires sessions create\/send with --runtime local or --mcp/u);
  assert.throws(() => parseOptions(['mcp', 'list', '--mcp', '123456', '--permission', 'AlwaysAsk']), /requires sessions create\/send with --runtime local or --mcp/u);
  assert.throws(() => parseOptions(['sessions', 'create', '--mcp', '123456', '--permission', 'AlwaysAsk']), /requires a message/u);
  assert.throws(() => parseOptions(['sessions', 'send', '38439138239851266', '--mcp', '123456', '--permission', 'AlwaysAsk']), /requires a message/u);
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--mcp', '123456', '--permission', 'AlwaysAsk', '--attach', '/tmp/a']), /not supported with attachments/u);
});

test('parses the mcp register options', () => {
  const parsed = parseOptions([
    'mcp', 'register', 'my', 'tools', '--command', '/usr/local/bin/node',
    '--arg', '/srv/server.mjs', '--arg', '--verbose', '--env', 'TOKEN=a=b', '--env', 'DEBUG=1',
  ]);

  assert.deepEqual(parsed.args, ['mcp', 'register', 'my', 'tools']);
  assert.equal(parsed.commandPath, '/usr/local/bin/node');
  assert.deepEqual(parsed.commandArgs, ['/srv/server.mjs', '--verbose']);
  assert.deepEqual(parsed.envPairs, ['TOKEN=a=b', 'DEBUG=1']);
  assert.throws(() => parseOptions(['mcp', 'register', 'x', '--env', 'NOEQUALS']), /requires a KEY=VALUE pair/u);
  assert.throws(() => parseOptions(['mcp', 'register', 'x', '--command']), /requires an executable path/u);
});

test('validates run targeting and resumable reply checks before calling the app', () => {
 const run='56325877314422786';
 for (const action of ['status','wait','stop']) assert.equal(parseOptions(['sessions',action,'38443335508942082','--run',run]).runId,run);
 assert.throws(()=>parseOptions(['sessions','send','38443335508942082','hi','--run',run]),/--run requires/);
 assert.throws(()=>parseOptions(['sessions','wait','38443335508942082','--run','bad']),/numeric run id/);
 assert.equal(parseOptions(['sessions','wait','38443335508942082','--expect-json']).expectJson,true);
});
