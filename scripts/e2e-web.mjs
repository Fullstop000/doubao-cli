#!/usr/bin/env node
// Opt-in live acceptance for the Web CLI. It never selects a browser account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const help = `Usage: node scripts/e2e-web.mjs --mode chat|work --account-label A|B --stage STAGE [options]
Stages: login-reuse, inspect, cdp-reuse, blank, create, send, wait, status, read, list, open, current, stop
Options: --id ID --run ID --which create|send --target CDP_TARGET_ID --run-label LABEL --timeout SECONDS (default 120)
DOUBAO_CDP_ENDPOINT may use any explicit localhost HTTP port (default workflow uses 9227).
Create/send use a fixed synthetic no-tools exact-token prompt. Each invocation runs one stage.\n`;

function value(name, required = false, fallback) {
  const index = args.indexOf(name);
  if (index < 0) { if (required) throw new Error(`${name} is required`); return fallback; }
  const next = args[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`${name} requires a value`);
  return next;
}
if (args.includes('--help') || args.includes('-h')) { process.stdout.write(help); process.exit(0); }
const mode = value('--mode', true);
assert.ok(['chat', 'work'].includes(mode), '--mode must be chat or work');
const account = value('--account-label', true);
assert.ok(['A', 'B'].includes(account), '--account-label must be A or B');
const stage = value('--stage', true);
const suppliedId = value('--id');
const suppliedRun = value('--run');
const which = value('--which', false, 'send');
const target = value('--target');
const runLabel = value('--run-label');
if (runLabel !== undefined) assert.match(runLabel, /^[a-z0-9-]{1,64}$/u, '--run-label must use 1 to 64 lowercase letters, digits, or hyphens');
const timeoutSec = Number(value('--timeout', false, '120'));
assert.ok(Number.isInteger(timeoutSec) && timeoutSec > 0 && timeoutSec <= 120, '--timeout must be 1 to 120 seconds');
const stages = ['login-reuse', 'inspect', 'cdp-reuse', 'blank', 'create', 'send', 'wait', 'status', 'read', 'list', 'open', 'current', 'stop'];
assert.ok(stages.includes(stage), `--stage must be one of: ${stages.join(', ')}`);
assert.ok(['create', 'send'].includes(which), '--which must be create or send');
if (suppliedId) assert.match(suppliedId, /^\d{12,24}$/u, '--id must contain 12 to 24 digits');
if (suppliedRun) assert.match(suppliedRun, /^\d{12,24}$/u, '--run must contain 12 to 24 digits');
const endpoint = process.env.DOUBAO_CDP_ENDPOINT;
assert.ok(endpoint, 'Set DOUBAO_CDP_ENDPOINT to the selected browser endpoint');
let endpointUrl;
try { endpointUrl = new URL(endpoint); } catch { throw new Error('DOUBAO_CDP_ENDPOINT must be a valid localhost HTTP URL with an explicit port'); }
const explicitPort = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:\/)?$/u.exec(endpoint)?.[1];
assert.ok(endpointUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpointUrl.hostname)
  && explicitPort && Number(explicitPort) >= 1 && Number(explicitPort) <= 65535
  && !endpointUrl.username && !endpointUrl.password && endpointUrl.pathname === '/' && !endpointUrl.search && !endpointUrl.hash,
  'DOUBAO_CDP_ENDPOINT must be localhost HTTP with an explicit port and no credentials, path, query, or fragment');
const normalizedEndpoint = `http://127.0.0.1:${Number(explicitPort)}`;
const runDir = path.join(root, '.e2e', 'web', ...(runLabel ? [runLabel] : []), account.toLowerCase());
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const configDir = path.join(runDir, 'config');
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const statePath = path.join(runDir, `state-${mode}.json`);
const identityPath = path.join(runDir, 'identity.json');
const resultPath = path.join(runDir, 'results.jsonl');
const bin = path.join(root, 'bin', 'doubao.mjs');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const marker = `WEB_${mode.toUpperCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const identity = { accountId: null, endpoint: normalizedEndpoint, mode };
function saveState() { fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }
function matchesToken(text, token) { return typeof text === 'string' && text.trim() === token; }
function summarize(result) {
  if (!result || typeof result !== 'object') return {};
  const out = {};
  for (const key of ['platform','ready','loginRequired','accountId','mode','cdpEndpoint','available','launched','conversationId','currentId','runId','localMessageId','status','accepted','created','persisted','opened','stopped','draft']) if (result[key] !== undefined) out[key] = result[key];
  if (result.reply) out.replyMatchesExpected = Object.values(state.runs || {}).some(run => run.completed && matchesToken(result.reply.text, run.marker));
  if (result.sessions) out.sessionCount = result.sessions.length;
  if (result.messages) out.messageChecks = Object.values(state.runs || {}).map(run => ({ marker: run.marker,
    userSeen: result.messages.some(m => m.role === 'user' && m.text?.includes(run.marker)),
    assistantSeen: run.completed && result.messages.some(m => m.role === 'assistant' && matchesToken(m.text, run.marker)) }));
  if (result.tasks) out.tasks = result.tasks;
  return out;
}
function record(pass, error, result = {}, extra = {}) {
  const row = { at: new Date().toISOString(), accountLabel: account, mode, stage, pass,
    ...(error ? { error } : {}), evidence: summarize(result), ...extra };
  fs.appendFileSync(resultPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${stage}${error ? `: ${error}` : ''}\n`); return row;
}
async function cli(operation) {
  const cliArgs = ['web', ...(target ? ['--target', target] : []), '--json', ...operation,
    '--timeout', String(timeoutSec)];
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin, ...cliArgs], { cwd: root,
      env: { ...process.env, DOUBAO_CLI_CONFIG_DIR: configDir, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false, timedOut = false, killTimer;
    const finish = value => { if (done) return; done = true; clearTimeout(watchdog); clearTimeout(killTimer); resolve(value); };
    const watchdog = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    }, timeoutSec * 1000 + 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => finish({ code: 1, timedOut, data: null }));
    child.on('close', code => {
      let data = null; try { data = JSON.parse(stdout); } catch {}
      finish({ code, timedOut, data, stderr });
    });
  });
}
async function checked(operation, validate, onData = () => {}) {
  const result = await cli(operation);
  if (result.data && typeof result.data === 'object') onData(result.data);
  if (result.timedOut) throw new Error('CLI subprocess exceeded bounded deadline');
  if (result.code !== 0) {
    const evidence = {};
    for (const key of ['error','message','status','accepted','requestDispatched','sendAttempted','conversationId','runId','localMessageId']) {
      if (result.data?.[key] !== undefined) evidence[key] = result.data[key];
    }
    fs.writeFileSync(path.join(runDir, `failure-${stage}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    const reason = (result.data?.message || result.stderr || '').trim().slice(0, 180);
    throw new Error(`CLI exited ${result.code ?? 'without a status'}${reason ? `: ${reason}` : ''}; inspect saved IDs before another send`);
  }
  assert.ok(result.data && typeof result.data === 'object', 'CLI did not return JSON'); validate(result.data); return result.data;
}
async function preflight() {
  const status = await checked(['status'], data => {
    assert.equal(data.platform, 'web', 'wrong platform');
    assert.equal(data.ready, true, 'Web page is not ready');
    assert.equal(data.mode, mode, 'selected composer mode differs from --mode');
    assert.ok(data.accountId && data.accountId !== '0', 'signed-in account ID missing');
    assert.equal(`http://127.0.0.1:${new URL(data.cdpEndpoint).port}`, normalizedEndpoint, 'CDP endpoint changed');
  });
  Object.assign(identity, { accountId: status.accountId, endpoint: normalizedEndpoint, mode });
  const savedIdentity = fs.existsSync(identityPath) ? JSON.parse(fs.readFileSync(identityPath, 'utf8')) : null;
  if (savedIdentity) { assert.equal(identity.accountId, savedIdentity.accountId, 'account changed for this label'); assert.equal(identity.endpoint, savedIdentity.endpoint, 'endpoint changed for this label'); }
  else fs.writeFileSync(identityPath, `${JSON.stringify({ accountId: identity.accountId, endpoint: identity.endpoint })}\n`, { mode: 0o600 });
  if (state.identity) assert.deepEqual(identity, state.identity, 'account, endpoint, or mode changed since the previous stage');
  state.identity = identity;
  saveState();
  return status;
}
function expectedRun() { const run = suppliedRun || state.runs?.[which]?.runId || state.latestRunId; assert.match(run || '', /^\d{12,24}$/u, 'no accepted run ID saved'); return run; }
function expectedId() {
  const tracked = Object.values(state.runs || {}).find(item => item.runId === (suppliedRun || state.runs?.[which]?.runId || state.latestRunId));
  const id = suppliedId || tracked?.conversationId || state.conversationId;
  assert.match(id || '', /^\d{12,24}$/u, 'run create first or supply --id');
  if (tracked && suppliedId) assert.equal(suppliedId, tracked.conversationId, 'conversation differs from saved run');
  return id;
}
try {
  if (runLabel && ['create', 'send'].includes(stage)) {
    const prior = state.runs?.[stage];
    if (/^\d{12,24}$/u.test(prior?.conversationId || '') && /^\d{12,24}$/u.test(prior?.runId || '')) {
      throw new Error(`run label already has an accepted ${stage} run; recover it with status/wait or choose a new --run-label`);
    }
  }
  const status = await preflight();
  let result, extra = {};
  switch (stage) {
    case 'inspect': {
      await checked(['cdp', 'status'], data => assert.equal(data.available, true, 'CDP unavailable'));
      const capabilities = await checked(['capabilities'], data => {
        assert.equal(data.platform, 'web');
        for (const key of ['status', 'listSessions', 'detectCurrentSession', 'openSession', 'createSessions', 'readMessages', 'sendMessages', 'waitForReply', 'taskStatus', 'stopGeneration']) assert.equal(data[key], true, `capability ${key} unavailable`);
      });
      const list = await checked(['sessions', 'list'], data => assert.ok(Array.isArray(data.sessions), 'sidebar session list missing'));
      const current = await checked(['sessions', 'current'], data => {
        assert.equal(data.platform, 'web');
        assert.ok(data.draft || /^\d{12,24}$/u.test(data.id || ''), 'current session result malformed');
      });
      result = { platform: 'web', ready: status.ready, mode, accountId: status.accountId, cdpEndpoint: status.cdpEndpoint,
        capabilities: true, sessionCount: list.sessions.length, currentId: current.id || null, draft: Boolean(current.draft) };
      break;
    }
    case 'cdp-reuse': {
      const before = await checked(['cdp', 'status'], data => assert.equal(data.available, true, 'CDP is unavailable; reuse stage will not launch a browser'));
      result = await checked(['cdp', 'launch'], data => {
        assert.equal(data.launched, false, 'expected existing browser reuse');
        assert.equal(data.ready, true, 'existing browser is not ready');
        assert.equal(data.accountId, identity.accountId, 'account changed during CDP reuse');
      });
      extra.cdpTargetCount = before.targetIds?.length || 0;
      break;
    }
    case 'login-reuse': {
      const priorTarget = status.targetId || null;
      result = await checked(['login'], data => {
        assert.equal(data.platform, 'web');
        assert.equal(data.loggedIn, true, 'login did not confirm signed-in state');
        assert.equal(data.ready, true, 'login did not confirm a ready composer');
        assert.equal(data.launched, false, 'login-reuse must use the already running browser');
        assert.equal(data.accountId, identity.accountId, 'account changed during login reuse');
        assert.equal(data.cdpEndpoint, status.cdpEndpoint, 'CDP endpoint changed during login reuse');
        if (priorTarget) assert.equal(data.targetId, priorTarget, 'selected browser target changed during login reuse');
      });
      break;
    }
    case 'blank':
      result = await checked(['sessions', 'create', '--mode', mode], data => {
        assert.equal(data.platform, 'web'); assert.equal(data.mode, mode);
        assert.equal(data.created, true); assert.equal(data.persisted, false); assert.equal(data.conversationId, null);
      });
      break;
    case 'create':
    case 'send': {
      if (stage === 'send') { assert.match(state.conversationId || '', /^\d{12,24}$/u, 'run create first'); expectedId(); }
      const prompt = `Without using tools or creating anything, reply with exactly this token and no other text: ${marker}`;
      const operation = stage === 'create'
        ? ['sessions', 'create', prompt, '--mode', mode]
        : ['sessions', 'send', state.conversationId, prompt, ...(mode === 'work' ? ['--runtime', 'cloud'] : [])];
      result = await checked(operation, data => {
        assert.equal(data.platform, 'web'); assert.equal(data.mode, mode); assert.equal(data.accepted, true);
        if (stage === 'create') { assert.equal(data.created, true); assert.equal(data.persisted, true); }
        if (stage === 'send') assert.equal(data.conversationId, state.conversationId, 'send changed conversation');
        assert.match(data.conversationId || '', /^\d{12,24}$/u, 'conversation ID missing');
        assert.match(data.runId || '', /^\d{12,24}$/u, 'run ID missing');
        assert.ok(typeof data.localMessageId === 'string' && data.localMessageId.length > 0 && data.localMessageId.length <= 128
          && !/[\u0000-\u001f\u007f]/u.test(data.localMessageId), 'local message ID missing or malformed');
      }, data => {
        if (!/^\d{12,24}$/u.test(data.conversationId || '') || !/^\d{12,24}$/u.test(data.runId || '')) return;
        if (stage === 'create') state.conversationId = data.conversationId;
        state.runs ||= {};
        state.runs[stage] = { conversationId: data.conversationId, runId: data.runId,
          ...(typeof data.localMessageId === 'string' ? { localMessageId: data.localMessageId } : {}), marker, completed: false };
        state.latestRunId = data.runId; saveState();
      });
      state.conversationId ||= result.conversationId;
      state.runs ||= {};
      state.runs[stage] ||= { conversationId: result.conversationId, runId: result.runId, marker, completed: false };
      state.latestRunId = result.runId; saveState();
      extra.marker = marker;
      break;
    }
    case 'wait': {
      const id = expectedId(), run = expectedRun();
      const tracked = Object.values(state.runs || {}).find(item => item.runId === run);
      result = await checked(['sessions', 'wait', id, '--run', run], data => {
        assert.equal(data.conversationId, id); assert.equal(data.runId, run);
        assert.equal(data.status, 'completed', `unexpected terminal state: ${data.status || 'missing'}`);
        assert.ok(tracked && matchesToken(data.reply?.text, tracked.marker), 'assistant reply did not equal the exact synthetic token');
      });
      if (tracked) tracked.completed = true;
      saveState(); extra.marker = tracked?.marker; extra.replyMatchesMarker = true;
      break;
    }
    case 'status': {
      const id = expectedId(), run = expectedRun();
      result = await checked(['sessions', 'status', id, '--run', run], data => {
        assert.equal(data.conversationId, id); assert.equal(data.runId, run);
        assert.ok(['running', 'completed', 'cancelled', 'failed'].includes(data.status), 'status is unknown or missing');
      });
      break;
    }
    case 'read': {
      const id = expectedId();
      result = await checked(['sessions', 'read', id, '--limit', '100'], data => {
        assert.equal(data.conversationId, id); assert.ok(Array.isArray(data.messages));
        const runs = Object.values(state.runs || {});
        assert.ok(runs.length > 0, 'no synthetic run is saved');
        for (const run of runs) {
          assert.ok(data.messages.some(m => m.role === 'user' && m.text?.includes(run.marker)), `synthetic user marker missing: ${run.marker}`);
          if (run.completed) assert.ok(data.messages.some(m => m.role === 'assistant' && matchesToken(m.text, run.marker)), `assistant marker missing: ${run.marker}`);
        }
      });
      break;
    }
    case 'list':
      result = await checked(['sessions', 'list'], data => {
        assert.ok(Array.isArray(data.sessions));
        if (state.conversationId) assert.ok(data.sessions.some(item => item.id === state.conversationId), 'accepted conversation is absent from rendered sidebar');
      });
      break;
    case 'open': {
      const id = expectedId();
      result = await checked(['sessions', 'open', id], data => { assert.equal(data.opened, true); assert.equal(data.id, id); });
      break;
    }
    case 'current': {
      const id = expectedId();
      result = await checked(['sessions', 'current'], data => { assert.equal(data.id, id); assert.equal(data.draft, false); });
      break;
    }
    case 'stop': {
      const id = expectedId(), run = expectedRun();
      result = await checked(['sessions', 'stop', id, '--run', run], data => {
        assert.equal(data.stopped, true, 'stop was not confirmed');
        assert.ok(['cancelled', 'completed', 'failed'].includes(data.status), 'stop left run running or unknown');
        assert.equal(data.tasks?.running, 0); assert.equal(data.tasks?.unknown, 0);
      });
      extra.outcome = result.status === 'cancelled' ? 'cancelled'
        : result.status === 'completed' ? 'naturally-completed' : 'naturally-failed';
      break;
    }
  }
  record(true, null, result, extra);
} catch (error) {
  const message = String(error?.message || error).slice(0, 240);
  record(false, message, {}, { recovery: 'Use saved IDs with status/wait; never repeat create/send to recover.' });
  process.exitCode = 1;
}
