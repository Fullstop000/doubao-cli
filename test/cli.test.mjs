import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { parseOptions } from '../src/cli.mjs';

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

test('rejects an attachment option without a path', () => {
  assert.throws(() => parseOptions(['sessions', 'create', '--attach']), /requires a file path/u);
  assert.throws(() => parseOptions(['sessions', 'create', '--attach', '--wait']), /requires a file path/u);
});
