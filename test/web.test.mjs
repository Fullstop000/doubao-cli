import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { CdpClient } from '../src/cdp.mjs';
import { main, parseOptions } from '../src/cli.mjs';
import { assertWebReady, sendWebMessage, validateWebOptions, webLaunchSpec, WEB_STATE } from '../src/web.mjs';

const web = resolvePlatform('web', {});
const conversationId = '38439138239851266';
const cli = new URL('../bin/doubao.mjs', import.meta.url).pathname;
const inputSelector = 'textarea[data-testid="chat_input_input"], [data-testid="chat_input_input"] [contenteditable="true"]';
const sendSelector = '[data-testid="chat_input_send_button"]';
const baseState = {
  href: `https://www.doubao.com/chat/${conversationId}`, ready: true, loginRequired: false,
  mode: 'chat', modeLabel: '对话', accountId: 'signed-in-user', draft: '', attachments: 0, generating: false, sendEnabled: true,
};

test('web page state reads the active textarea and ignores the hidden rich editor', () => {
  const element = (fields = {}) => ({
    visibility: 'visible', getBoundingClientRect: () => ({ width: 848, height: 24 }),
    closest() { return this; }, ...fields,
  });
  const textarea = element({ value: '  textarea draft  ' });
  const rich = element({ innerText: 'stale rich draft', visibility: 'hidden' });
  const context = {
    location: { href: baseState.href }, localStorage: { getItem: () => baseState.accountId },
    getComputedStyle: e => ({ visibility: e.visibility }),
    document: {
      querySelectorAll: selector => selector.includes('chat_input_input') ? [textarea, rich] : [],
      querySelector: selector => selector.includes('chat_input_action_mode') ? { innerText: '云电脑' } : null,
    },
  };
  let state = vm.runInNewContext(WEB_STATE, context);
  assert.equal(state.ready, true);
  assert.equal(state.draft, 'textarea draft');
  assert.equal(state.mode, 'work');
  textarea.visibility = 'hidden';
  rich.visibility = 'visible';
  state = vm.runInNewContext(WEB_STATE, context);
  assert.equal(state.ready, true);
  assert.equal(state.draft, 'stale rich draft');
  rich.visibility = 'hidden';
  state = vm.runInNewContext(WEB_STATE, context);
  assert.equal(state.ready, false);
  assert.equal(state.draft, '');
});

test('CDP click targets the visible rich editor when the textarea is hidden', async () => {
  const makeElement = ({ left, top, width, height, visibility }) => ({
    getBoundingClientRect: () => ({ left, top, width, height }),
    scrollIntoView() {}, visibility,
  });
  const textarea = makeElement({ left: 0, top: 0, width: 400, height: 40, visibility: 'hidden' });
  const richEditor = makeElement({ left: 20, top: 30, width: 240, height: 36, visibility: 'visible' });
  const dispatched = [];
  const client = new CdpClient('ws://fixture');
  client.evaluate = expression => vm.runInNewContext(expression, {
    document: { querySelectorAll: selector => {
      assert.equal(selector, inputSelector);
      return [textarea, richEditor];
    } },
    getComputedStyle: element => ({ visibility: element.visibility }),
  });
  client.send = async (method, params) => { dispatched.push([method, params]); };
  await client.click(inputSelector);
  assert.deepEqual(dispatched.map(([method, params]) => [method, params.x, params.y]), [
    ['Input.dispatchMouseEvent', 140, 48], ['Input.dispatchMouseEvent', 140, 48],
  ]);
});

function isolatedConfig(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-web-test-'));
  const original = {
    DOUBAO_CLI_CONFIG_DIR: process.env.DOUBAO_CLI_CONFIG_DIR,
    DOUBAO_CLI_DISABLE_AUTO_UPDATE: process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE,
  };
  process.env.DOUBAO_CLI_CONFIG_DIR = directory;
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

class GuardClient {
  constructor(states) { this.states = states; this.calls = []; this.listeners = new Set(); }
  async evaluate(expression) {
    this.calls.push(['evaluate', expression]);
    if (expression === WEB_STATE) {
      assert.ok(this.states.length, 'unexpected page-state read');
      return structuredClone(this.states.shift());
    }
    if (expression === 'localStorage.getItem("flow_tea_user_id")') return baseState.accountId;
    assert.fail(`unexpected evaluation: ${expression.slice(0, 100)}`);
  }
  async send(method, params = {}) {
    this.calls.push(['send', method, params]);
    assert.ok(['Input.insertText', 'Network.enable', 'Emulation.setFocusEmulationEnabled'].includes(method), `unexpected CDP command: ${method}`);
    return {};
  }
  async click(selector) {
    this.calls.push(['click', selector]);
    assert.notEqual(selector, sendSelector, 'guard failure must never click Send');
  }
  subscribe(_event, callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

class NativeSendClient extends GuardClient {
  constructor(states, { message = 'focus test', create = false, sendError, restoreError } = {}) {
    super(states);
    this.message = message;
    this.create = create;
    this.sendError = sendError;
    this.restoreError = restoreError;
    this.focused = false;
    this.serverReads = 0;
    this.listeners = new Map();
  }
  async evaluate(expression) {
      if (expression.includes('const keys =') || expression.includes('/im/conversation/batch_get')) {
        this.calls.push(['evaluate', expression]);
        assert.equal(this.focused, false, 'server waiting must run after native focus emulation is restored');
        if (expression.includes('const keys =')) return {
          params: { aid: '497858', web_id: 'web-user' }, accountId: baseState.accountId, clientEnvId: '',
        };
        this.serverReads++;
        return { downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{
          conversation_id: conversationId,
          messages: [
            { user_type: 1, message_id: '56325877314422786', index_in_conv: '1' },
            { user_type: 2, message_id: '56325877314422787', bot_reply_message_id: '56325877314422786', index_in_conv: '2',
              ext: { is_finish: '1' }, content_block: [{ block_type: 10000, content: { text_block: { text: 'done' } } }] },
          ],
        }] } } };
    }
    return super.evaluate(expression);
  }
  async send(method, params = {}) {
    this.calls.push(['send', method, params]);
    if (method === 'Emulation.setFocusEmulationEnabled') {
      if (!params.enabled && this.restoreError) throw this.restoreError;
      this.focused = params.enabled;
      return {};
    }
    if (method === 'Input.insertText' || method === 'Page.navigate') {
      assert.equal(this.focused, true, 'background native UI must be activated before mutation');
      return {};
    }
    if (method === 'Network.enable') return {};
    if (method === 'Network.streamResourceContent') {
      const ack = { ack_client_meta: { conversation_id: conversationId }, query_list: [{ question_id: '56325877314422786' }] };
      return { bufferedData: Buffer.from(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`).toString('base64') };
    }
    assert.fail(`unexpected CDP command: ${method}`);
  }
  async click(selector) {
    this.calls.push(['click', selector]);
    assert.equal(this.focused, true, 'native click must execute while the background page is active');
    if (selector !== sendSelector) return;
    if (this.sendError) throw this.sendError;
    this.emit('Network.requestWillBeSent', { requestId: 'native-send', request: {
      method: 'POST', url: 'https://www.doubao.com/chat/completion',
      postData: JSON.stringify({ client_meta: { conversation_id: this.create ? '' : conversationId },
        option: { agent_mode: 2 }, messages: [{ local_message_id: 'local-focus-test',
          content_block: [{ content: { text_block: { text: this.message } } }] }] }),
    } });
    this.emit('Network.responseReceived', { requestId: 'native-send', response: { status: 200, mimeType: 'text/event-stream' } });
  }
  subscribe(event, callback) {
    const callbacks = this.listeners.get(event) || new Set();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback);
  }
  emit(event, params) { for (const callback of this.listeners.get(event) || []) callback(params); }
}

test('platform selection preserves the app alias and deterministic desktop defaults', () => {
  assert.throws(() => parseOptions(['--platform', 'web', '--app', 'work', 'status']), /select different backends/u);
  assert.throws(() => parseOptions(['--app', 'doubao', '--platform', 'work', 'status']), /select different backends/u);
  for (const id of ['work', 'doubao']) {
    const options = parseOptions(['--platform', id, '--app', id, 'status']);
    assert.equal(resolvePlatform(options.platform || options.app, {}, () => true).id, id);
    const alias = parseOptions(['--app', id, 'status']);
    assert.equal(resolvePlatform(alias.platform || alias.app, {}, () => true).id, id);
  }
  const options = parseOptions(['status']);
  assert.equal(resolvePlatform(options.platform || options.app, {}, () => true).id, 'work');
  assert.equal(resolvePlatform(options.platform || options.app, {}, () => false).id, 'doubao');
  assert.equal(resolvePlatform(undefined, { DOUBAO_APP: '/tmp/Doubao.app' }, () => true).id, 'doubao');
  assert.equal(resolvePlatform('work', { DOUBAO_APP: '/tmp/Doubao.app' }).appPath, '/Applications/DoubaoWork.app');
  assert.throws(() => parseOptions(['--platform']), /--platform requires/u);
  assert.throws(() => parseOptions(['--platform', 'chrome']), /--platform requires/u);
});

test('web target and mode options are accepted only in their supported scope', () => {
  assert.equal(parseOptions(['--platform', 'web', '--target', 'tab-A', 'status']).targetId, 'tab-A');
  for (const argv of [
    ['--target', 'tab-A', 'status'], ['--platform', 'work', '--target', 'tab-A', 'status'],
    ['--app', 'doubao', '--target', 'tab-A', 'status'],
  ]) assert.throws(() => parseOptions(argv), /--target requires doubao web/u);
  assert.throws(() => parseOptions(['--platform', 'web', '--target']), /requires a CDP target id/u);
  assert.throws(() => parseOptions(['--platform', 'web', '--target', '--json']), /requires a CDP target id/u);
  for (const mode of ['chat', 'work']) {
    assert.equal(parseOptions(['--platform', 'web', 'sessions', 'create', '--mode', mode]).mode, mode);
  }
  const work = parseOptions(['--platform', 'web', 'sessions', 'create', 'test', '--mode', 'work', '--runtime', 'cloud', '--wait']);
  assert.equal(work.runtime, 'cloud');
  assert.equal(work.mode, 'work');
  for (const argv of [
    ['sessions', 'create', '--mode', 'chat'], ['--platform', 'doubao', 'sessions', 'create', '--mode', 'work'],
    ['--platform', 'web', 'status', '--mode', 'chat'],
    ['--platform', 'web', 'sessions', 'send', conversationId, 'test', '--mode', 'work'],
  ]) assert.throws(() => parseOptions(argv), /--mode requires doubao web sessions create/u);
  assert.throws(() => parseOptions(['--platform', 'web', 'sessions', 'create', '--mode', '3']), /--mode requires chat or work/u);
  for (const action of ['status', 'wait', 'stop']) {
    const parsed = parseOptions(['--platform', 'web', 'sessions', action, conversationId, '--run', '56325877314422786']);
    assert.equal(parsed.runId, '56325877314422786');
  }
});

test('unsupported web task flags fail before fetch or desktop profile access', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('unsupported options must not reach the network'));
  const reads = t.mock.method(fs, 'readFileSync', () => assert.fail('unsupported options must not read a profile'));
  const cases = [
    ['--mcp', '123456', '--wait'], ['--model', 'turbo'], ['--reasoning', 'high'],
    ['--attach', '/tmp/input.txt'], ['--runtime', 'local'], ['--profile', 'Other'],
    ['--no-skills'], ['--workspace', '/tmp/ws'], ['--project', 'none'], ['--enterprise-knowledge'],
    ['--runtime', 'local', '--permission', 'AlwaysAsk'], ['--command', '/usr/bin/node'],
    ['--arg', 'flag'], ['--env', 'KEY=value'],
  ];
  for (const flags of cases) {
    await assert.rejects(main(['--platform', 'web', 'sessions', 'create', 'must not send', ...flags]), /not supported on doubao web/u);
  }
  for (const command of [['profiles'], ['mcp', 'list'], ['models'], ['runtimes'], ['projects', 'list'], ['usage']]) {
    await assert.rejects(main(['--platform', 'web', ...command]), /not supported on doubao web/u);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(reads.mock.callCount(), 0);
});

test('web wait flags cannot silently apply to a draft or an unrelated command', () => {
  for (const args of [
    ['--platform', 'web', 'status', '--wait'],
    ['--platform', 'web', 'sessions', 'create', '--wait'],
    ['--platform', 'web', 'sessions', 'send', conversationId, '--wait'],
  ]) assert.throws(() => parseOptions(args), /Web --wait requires/u);
  validateWebOptions(parseOptions(['--platform', 'web', 'sessions', 'wait', conversationId, '--expect-json']));
});

test('unavailable web status never reads desktop metadata or invokes a native bridge', async t => {
  isolatedConfig(t);
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  const reads = t.mock.method(fs, 'readFileSync', () => assert.fail('Web status must not read desktop metadata'));
  const spawn = t.mock.method(childProcess, 'spawnSync', () => assert.fail('Web status must not invoke a native app'));
  syncBuiltinESMExports();
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); throw new Error('offline'); });
  try {
    await main(['--platform', 'web', 'status', '--json']);
    const status = JSON.parse(output[0]);
    assert.equal(status.platform, 'web');
    assert.equal(status.ready, false);
    assert.equal(status.cdp.available, false);
    assert.equal(status.loginRequired, null);
    assert.equal(status.accountId, undefined);
    assert.ok(urls.every(url => url.startsWith(web.endpoint)));
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('CLI web status and rejected options work with no desktop data directory', t => {
  const directory = isolatedConfig(t);
  const env = { ...process.env, DOUBAO_CLI_CONFIG_DIR: directory, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1',
    DOUBAO_APP: '/missing/DoubaoWork.app', DOUBAO_DATA_DIR: '/missing/doubao-data',
    DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:1' };
  const result = childProcess.spawnSync(process.execPath, [cli, '--platform', 'web', 'status', '--json'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).platform, 'web');
  assert.equal(JSON.parse(result.stdout).cdp.available, false);
  assert.doesNotMatch(result.stderr, /Local State|Doubao profile metadata/u);
  const rejected = childProcess.spawnSync(process.execPath, [cli, '--platform', 'web', 'sessions', 'create', 'hello', '--attach', '/tmp/a'], { encoding: 'utf8', env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--attach is not supported on doubao web/u);
  assert.equal(rejected.stdout, '');
});

test('standalone web wait exits nonzero for a server state that is not completed', async t => {
  isolatedConfig(t);
  const runId = '56325877314422786';
  let terminalState = 'waiting_input';
  let disconnectFinalState = false;
  let mismatchFinalState = false;
  let stateReads = 0;
  const output = [];
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  t.mock.method(console, 'log', value => output.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version')
    ? { Browser: 'test', 'Protocol-Version': '1.3' }
    : [{ id: 'web-page', type: 'page', url: baseState.href, webSocketDebuggerUrl: 'ws://fixture' }]));
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const message = JSON.parse(raw);
      assert.equal(message.method, 'Runtime.evaluate');
      const expression = message.params.expression;
      let value;
      if (expression === WEB_STATE) {
        stateReads++;
        value = mismatchFinalState && stateReads > 1 ? { ...baseState, accountId: 'switched-account' } : baseState;
      }
      else if (expression === 'localStorage.getItem("flow_tea_user_id")') value = baseState.accountId;
      else if (expression.includes('const keys =')) value = {
        params: { aid: '497858', web_id: 'web-user' }, accountId: baseState.accountId, clientEnvId: '',
      };
      else if (expression.includes('/im/conversation/batch_get')) {
        const assistant = { user_type: 2, message_id: '56325877314422787', bot_reply_message_id: runId,
          index_in_conv: '2', content_status: 100, content_block: [] };
        if (terminalState === 'completed') {
          assistant.content_status = undefined;
          assistant.ext = { is_finish: '1' };
          assistant.content_block = [{ block_type: 10000, content: { text_block: { text: 'done' } } }];
        } else if (terminalState === 'failed') assistant.content_status = 500;
        else if (terminalState === 'cancelled') assistant.ext = { is_interrupted: 'true' };
        else assistant.content_block = [{ block_type: 10070, block_id: 'ask',
          content: { interaction_ask_block: { status: 1, questions: [] } } }];
        value = { downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{
          conversation_id: conversationId,
          messages: [{ user_type: 1, message_id: runId, index_in_conv: '1' }, assistant],
        }] } } };
      } else assert.fail(`Unexpected evaluation: ${expression.slice(0, 120)}`);
      const evaluation = disconnectFinalState && expression === WEB_STATE && stateReads > 1
        ? { exceptionDetails: { exception: { description: 'CDP client is not connected' } } }
        : { result: { value } };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: message.id, result: evaluation }),
      })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  for (const state of ['waiting_input', 'failed', 'cancelled', 'completed']) {
    terminalState = state;
    stateReads = 0;
    disconnectFinalState = false;
    mismatchFinalState = false;
    process.exitCode = 0;
    await main(['--platform', 'web', 'sessions', 'wait', conversationId, '--run', runId, '--json']);
    assert.equal(output.at(-1).status, state);
    assert.equal(process.exitCode, state === 'completed' ? 0 : 1, state);
  }
  terminalState = 'completed';
  stateReads = 0;
  disconnectFinalState = true;
  mismatchFinalState = false;
  process.exitCode = 0;
  await main(['--platform', 'web', 'sessions', 'wait', conversationId, '--run', runId, '--json']);
  assert.equal(process.exitCode, 1);
  assert.equal(output.at(-1).status, 'completed');
  assert.equal(output.at(-1).conversationId, conversationId);
  assert.equal(output.at(-1).runId, runId);
  assert.equal(output.at(-1).identityVerified, false);
  assert.match(output.at(-1).message, /CDP client is not connected/u);

  stateReads = 0;
  disconnectFinalState = false;
  mismatchFinalState = true;
  process.exitCode = 0;
  await main(['--platform', 'web', 'sessions', 'wait', conversationId, '--run', runId, '--json']);
  assert.equal(process.exitCode, 1);
  assert.equal(output.at(-1).status, 'completed');
  assert.equal(output.at(-1).conversationId, conversationId);
  assert.equal(output.at(-1).runId, runId);
  assert.equal(output.at(-1).identityVerified, false);
  assert.match(output.at(-1).message, /Web account changed/u);

});

test('web browser launch uses a dedicated profile and ignores desktop overrides', t => {
  const directory = isolatedConfig(t);
  withApp(web, () => {
    const profileDir = path.join(fs.realpathSync(directory), 'web-browser');
    const spec = webLaunchSpec({ DOUBAO_CLI_CONFIG_DIR: directory,
      DOUBAO_APP: '/Applications/DoubaoWork.app', DOUBAO_DATA_DIR: '/tmp/desktop-profile' });
    assert.equal(spec.profileDir, profileDir);
    assert.equal(spec.appPath, '/Applications/Google Chrome.app');
    assert.ok(spec.args.includes('--remote-debugging-port=9227'));
    assert.ok(spec.args.includes('--remote-debugging-address=127.0.0.1'));
    assert.ok(spec.args.includes(`--user-data-dir=${profileDir}`));
    const chrome = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    for (const directory of [chrome, path.join(chrome, 'Default'), path.join(chrome, 'Profile 2')]) {
      assert.throws(() => webLaunchSpec({ DOUBAO_WEB_PROFILE_DIR: directory }), /outside the default Chrome profile/u);
    }
  });
  for (const endpoint of ['https://127.0.0.1:9227', 'http://remote.invalid:9227', 'http://user@localhost:9227', 'http://localhost:9227/path']) {
    withApp({ ...web, endpoint }, () => assert.throws(() => webLaunchSpec({}), /localhost HTTP CDP endpoint/u));
  }
});

test('web browser profile guard resolves symlinks and nonexistent child paths', t => {
  const directory = isolatedConfig(t);
  const fakeHome = path.join(directory, 'home');
  const chrome = path.join(fakeHome, 'Library', 'Application Support', 'Google', 'Chrome');
  fs.mkdirSync(chrome, { recursive: true });
  const alias = path.join(directory, 'profile-alias');
  fs.symlinkSync(chrome, alias, 'dir');
  t.mock.method(os, 'homedir', () => fakeHome);
  withApp(web, () => {
    for (const profileDir of [alias, path.join(alias, 'Default'), path.join(alias, 'new-directory')]) {
      assert.throws(() => webLaunchSpec({ DOUBAO_WEB_PROFILE_DIR: profileDir }), /outside the default Chrome profile/u);
    }
  });
});

test('web readiness guards protect login, origin, draft and active generation', () => {
  withApp(web, () => {
    assert.doesNotThrow(() => assertWebReady(baseState, { ordinary: true, idle: true }));
    assert.doesNotThrow(() => assertWebReady({ ...baseState, mode: 'work' }));
    const cases = [
      [{ href: 'https://www.doubao.com.evil.invalid/chat/' }, {}, /left the Doubao chat origin/u],
      [{ href: 'https://user@www.doubao.com/chat/' }, {}, /left the Doubao chat origin/u],
      [{ loginRequired: true }, {}, /requires login/u], [{ ready: false }, {}, /composer is not ready/u],
      [{ mode: 'work' }, { ordinary: true }, /Select an ordinary/u],
      [{ mode: null }, { ordinary: true }, /Select an ordinary/u],
      [{ draft: 'existing draft' }, { idle: true }, /unsent draft or attachments/u],
      [{ attachments: 1 }, { idle: true }, /unsent draft or attachments/u],
      [{ generating: true }, { idle: true }, /is generating/u],
    ];
    for (const [patch, options, error] of cases) assert.throws(() => assertWebReady({ ...baseState, ...patch }, options), error);
  });
});

test('native send refuses an occupied or invalid composer before preparing input', async t => {
  isolatedConfig(t);
  for (const patch of [
    { draft: 'private draft' }, { attachments: 1 }, { generating: true },
    { loginRequired: true }, { ready: false }, { href: 'https://example.com/chat/' },
  ]) {
    const client = new GuardClient([{ ...baseState, ...patch }]);
    await withApp(web, () => assert.rejects(sendWebMessage(client, 'hello', { id: conversationId }), /Doubao|Selected web target/u));
    assert.equal(client.calls.filter(call => call[0] === 'click').length, 0);
    assert.equal(client.calls.filter(call => call[0] === 'send').length, 0);
  }
});

test('native send rechecks account, route, mode and exact draft before clicking Send', async t => {
  isolatedConfig(t);
  const message = 'test message';
  for (const patch of [
    { accountId: 'another-account' }, { mode: 'work' }, { mode: null },
    { href: 'https://www.doubao.com/chat/38439138239851267' },
    { draft: 'test message with private extra text' }, { draft: 'testmessage' },
    { attachments: 1 }, { generating: true }, { loginRequired: true },
    { href: 'https://www.doubao.com.evil.invalid/chat/' },
  ]) {
    const client = new GuardClient([baseState, baseState, baseState, { ...baseState, draft: message, ...patch }]);
    await withApp(web, () => assert.rejects(sendWebMessage(client, message, { id: conversationId }), /composer changed|composer is not ready|requires login|left the Doubao chat origin|Web account changed/u));
    assert.ok(client.calls.some(call => call[0] === 'send' && call[1] === 'Input.insertText'));
    assert.ok(!client.calls.some(call => call[0] === 'click' && call[1] === sendSelector));
    assert.equal(client.listeners.size, 0, 'failed preparation must remove observation listeners');
    assert.deepEqual(client.calls.filter(call => call[1] === 'Emulation.setFocusEmulationEnabled')
      .map(call => call[2].enabled), [true, false]);
    assert.deepEqual(client.calls.at(-1), ['send', 'Emulation.setFocusEmulationEnabled', { enabled: false }]);
  }
});

test('native send does not click a disabled Send button or dispatch after its deadline', async t => {
  isolatedConfig(t);
  const message = 'test message';
  const client = new GuardClient([baseState, baseState, baseState, { ...baseState, draft: message, sendEnabled: false }]);
  await withApp(web, () => assert.rejects(sendWebMessage(client, message, { id: conversationId, timeoutMs: 0 }),
    error => /Send button did not become ready/u.test(error.message) && error.result.sendAttempted === false));
  assert.equal(client.calls.some(([method, selector]) => method === 'click' && selector === sendSelector), false);
  assert.equal(client.listeners.size, 0);
});

test('native send waits for an empty draft to paint the exact inserted message', async t => {
  isolatedConfig(t);
  const message = 'delayed native paint';
  const client = new NativeSendClient([
    baseState, baseState, baseState,
    { ...baseState, draft: '' },
    { ...baseState, draft: message },
    baseState,
  ], { message });
  const result = await withApp(web, () => sendWebMessage(client, message, { id: conversationId }));
  assert.equal(result.accepted, true);
  assert.equal(result.sendAttempted, true);
  assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
});

test('native send polls a temporarily unready composer without resending input', async t => {
  isolatedConfig(t);
  const message = '等待原生编辑器就绪的合成输入';
  const client = new NativeSendClient([
    baseState, baseState, baseState,
    { ...baseState, ready: false, draft: message },
    { ...baseState, ready: true, draft: message },
    baseState,
  ], { message });
  const result = await withApp(web, () => sendWebMessage(client, message, { id: conversationId }));
  assert.equal(result.accepted, true);
  assert.equal(result.sendAttempted, true);
  assert.equal(client.calls.filter(call => call[0] === 'send' && call[1] === 'Input.insertText').length, 1);
  assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
});

test('background web creation and sending activate native input until ACK and restore focus', async t => {
  isolatedConfig(t);
  for (const create of [false, true]) {
    const draft = create ? { ...baseState, href: 'https://www.doubao.com/chat/' } : baseState;
    const client = new NativeSendClient([baseState, baseState, draft, { ...draft, draft: 'focus test' }, baseState], { create });
    const result = await withApp(web, () => sendWebMessage(client, 'focus test', create
      ? { create: true, mode: 'chat' } : { id: conversationId, wait: true }));
    assert.equal(result.accepted, true);
    assert.equal(result.runId, '56325877314422786');
    assert.equal(result.sendAttempted, true);
    assert.equal(client.focused, false, 'finished UI submission must leave normal browser visibility in effect');
    assert.ok(client.calls.some(call => call[0] === 'click' && call[1] === inputSelector));
    assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
    assert.deepEqual(client.calls.filter(call => call[1] === 'Emulation.setFocusEmulationEnabled')
      .map(call => call[2].enabled), [true, false]);
    if (!create) {
      assert.equal(client.serverReads, 1);
      assert.equal(result.status, 'completed');
    }
    assert.ok([...client.listeners.values()].every(callbacks => !callbacks.size));
  }
});

test('native create ACK waits for its routed conversation while preserving the accepted IDs', async t => {
  isolatedConfig(t);
  const draft = { ...baseState, href: 'https://www.doubao.com/chat/' };
  const prepared = { ...draft, draft: 'focus test' };
  const client = new NativeSendClient([
    baseState, baseState, draft, prepared,
    draft, // ACK is durable, but the browser URL has not switched yet.
    baseState, // Next route read reaches the conversation returned by SSE_ACK.
  ], { create: true });
  const result = await withApp(web, () => sendWebMessage(client, 'focus test', { create: true, mode: 'chat' }));
  assert.equal(result.accepted, true);
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.runId, '56325877314422786');
  assert.equal(result.sendAttempted, true);
  assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
  assert.ok(client.calls.filter(call => call[0] === 'evaluate' && call[1] === WEB_STATE).length >= 6);
});

test('post-ACK create tolerates only Doubao local-draft routes before the accepted numeric route', async t => {
  isolatedConfig(t);
  const draft = { ...baseState, href: 'https://www.doubao.com/chat/' };
  const prepared = { ...draft, draft: 'focus test' };
  const localDraft = { ...draft, href: 'https://www.doubao.com/chat/local_7912613623091130' };
  const client = new NativeSendClient([
    baseState, baseState, draft, prepared, localDraft, baseState,
  ], { create: true });
  const result = await withApp(web, () => sendWebMessage(client, 'focus test', { create: true, mode: 'chat' }));
  assert.equal(result.accepted, true);
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.runId, '56325877314422786');
  assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
});

test('post-ACK route wait rejects an external origin or changed account with accepted IDs intact', async t => {
  isolatedConfig(t);
  const draft = { ...baseState, href: 'https://www.doubao.com/chat/' };
  const prepared = { ...draft, draft: 'focus test' };
  const cases = [
    { state: { ...draft, href: 'https://www.doubao.com.evil.invalid/chat/38439138239851266' }, error: /left the Doubao chat origin/u },
    { state: { ...draft, href: 'https://www.doubao.com/chat/local_7912613623091130', accountId: 'other-account' }, error: /Web account changed/u },
  ];
  for (const scenario of cases) {
    const client = new NativeSendClient([baseState, baseState, draft, prepared, scenario.state], { create: true });
    await withApp(web, () => assert.rejects(sendWebMessage(client, 'focus test', { create: true, mode: 'chat' }), error => {
      assert.match(error.message, scenario.error);
      assert.equal(error.result.accepted, true);
      assert.equal(error.result.conversationId, conversationId);
      assert.equal(error.result.runId, '56325877314422786');
      assert.equal(error.result.sendAttempted, true);
      return true;
    }));
    assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
  }
});

test('native send waits for the existing conversation mode to hydrate before preparing input', async t => {
  isolatedConfig(t);
  const modePending = { ...baseState, mode: null, modeLabel: null };
  const prepared = { ...baseState, draft: 'focus test' };
  const client = new NativeSendClient([
    modePending, modePending, modePending, baseState, prepared, baseState,
  ]);
  const result = await withApp(web, () => sendWebMessage(client, 'focus test', { id: conversationId }));
  assert.equal(result.accepted, true);
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.sendAttempted, true);
  assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
});

test('unknown native submission is not retried and preserves its error when focus restoration also fails', async t => {
  isolatedConfig(t);
  const sendError = new Error('native click outcome is unknown');
  const client = new NativeSendClient([baseState, baseState, baseState, { ...baseState, draft: 'focus test' }], {
    sendError, restoreError: new Error('CDP disconnected during restoration'),
  });
  await withApp(web, () => assert.rejects(sendWebMessage(client, 'focus test', { id: conversationId }), error => {
    assert.equal(error, sendError);
    assert.equal(error.result.sendAttempted, true);
    assert.equal(error.result.accepted, false);
    assert.equal(error.focusRestoreError, 'CDP disconnected during restoration');
    return true;
  }));
  assert.equal(client.calls.filter(call => call[0] === 'click' && call[1] === sendSelector).length, 1);
  assert.deepEqual(client.calls.at(-1), ['send', 'Emulation.setFocusEmulationEnabled', { enabled: false }]);
  assert.ok([...client.listeners.values()].every(callbacks => !callbacks.size));
});

test('CLI web draft creation and open restore focus before disconnect on success or UI error', async t => {
  isolatedConfig(t);
  const output = [];
  let state;
  let focused;
  let failMutation;
  let calls;
  t.mock.method(console, 'log', value => output.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version')
    ? { Browser: 'test', 'Protocol-Version': '1.3' }
    : [{ id: 'web-page', type: 'page', url: baseState.href, webSocketDebuggerUrl: 'ws://fixture' }]));
  t.mock.method(CdpClient.prototype, 'connect', async function () { return this; });
  t.mock.method(CdpClient.prototype, 'evaluate', async expression => {
    assert.equal(expression, WEB_STATE);
    calls.push(['state']);
    return { ...state };
  });
  t.mock.method(CdpClient.prototype, 'send', async (method, params) => {
    calls.push([method, params]);
    if (method === 'Emulation.setFocusEmulationEnabled') {
      focused = params.enabled;
      return {};
    }
    assert.equal(method, 'Page.navigate');
    assert.equal(focused, true, 'navigation of a background page needs active focus emulation');
    if (failMutation) return { errorText: 'synthetic UI failure' };
    state.href = params.url;
    return {};
  });
  t.mock.method(CdpClient.prototype, 'click', async selector => {
    calls.push(['click', selector]);
    assert.equal(selector, '[data-testid="create_conversation_button"]');
    assert.equal(focused, true, 'native draft creation needs active focus emulation');
    if (failMutation) throw new Error('synthetic UI failure');
    state.href = 'https://www.doubao.com/chat/';
  });
  t.mock.method(CdpClient.prototype, 'close', () => {
    assert.equal(focused, false, 'disconnect must follow focus restoration');
    calls.push(['close']);
  });
  for (const command of [
    ['sessions', 'create', '--mode', 'chat'],
    ['sessions', 'open', '38439138239851267'],
  ]) {
    for (const failed of [false, true]) {
      state = { ...baseState };
      focused = false;
      failMutation = failed;
      calls = [];
      const operation = main(['--platform', 'web', ...command, '--json']);
      if (failed) await assert.rejects(operation, /synthetic UI failure/u);
      else {
        await operation;
        assert.equal(output.at(-1)[command[1] === 'open' ? 'opened' : 'created'], true);
      }
      assert.deepEqual(calls.filter(call => call[0] === 'Emulation.setFocusEmulationEnabled')
        .map(call => call[1].enabled), [true, false]);
      assert.deepEqual(calls.slice(-2), [
        ['Emulation.setFocusEmulationEnabled', { enabled: false }], ['close'],
      ]);
    }
  }
});

test('CLI web navigation and draft creation stop when the pinned account changes', async t => {
  isolatedConfig(t);
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version')
    ? { Browser: 'test', 'Protocol-Version': '1.3' }
    : [{ id: 'web-page', type: 'page', url: baseState.href, webSocketDebuggerUrl: 'ws://fixture' }]));
  let state, focused;
  t.mock.method(CdpClient.prototype, 'connect', async function () { return this; });
  t.mock.method(CdpClient.prototype, 'evaluate', async expression => {
    assert.equal(expression, WEB_STATE);
    return { ...state };
  });
  t.mock.method(CdpClient.prototype, 'send', async (method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled') { focused = params.enabled; return {}; }
    assert.equal(method, 'Page.navigate');
    assert.equal(focused, true);
    state.href = params.url;
    state.accountId = 'switched-account';
    return {};
  });
  t.mock.method(CdpClient.prototype, 'click', async () => {
    assert.equal(focused, true);
    state.href = 'https://www.doubao.com/chat/';
    state.accountId = 'switched-account';
  });
  t.mock.method(CdpClient.prototype, 'close', () => { assert.equal(focused, false); });

  for (const args of [
    ['sessions', 'open', '38439138239851267'],
    ['sessions', 'create', '--mode', 'chat'],
  ]) {
    state = { ...baseState };
    focused = false;
    await assert.rejects(main(['--platform', 'web', ...args, '--json']), /Web account changed/u);
    assert.equal(focused, false);
  }
});

test('web sidebar list guards origin and pinned UID during evaluation and before return', async t => {
  isolatedConfig(t);
  const outputs = [];
  t.mock.method(console, 'log', value => outputs.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/version')
    ? { Browser: 'test', 'Protocol-Version': '1.3' }
    : [{ id: 'web-page', type: 'page', url: baseState.href, webSocketDebuggerUrl: 'ws://fixture' }]));
  let state, evaluationUrl, evaluationUid, switchAfterList;
  t.mock.method(CdpClient.prototype, 'connect', async function () { return this; });
  t.mock.method(CdpClient.prototype, 'evaluate', async expression => {
    if (expression === WEB_STATE) return { ...state };
    assert.match(expression, /assertIdentity/);
    const sessions = vm.runInNewContext(expression, {
      URL,
      location: { href: evaluationUrl },
      localStorage: { getItem: () => evaluationUid },
      document: { querySelectorAll: () => [] },
    });
    if (switchAfterList) state.accountId = 'switched-account';
    return sessions;
  });
  t.mock.method(CdpClient.prototype, 'close', () => {});

  for (const scenario of [
    { url: 'https://www.doubao.com.evil.invalid/chat/', uid: baseState.accountId, error: /left the Doubao chat origin/u },
    { url: baseState.href, uid: 'another-account', error: /Web account changed/u },
    { url: baseState.href, uid: baseState.accountId, after: true, error: /Web account changed/u },
  ]) {
    state = { ...baseState };
    evaluationUrl = scenario.url;
    evaluationUid = scenario.uid;
    switchAfterList = scenario.after;
    await assert.rejects(main(['--platform', 'web', 'sessions', 'list', '--json']), scenario.error);
  }
  assert.deepEqual(outputs, []);
});

test('cloud runtime and requested creation mode fail safely on a mismatched composer', async t => {
  isolatedConfig(t);
  const ordinary = new GuardClient([baseState, baseState, baseState]);
  await withApp(web, () => assert.rejects(sendWebMessage(ordinary, 'hello', { id: conversationId, runtime: 'cloud' }), /requires a web work conversation/u));
  assert.ok(!ordinary.calls.some(call => call[0] === 'send' && call[1] !== 'Emulation.setFocusEmulationEnabled'));
  const wrongMode = new GuardClient([baseState, baseState, { ...baseState, href: 'https://www.doubao.com/chat/' }]);
  await withApp(web, () => assert.rejects(sendWebMessage(wrongMode, 'hello', { create: true, mode: 'work' }), /does not expose a ready work composer/u));
  assert.ok(wrongMode.calls.some(call => call[0] === 'click' && call[1] === '[data-testid="create_office_task_button"]'));
  assert.ok(!wrongMode.calls.some(call => call[0] === 'send' && call[1] !== 'Emulation.setFocusEmulationEnabled'));
});
