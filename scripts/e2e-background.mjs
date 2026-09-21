#!/usr/bin/env node
// Opt-in focus regression. Uses synthetic chats and a temporary MCP connector;
// never opens a deep link or restarts either app. Run the two apps sequentially.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveApp, withApp } from '../src/app.mjs';
import { withChatClient } from '../src/cdp.mjs';
import { app, check, dir, fallback, inspect, pause, record, root, save, summary, until } from './e2e.mjs';

const bundles = ['com.bot.pc.doubao', 'com.work.pc.doubao'];
const output = path.join(dir, 'foreground.jsonl');
const stopFile = path.join(dir, 'foreground.stop');
fs.rmSync(stopFile, { force: true });
fs.writeFileSync(output, '', { mode: 0o600 });
const events = [];
let pending = '', stderr = '';
const monitor = spawn('/usr/bin/osascript', ['-l', 'JavaScript', path.join(root, 'scripts/fixtures/foreground-monitor.js'), stopFile], { stdio: ['ignore', 'pipe', 'pipe'] });
monitor.stdout.on('data', chunk => {
  fs.appendFileSync(output, chunk);
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
});
monitor.stderr.on('data', chunk => { stderr += chunk; });
const monitorExit = new Promise(resolve => monitor.on('close', code => resolve(code)));
const selected = resolveApp(app, fallback ? {} : process.env);
const navigate = url => withApp(selected, () => withChatClient(client => client.send('Page.navigate', { url })));
const snapshot = () => inspect(`({ href:location.href, ready:Boolean(document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]')), draft:document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]')?.innerText || '', attachments:document.querySelectorAll('[data-testid="attachment_area"] [data-testid="attachment_file_item"], [data-testid="attachment_area"] [data-testid="mdbox_image"]').length })`);
const marker = `${app.toUpperCase()}_BACKGROUND_${Date.now()}`;
const response = expected => data => assert.ok(data.reply?.text.includes(expected), data.reply?.text);
let initial, initialModel, connectors, connectorId, changedPage = false;

try {
  const ready = await until(() => events.find(event => event.event === 'ready'), 5000);
  assert.equal(ready.selfTest, true, 'Activation monitor self-test failed');
  assert.ok(!bundles.includes(ready.application.bundle), 'Leave both Doubao apps in the background before starting');
  initial = await snapshot();
  assert.equal(initial.ready, true, 'The chat composer must be ready');
  assert.equal(initial.draft.trim(), '', 'An existing draft must not be overwritten');
  assert.equal(initial.attachments, 0, 'Existing attachments must not be overwritten');
  initialModel = (await check('background initial model', ['model'], d => assert.ok(d.id))).data;
  connectors = (await check('background initial connectors', ['mcp','list'], d => assert.ok(Array.isArray(d)))).data;
  save({ initialUrl:initial.href, initialModel:initialModel.name, initialConnectors:connectors });
  await check('background automatic selection', ['status'], d => { assert.equal(d.app, app); save({ appVersion:d.appVersion }); }, { app:null });
  const models = (await check('background models', ['models'], d => assert.ok(d.models.length))).data.models;
  const model = ['gpt-6-astra','gpt-5.6-sol','doubao-2.1-pro'].find(id => models.some(m => m.id === id));
  assert.ok(model);
  await check('background CDP already ready', ['cdp','launch'], d => { assert.equal(d.available,true); assert.notEqual(d.restarted,true); });
  await check('background sessions list', ['sessions','list'], d => assert.ok(Array.isArray(d)));
  const created = await check('background create text', ['sessions','create',`Reply only ${marker}. Do not use tools.`,'--model',model,'--reasoning','low','--no-skills','--workspace',path.join(dir,'workspace'),'--wait'], response(marker));
  const id = created.data.conversationId;
  save({ textId:id });
  changedPage = true;
  await check('background read with navigation', ['sessions','read',id], d => assert.ok(d.messages.some(m => m.text.includes(marker))));
  await check('background current', ['sessions','current'], d => assert.equal(d.id,id));
  await check('background model select', ['model','select',model], d => assert.equal(d.id,model));
  await check('background reasoning', ['model','reasoning','low'], d => assert.equal(d.reasoning,'low'));
  await check('background send text', ['sessions','send',id,`Reply only FOLLOWUP_${marker}. Do not use tools.`,'--wait'], response(`FOLLOWUP_${marker}`));
  const attachment = path.join(dir,'background.txt');
  fs.writeFileSync(attachment, `Synthetic test marker: FILE_${marker}\n`);
  await check('background send attachment', ['sessions','send',id,'Read the attachment and reply only with its test marker. Do not use other tools.','--attach',attachment,'--wait'], response(`FILE_${marker}`));
  await check('background attachment readback', ['sessions','read',id], d => assert.ok(d.messages.some(m => m.attachments?.includes('background.txt'))));
  await check('background stop idle', ['sessions','stop',id], d => assert.equal(d.stopped,true));
  await check('background create blank', ['sessions','create'], d => assert.equal(d.persisted,false));
  const log = path.join(dir,'mcp-calls.jsonl');
  const registered = await check('background MCP register', ['mcp','register',`background-${app}-${Date.now()}`,'--command',process.execPath,'--arg',path.join(root,'scripts/fixtures/mcp-server.mjs'),'--env',`DOUBAO_E2E_LOG=${log}`], d => assert.equal(d.status,'READY'));
  connectorId = registered.data.connectorId;
  save({ connectorId });
  await check('background MCP call', ['sessions','send',id,`Call doubao_e2e_ping once with message "${marker}". Reply only with the exact pong result. Do not use other tools.`,'--mcp',connectorId,'--model',model,'--reasoning','low','--workspace',path.join(dir,'workspace'),'--no-skills','--wait'], response(`pong: ${marker}`));
  const calls = fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'call' && row.message === marker);
  assert.ok(calls.length);
  record({ name:'background MCP server readback', pass:true, calls:calls.length });
} catch (error) {
  record({ name:'background operations', pass:false, error:error.message });
  process.exitCode = 1;
} finally {
  try {
    if (connectorId) {
      await check('background MCP remove', ['mcp','remove',connectorId], d => { assert.equal(d.removed,true); assert.equal(d.runtimeDisconnected,true); });
      save({ connectorId:null });
    }
    if (initial && changedPage) {
      await navigate(initial.href);
      await until(async () => {
        try { const state=await snapshot(); return state.ready && state.href === initial.href && state.draft.trim() === ''; } catch { return false; }
      });
      if (!/\/chat\/\d+/.test(initial.href)) await check('background restore draft model', ['model','select',initialModel.id], d => assert.equal(d.id,initialModel.id));
      const restored = await snapshot();
      assert.equal(restored.href,initial.href);
      assert.equal(restored.draft.trim(),initial.draft.trim());
      assert.equal(restored.attachments,initial.attachments);
      record({ name:'background restored original page', pass:true });
    }
    if (connectors) await check('background preserved connectors', ['mcp','list'], d => {
      for (const before of connectors) assert.ok(d.some(c => c.connectorId === before.connectorId && c.enabled === before.enabled));
      if (connectorId) assert.ok(!d.some(c => c.connectorId === connectorId && c.enabled));
    });
    await pause(1000);
  } catch (error) {
    record({ name:'background cleanup', pass:false, error:error.message });
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(stopFile,'stop\n');
    const timer = setTimeout(() => monitor.kill('SIGTERM'), 5000);
    const exitCode = await monitorExit;
    clearTimeout(timer);
    const stopped = events.find(event => event.event === 'stopped');
    const activations = events.filter(event => bundles.includes(event.application?.bundle));
    const pass = exitCode === 0 && Boolean(stopped?.samples) && activations.length === 0;
    record({ name:'background no Doubao activation', pass, samples:stopped?.samples, activations, ...(pass ? {} : { error:stderr || 'Doubao became active or the monitor failed' }) });
    if (!pass) process.exitCode = 1;
  }
}
const result = summary();
console.log(JSON.stringify({ total:result.total, passed:result.passed, failed:result.failed, output:dir }));
