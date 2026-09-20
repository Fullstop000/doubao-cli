import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { parseOptions } from '../src/cli.mjs';
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
  const parsed = parseOptions(['sessions', 'create', 'hi', '--mcp', '369247068674', '--mcp', '123456']);

  assert.deepEqual(parsed.mcps, ['369247068674', '123456']);
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--mcp', 'abc']), /requires a numeric connector id/u);
});

test('resolves MCP execution permissions and defaults to FullAccess', () => {
  assert.equal(resolvePermission(parseOptions([]).permission), 2);
  for (const [mode, value] of [['AlwaysAsk', 0], ['AskOnRisk', 1], ['FullAccess', 2], ['always-ask', 0], ['ask_on_risk', 1], ['fullaccess', 2]]) {
    const parsed = parseOptions(['sessions', 'create', 'hi', '--mcp', '123456', '--permission', mode]);
    assert.equal(resolvePermission(parsed.permission), value);
    assert.deepEqual(parsed.args, ['sessions', 'create', 'hi']);
  }
});

test('rejects invalid or ignored MCP permissions before calling the app', () => {
  for (const value of ['', '--wait', 'typo', '0', '3']) {
    assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--mcp', '123456', '--permission', value]), /permission/u);
  }
  assert.throws(() => parseOptions(['sessions', 'create', 'hi', '--permission', 'AlwaysAsk']), /requires sessions create\/send with --mcp/u);
  assert.throws(() => parseOptions(['mcp', 'list', '--mcp', '123456', '--permission', 'AlwaysAsk']), /requires sessions create\/send with --mcp/u);
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
