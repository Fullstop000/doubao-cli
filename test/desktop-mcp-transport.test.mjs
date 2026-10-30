import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDesktopMcpTransport } from '../src/desktop-mcp-transport.mjs';

const params = { aid: '1044603', device_id: '12345', pc_version: '2.34.9' };
const streamOptions = { method: 'POST', params: { sand_box_id: 'owned' },
  body: JSON.stringify({ device_id: '12345', client_attrs: { sandbox_id: 'owned' } }) };
const STREAM = '/alice/office/tool_local/chunk_stream';
const RESULT = '/alice/office/tool_local/upload_tool_call_result';
function harness(overrides = {}) {
  const window = {}, calls = [], fetches = [], watchdogs = [], state = { account: 'account', device: '12345', aid: '1044603' };
  window.neotix = { account: { getLoginUser: async () => ({ isLogin: true, userId: state.account }) },
    mcp: { callTool: async input => { calls.push(input); return { mcpResponseJson: '{"content":[]}' }; } } };
  const context = vm.createContext({ window, URL, AbortController, setTimeout, clearTimeout, setInterval: (fn, ms) => { watchdogs.push(fn); return setInterval(fn, ms); }, clearInterval,
    performance: { getEntriesByType: () => [{ name: `https://www.doubao.com/im/get?aid=${state.aid}&device_id=${state.device}` }] },
    fetch: async (...args) => { fetches.push(args); return overrides.fetch ? overrides.fetch(...args) : new Response('{}'); } });
  const client = { evaluate: expression => vm.runInContext(expression, context) };
  return { window, state, calls, fetches, watchdogs, transport: createDesktopMcpTransport(client, { params, accountId: 'account' }) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('only permits the two native endpoints and exact device/sandbox', async () => {
  const h = harness();
  await assert.rejects(h.transport.request('/chat/completion', streamOptions), /Unsupported/);
  await assert.rejects(h.transport.request(STREAM, { ...streamOptions, params: { sand_box_id: 'other' } }), /sandbox mismatch/);
  await assert.rejects(h.transport.json(RESULT, { method: 'POST', body: JSON.stringify({ device_id: 'other', sandbox_id: 'owned' }) }), /does not match/);
  assert.equal(h.fetches.length, 0); await h.transport.close();
});

test('account or device changes block native execution before the call', async () => {
  for (const key of ['account', 'device', 'aid']) {
    const h = harness(); h.state[key] = 'changed';
    await assert.rejects(h.transport.callConnector({ connectorId: 'c', toolName: 'echo', arguments: '{}' }), /changed/);
    assert.equal(h.calls.length, 0); assert.equal(Object.keys(h.window).length, 1); await h.transport.close();
  }
});

test('aborting during identity lookup prevents a late native call', async () => {
  const h = harness(), abort = new AbortController(); let resolve;
  h.window.neotix.account.getLoginUser = () => new Promise(r => { resolve = r; });
  const pending = h.transport.callConnector({ connectorId: 'c', toolName: 'echo', arguments: '{}', signal: abort.signal });
  await tick(); abort.abort(); await assert.rejects(pending, /abort/i);
  resolve({ isLogin: true, userId: 'account' }); await tick();
  assert.equal(h.calls.length, 0); await h.transport.close();
});

test('native errors and malformed results are rejected without retry', async () => {
  const h = harness(); let count = 0;
  h.window.neotix.mcp.callTool = async () => { count++; return { nativeError: { error_code: '-1' }, mcpResponseJson: '{}' }; };
  await assert.rejects(h.transport.callConnector({ connectorId: 'c', toolName: 'echo', arguments: '{}' }), /native tool call failed/);
  h.window.neotix.mcp.callTool = async () => { count++; return { mcpResponseJson: {} }; };
  await assert.rejects(h.transport.callConnector({ connectorId: 'c', toolName: 'echo', arguments: '{}' }), /invalid/);
  assert.equal(count, 2); await h.transport.close();
});

test('stream preserves bytes, uses native auth context and cleans up on EOF', async () => {
  const h = harness({ fetch: async () => new Response('data: {"text":"中文"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await h.transport.request(STREAM, streamOptions);
  assert.equal(await new Response(response.body).text(), 'data: {"text":"中文"}\n\n');
  const [url, options] = h.fetches[0];
  assert.equal(new URL(url).searchParams.get('aid'), '1044603');
  assert.equal(new URL(url).searchParams.get('sand_box_id'), 'owned');
  assert.equal(options.credentials, 'include');
  assert.equal(options.headers['Agw-Js-Conv'], 'str');
  assert.equal(Object.keys(h.window).length, 1); await h.transport.close();
});

test('changed identity during a stream terminates it and removes page state', async () => {
  const h = harness({ fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await h.transport.request(STREAM, streamOptions);
  h.state.account = 'different';
  await assert.rejects(response.body.getReader().read(), /changed/);
  assert.equal(Object.keys(h.window).length, 1); await h.transport.close();
});

test('close aborts a pending HTTP request and prevents subsequent calls', async () => {
  let aborted = false;
  const h = harness({ fetch: (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  }) });
  const pending = h.transport.request(STREAM, streamOptions);
  await tick(); await h.transport.close(); await assert.rejects(pending, /closed/);
  assert.equal(aborted, true); assert.equal(Object.keys(h.window).length, 1);
  await assert.rejects(h.transport.callConnector({ connectorId: 'c', toolName: 'echo', arguments: '{}' }), /closed/);
});

test('result upload is a single authenticated POST and retains application errors', async () => {
  const h = harness({ fetch: async () => new Response('{"code":17}') });
  const result = await h.transport.json(RESULT, { method: 'POST', body: JSON.stringify({ device_id: '12345', sandbox_id: 'owned', tool_result: { id: 'one' } }) });
  assert.equal(result.code, 17); assert.equal(h.fetches.length, 1);
  assert.equal(Object.keys(h.window).length, 1); await h.transport.close();
});


test('closing during an already-started native call rejects without replaying it', async () => {
  const h = harness(); let resolve, count = 0;
  h.window.neotix.mcp.callTool = () => { count++; return new Promise(r => { resolve = r; }); };
  const pending = h.transport.callConnector({ connectorId: 'c', toolName: 'echo', arguments: '{}' });
  await tick(); await h.transport.close(); await assert.rejects(pending, /closed/);
  resolve({ mcpResponseJson: '{}' }); await tick();
  assert.equal(count, 1); assert.equal(Object.keys(h.window).length, 1);
});

test('dead-host watchdog deletes its renderer stream and fails the next read', async () => {
  const h = harness({ fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await h.transport.request(STREAM, streamOptions);
  const key = Object.keys(h.window).find(k => k.startsWith('__doubaoMcpTransport_'));
  h.window[key].touched = Date.now() - 16_000; h.watchdogs[0]();
  await assert.rejects(response.body.getReader().read(), /no longer available|cancelled/);
  assert.equal(Object.keys(h.window).length, 1); await h.transport.close();
});

test('renderer queue applies backpressure while host is not draining', async () => {
  const chunk = new Uint8Array(64 * 1024); let produced = 0;
  const h = harness({ fetch: async () => new Response(new ReadableStream({ pull(controller) { produced++; controller.enqueue(chunk); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await h.transport.request(STREAM, streamOptions);
  await new Promise(r => setTimeout(r, 50));
  const key = Object.keys(h.window).find(k => k.startsWith('__doubaoMcpTransport_'));
  assert(h.window[key].bytes <= 2 * 1024 * 1024);
  assert(produced < 100, 'reading must stop when the queue fills');
  await response.body.cancel(); await h.transport.close();
});
