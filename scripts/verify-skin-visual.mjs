// Opt-in live integration fixture, not acceptance of a third-party skin.
// Requires an already-open Work renderer on localhost:9226. Never navigates.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolveApp, withApp } from '../src/app.mjs';
import { CdpClient, findChatTarget, withChatClient } from '../src/cdp.mjs';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-skin-visual-'));
const id = `doubao-skin-fixture-${path.basename(temporary)}`;
const selector = `#${id}`;
const remove = `document.querySelectorAll(${JSON.stringify(selector)}).forEach(node => node.remove()); true`;
const env = { ...process.env, DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:9226',
  DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1',
  DOUBAO_SKIN_ROOT: path.join(temporary, 'fixture'), DOUBAO_CLI_CONFIG_DIR: path.join(temporary, 'config') };
const originalEnv = Object.fromEntries(['DOUBAO_SKIN_ROOT', 'DOUBAO_CLI_CONFIG_DIR', 'DOUBAO_CDP_ENDPOINT'].map(key => [key, process.env[key]]));
const app = resolveApp('work', env);
let client;
const evidence = { kind: 'real-cli-visual-integration-fixture', app: 'work', node: process.version, checks: [] };
async function evaluate(expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, 'renderer evaluation must succeed');
  return result.result.value;
}
async function command(action) {
  const { stdout } = await run(process.execPath, [path.join(repository, 'bin/doubao.mjs'), '--app', 'work', 'skin', action, '--json'], { env, timeout: 15000 });
  return JSON.parse(stdout);
}
const sampleExpression = `(() => { const s = getComputedStyle(document.body); return { color: s.outlineColor, style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, nodes: document.querySelectorAll(${JSON.stringify(selector)}).length }; })()`;
try {
  await fs.mkdir(path.join(env.DOUBAO_SKIN_ROOT, 'src'), { recursive: true });
  const apply = `(() => { const style = document.createElement('style'); style.id = ${JSON.stringify(id)}; style.textContent = 'body { outline: 6px solid rgb(17, 203, 137) !important; outline-offset: -6px !important; }'; document.head.append(style); return true; })()`;
  await fs.writeFile(path.join(env.DOUBAO_SKIN_ROOT, 'src/integration.mjs'),
    `export const REMOVE_SKIN_SCRIPT = ${JSON.stringify(remove)};\nexport const INSTALLED_SKIN_SCRIPT = ${JSON.stringify(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)};\nexport const buildApplyScript = async () => ${JSON.stringify(apply)};\n`);
  const target = await withApp(app, () => findChatTarget(app.endpoint));
  client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  const baseline = await evaluate(sampleExpression);
  assert.equal(baseline.nodes, 0);
  assert.equal((await command('off')).refresh.state, 'disabled');
  assert.deepEqual(await evaluate(sampleExpression), baseline);
  evidence.checks.push('off preserves baseline');
  assert.equal((await command('on')).refresh.state, 'applied');
  const enabled = await evaluate(sampleExpression);
  assert.deepEqual(enabled, { color: 'rgb(17, 203, 137)', style: 'solid', width: '6px', offset: '-6px', nodes: 1 });
  assert.notDeepEqual(enabled, baseline);
  evidence.checks.push('on changes actual body computed style');
  const status = await command('status');
  assert.equal(status.enabled, true);
  assert.equal(status.compatible, true);
  assert.equal(status.settingsPath, path.join(env.DOUBAO_CLI_CONFIG_DIR, 'skin.json'));
  evidence.checks.push('isolated settings readback');
  Object.assign(process.env, Object.fromEntries(Object.keys(originalEnv).map(key => [key, env[key]])));
  for (let index = 0; index < 2; index++) {
    await withApp(app, () => withChatClient(async () => {}, app.endpoint));
    assert.deepEqual(await evaluate(sampleExpression), enabled);
  }
  assert.equal((await command('on')).refresh.state, 'already-applied');
  evidence.checks.push('two real connections and repeated on do not duplicate injection');
  assert.equal((await command('off')).refresh.state, 'disabled');
  assert.equal((await command('status')).enabled, false);
  assert.deepEqual(await evaluate(sampleExpression), baseline);
  evidence.checks.push('off restores baseline and setting');
  evidence.styles = { baseline, enabled, restored: await evaluate(sampleExpression) };
} catch (error) {
  console.error(JSON.stringify({ ...evidence, failed: error.message }));
  throw error;
} finally {
  try { if (client) await evaluate(remove); }
  finally {
    client?.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ ...evidence, cleanup: 'fixture nodes and isolated config removed' }, null, 2));
