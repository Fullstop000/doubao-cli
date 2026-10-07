import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { followTaskStreams, imRequest, readTurn, stopTurn, waitTurn } from '../src/turns.mjs';

const conversationId = '38442602625749250';
const runId = '56322687642882050';
const threadId = '56320433759901186';
const app = { ...resolvePlatform('web', {}), accountId: 'account-A' };

function clientFixture({ afterParameters = () => {}, handler = async () => Response.json({ downlink_body: {} }),
  browserSetTimeout = setTimeout } = {}) {
  const identity = { uid: 'account-A', origin: 'https://www.doubao.com', pathname: '/chat/' };
  const calls = [];
  const context = vm.createContext({ URL, crypto, AbortSignal, AbortController, TextDecoder, Date,
    setTimeout: browserSetTimeout, clearTimeout,
    location: identity,
    performance: { getEntriesByType: () => [{ name: 'https://www.doubao.com/im/conversation/batch_get?aid=497858&web_id=browser' }] },
    localStorage: { getItem: () => identity.uid },
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body), uid: identity.uid });
      return handler(String(url), options, identity);
    },
  });
  return { identity, calls, close() {}, async evaluate(expression) {
    const result = await vm.runInContext(expression, context);
    // This is the CDP boundary that formerly allowed a different account's fetch.
    if (expression.includes('const keys =')) afterParameters(identity, calls);
    return result;
  } };
}

test('Web IM rejects account or origin drift between parameter lookup and fetch', async () => {
  for (const patch of [{ uid: 'account-B' }, { origin: 'https://example.com' }]) {
    const client = clientFixture({ afterParameters: identity => Object.assign(identity, patch) });
    await withApp(app, () => assert.rejects(imRequest(client, 'conversation/batch_get', 1111,
      'batch_get_conv_info_uplink_body', { conversation_id: [conversationId] }), /account changed|left the Doubao chat origin/u));
    assert.equal(client.calls.length, 0, 'identity drift must reject before a request is made');
  }
});

test('Web IM does not return data when identity changes during HTTP or JSON response reading', async () => {
  for (const stage of ['HTTP', 'JSON']) {
    const client = clientFixture({ handler: async (_url, _options, identity) => {
      if (stage === 'HTTP') identity.uid = 'account-B';
      return { ok: true, async json() {
        if (stage === 'JSON') identity.origin = 'https://example.com';
        return { downlink_body: { privateFixture: 'must not be returned' } };
      } };
    } });
    await withApp(app, () => assert.rejects(imRequest(client, 'conversation/batch_get', 1111,
      'batch_get_conv_info_uplink_body', { conversation_id: [conversationId] }), /account changed|left the Doubao chat origin/u));
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].uid, 'account-A');
  }
});

test('Web wait preserves accepted run identifiers when an account race blocks lookup', async () => {
  const client = clientFixture({ afterParameters: identity => { identity.uid = 'account-B'; } });
  const receipt = { conversationId, runId, localMessageId: 'accepted-local-id', accepted: true };
  await withApp(app, () => assert.rejects(waitTurn(client, conversationId, { runId, receipt, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'task_unavailable');
    assert.equal(error.result.conversationId, conversationId);
    assert.equal(error.result.runId, runId);
    assert.equal(error.result.localMessageId, receipt.localMessageId);
    assert.match(error.message, /account changed/u);
    return true;
  }));
  assert.equal(client.calls.length, 0);
});

test('Web terminate validates the account in its fetch evaluation and keeps the selected run', async () => {
  const root = { user_type: 1, message_id: runId, index_in_conv: '1' };
  const assistant = { user_type: 2, message_id: '56310000000000002', bot_reply_message_id: runId,
    index_in_conv: '2', content_status: 100, content_block: [{ block_type: 10090,
      content: { complex_task_block: { thread_id: threadId } } }] };
  for (const stage of ['before-fetch', 'response']) {
    const client = clientFixture({
    afterParameters(identity, calls) {
      if (stage === 'before-fetch' && calls.at(-1)?.url.includes('/message/break_stream_msg')) identity.uid = 'account-B';
    },
    handler: async (url, _options, identity) => {
      if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
        batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId,
          conversation_type: 3, messages: [root, assistant] }] },
      } });
      if (url.includes('/thread/info')) return Response.json({ downlink_body: {
        get_thread_info_downlink_body: { thread_info: { source_conversation_id: conversationId, ext: { thread_status: 'running' } } },
      } });
      if (url.includes('/chain/thread_message')) return Response.json({ downlink_body: {
        pull_thread_message_chain_downlink_body: { messages: [], has_more: false },
      } });
      if (url.includes('/message/break_stream_msg')) return Response.json({ downlink_body: {} });
      if (stage === 'response' && url.includes('/generaltask/terminate')) {
        identity.uid = 'account-B';
        return Response.json({ code: 0 });
      }
      assert.fail(`Unexpected request: ${url}`);
    },
    });
    await withApp(app, () => assert.rejects(stopTurn(client, conversationId, { runId, timeoutMs: 1000 }), error => {
      assert.match(error.message, /account changed/u);
      assert.equal(error.result.stopped, false);
      assert.equal(error.result.conversationId, conversationId);
      assert.equal(error.result.runId, runId);
      assert.ok(error.result.errors.some(error => /account changed/u.test(error.message)));
      return true;
    }));
    assert.equal(client.calls.filter(call => call.url.includes('/generaltask/terminate')).length, stage === 'before-fetch' ? 0 : 1);
    assert.ok(client.calls.every(call => call.uid === 'account-A'));
  }
});

test('Web async streams reject identity races without reconnecting or losing accepted identifiers', async () => {
  for (const stage of ['before-fetch', 'response', 'read']) {
    let cancelledReader = 0;
    const client = clientFixture({
      afterParameters: identity => { if (stage === 'before-fetch') identity.uid = 'account-B'; },
      handler: async (_url, _options, identity) => {
        if (stage === 'response') identity.uid = 'account-B';
        return { ok: true, body: { getReader() { return {
          async read() {
            if (stage === 'read') identity.origin = 'https://example.com';
            return { done: false, value: new TextEncoder().encode('event: SSE_REPLY_END\ndata: {"end_type":3}\n\n') };
          },
          async cancel() { cancelledReader++; },
        }; } } };
      },
    });
    const receipt = { conversationId, runId, handoffs: [{ taskId: threadId, appendScene: 7, seq: 0 }] };
    await withApp(app, () => assert.rejects(followTaskStreams(client, receipt, 1000), /account changed|left the Doubao chat origin/u));
    assert.equal(client.calls.length, stage === 'before-fetch' ? 0 : 1, 'identity errors must not become connection retries');
    assert.equal(receipt.conversationId, conversationId);
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.handoffs[0].completed, undefined);
    if (stage === 'read') assert.equal(cancelledReader, 1);
  }
});

test('a quiet Web async stream returns at its polling deadline without closing CDP', async () => {
  let closes = 0;
  const client = clientFixture({ handler: async (_url, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true }); },
  })) });
  client.close = () => { closes++; };
  const receipt = { conversationId, runId, handoffs: [{ taskId: threadId, appendScene: 7, seq: 0 }] };
  await withApp(app, () => followTaskStreams(client, receipt, 100));
  assert.equal(closes, 0, 'ordinary stream polling must finish before the CDP watchdog');
  assert.equal(client.calls.length, 1);
  assert.equal(receipt.handoffs[0].completed, undefined);
  assert.ok(receipt.handoffs[0].connectionError);
});

test('Web handoff recovery uses its verified chat origin and advances the saved sequence', async () => {
  for (const origin of ['https://www.doubao.com', 'https://doubao.com']) {
    const client = clientFixture({ handler: async (_url, options) => {
      assert.equal(JSON.parse(options.body).seq_start, 5);
      const notification = { meta: { message_id: '56310000000000002', thread_id: '0', bot_reply_message_id: runId },
        content: { content_block: [{ block_id: 'task-card', block_type: 10090,
          content: { complex_task_block: { thread_id: threadId } } }] } };
      const body = `id: 6\nevent: STREAM_MSG_NOTIFY\ndata: ${JSON.stringify(notification)}\n\n`
        + 'id: 7\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n';
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    } });
    client.identity.origin = origin;
    const receipt = { conversationId, runId, handoffs: [{ taskId: threadId, appendScene: 7, seq: 5,
      connectionError: 'Failed to fetch' }] };
    await withApp(app, () => followTaskStreams(client, receipt, 1000));
    assert.equal(client.calls.length, 1);
    assert.equal(new URL(client.calls[0].url).origin, origin);
    assert.equal(new URL(client.calls[0].url).pathname, '/chat/async/chunk_stream');
    assert.equal(receipt.handoffs[0].seq, 7);
    assert.equal(receipt.handoffs[0].completed, true);
    assert.equal(receipt.handoffs[0].connectionError, undefined);
    assert.equal(receipt.liveMessages[0].message_id, '56310000000000002');
  }
});

test('Web request observation bounds hung HTTP and JSON without closing CDP or consuming late data', async () => {
  for (const stage of ['HTTP', 'JSON']) {
    let closes = 0, releaseLate, signal, jsonReads = 0;
    const client = clientFixture({ handler: async (_url, options) => {
      signal = options.signal;
      const response = { ok: true, json() {
        jsonReads++;
        return stage === 'JSON' ? new Promise(resolve => { releaseLate = resolve; }) : { downlink_body: {} };
      } };
      if (stage === 'HTTP') return new Promise(resolve => { releaseLate = () => resolve(response); });
      return response;
    } });
    client.close = () => { closes++; };
    await withApp(app, () => assert.rejects(imRequest(client, 'conversation/batch_get', 1111,
      'batch_get_conv_info_uplink_body', { conversation_id: [conversationId] }, 100), /request deadline elapsed/u));
    assert.equal(closes, 0);
    assert.equal(signal.aborted, true);
    assert.equal(client.calls.length, 1);
    releaseLate({ downlink_body: { privateLateData: true } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(jsonReads, stage === 'HTTP' ? 0 : 1, 'an expired HTTP observation must not start JSON reading');
    assert.equal(client.calls.length, 1);
  }
});

test('throttled Web request timers cannot close CDP or make a late response start another phase', async () => {
  let closes = 0, jsonReads = 0, releaseLate, signal;
  const client = clientFixture({ browserSetTimeout: (callback, ms) => setTimeout(callback, ms + 1000),
    handler: async (_url, options) => {
      signal = options.signal;
      return new Promise(resolve => { releaseLate = () => resolve({ ok: true, json() { jsonReads++; return {}; } }); });
    } });
  client.close = () => { closes++; };
  await withApp(app, () => assert.rejects(imRequest(client, 'conversation/batch_get', 1111,
    'batch_get_conv_info_uplink_body', { conversation_id: [conversationId] }, 100), /did not settle within/u));
  assert.equal(closes, 0);
  releaseLate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(signal.aborted, true);
  assert.equal(jsonReads, 0);
  assert.equal(client.calls.length, 1);
});

test('expired Web turn reads and stop attempts issue no evaluation and preserve accepted identifiers', async () => {
  const client = { evaluate() { assert.fail('an expired budget cannot issue a page evaluation'); }, close() { assert.fail('must keep CDP connected'); } };
  const receipt = { conversationId, runId, localMessageId: 'accepted-local-id', accepted: true };
  const deadline = Date.now() - 1;
  await withApp(app, () => assert.rejects(readTurn(client, conversationId, { runId, receipt, deadline }), /deadline elapsed/u));
  const result = await withApp(app, () => stopTurn(client, conversationId, { runId, receipt, deadline }));
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.runId, runId);
  assert.equal(result.localMessageId, receipt.localMessageId);
  assert.equal(result.stopped, false);
  assert.equal(result.status, 'unknown');
  assert.equal(receipt.cancellation, undefined);
});

test('a delayed Web evaluation cannot start requests after its caller has timed out', async () => {
  for (const operation of ['IM', 'stream']) {
    let startLate, closes = 0;
    const client = clientFixture();
    const evaluate = client.evaluate.bind(client);
    client.evaluate = expression => expression.includes('const keys =') ? evaluate(expression)
      : new Promise((resolve, reject) => { startLate = () => evaluate(expression).then(resolve, reject); });
    client.close = () => { closes++; };
    const receipt = { conversationId, runId, handoffs: [{ taskId: threadId, appendScene: 7, seq: 5 }] };
    const saved = structuredClone(receipt);
    await withApp(app, () => assert.rejects(operation === 'IM'
      ? imRequest(client, 'conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', { conversation_id: [conversationId] }, 100)
      : followTaskStreams(client, receipt, 100), /did not settle within/u));
    assert.equal(closes, 0);
    startLate();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(client.calls.length, 0, operation);
    assert.deepEqual(structuredClone(receipt), saved, 'a timed-out observation cannot publish a late checkpoint');
  }
});

test('Web stop does not start deadline-expired readback after a cancellation response', async t => {
  let clock = 1000, closes = 0;
  t.mock.method(Date, 'now', () => clock);
  const root = { user_type: 1, message_id: runId, index_in_conv: '1' };
  const assistant = { user_type: 2, message_id: '56310000000000002', bot_reply_message_id: runId,
    index_in_conv: '2', content_status: 100, content_block: [{ block_type: 10090,
      content: { complex_task_block: { thread_id: threadId } } }] };
  const client = clientFixture({ handler: async url => {
    if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
      batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId,
        conversation_type: 3, messages: [root, assistant] }] },
    } });
    if (url.includes('/thread/info')) return Response.json({ downlink_body: {
      get_thread_info_downlink_body: { thread_info: { source_conversation_id: conversationId, ext: { thread_status: 'running' } } },
    } });
    if (url.includes('/chain/thread_message')) return Response.json({ downlink_body: {
      pull_thread_message_chain_downlink_body: { messages: [], has_more: false },
    } });
    if (url.includes('/message/break_stream_msg')) return Response.json({ downlink_body: {} });
    if (url.includes('/generaltask/terminate')) return { ok: true, json() { clock += 1000; return { code: 0 }; } };
    assert.fail(`Unexpected request: ${url}`);
  } });
  client.close = () => { closes++; };
  const receipt = { conversationId, runId, localMessageId: 'accepted-local-id', accepted: true };
  const result = await withApp(app, () => stopTurn(client, conversationId, { runId, receipt, timeoutMs: 100 }));
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.runId, runId);
  assert.equal(result.localMessageId, receipt.localMessageId);
  assert.equal(result.stopped, false);
  assert.equal(receipt.cancellation.accepted, true, 'an observed root cancellation ACK must survive the later deadline');
  assert.equal(client.calls.at(-1).url.includes('/generaltask/terminate'), true);
  assert.equal(client.calls.filter(call => call.url.includes('/conversation/batch_get')).length, 1);
  assert.equal(closes, 0);
  assert.match(result.errors.at(-1).message, /deadline elapsed/u);
});

test('Web stop preserves known IDs when native parameter hydration cannot settle inside its budget', async () => {
  let closes = 0;
  const client = { evaluate() { return new Promise(() => {}); }, close() { closes++; } };
  const receipt = { conversationId, runId, localMessageId: 'accepted-local-id', accepted: true };
  const result = await withApp(app, () => stopTurn(client, conversationId, { runId, receipt, timeoutMs: 100 }));
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.runId, runId);
  assert.equal(result.localMessageId, receipt.localMessageId);
  assert.equal(result.stopped, false);
  assert.equal(result.status, 'unknown');
  assert.equal(closes, 0);
  assert.match(result.errors[0].message, /did not settle within/u);
});

test('Web stream checkpoints survive hung fetch, read and cancel without CDP closure or late requests', async () => {
  const frame = (id, event, data) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const progress = frame(8, 'STREAM_MSG_NOTIFY', { meta: { message_id: '56310000000000002', thread_id: '0', bot_reply_message_id: runId },
      content: { content_block: [{ block_id: 'task-card', block_type: 10090,
        content: { complex_task_block: { thread_id: threadId } } }] } });
  const lateChild = frame(10, 'FETCH_STREAM', { fetch_type: 2, fetch_key: 'late-child', append_scene: 7 });
  for (const stage of ['fetch', 'read', 'cancel']) {
    let closes = 0, cancels = 0, releaseLate;
    let signal;
    const client = clientFixture({ handler: async (_url, options) => {
      signal = options.signal;
      if (stage === 'fetch') return new Promise(resolve => { releaseLate = resolve; });
      let reads = 0;
      return { ok: true, body: { getReader() { return {
        async read() {
          if (reads++ === 0) return { done: false, value: new TextEncoder().encode(progress
            + (stage === 'cancel' ? frame(9, 'SSE_REPLY_END', { end_type: 3 }) : '')) };
          return new Promise(resolve => { releaseLate = resolve; });
        },
        cancel() { cancels++; return new Promise(() => {}); },
      }; } } };
    } });
    client.close = () => { closes++; };
    const receipt = { conversationId, runId, handoffs: [{ taskId: threadId, appendScene: 7, seq: 3 }] };
    const checkpoints = [];
    await withApp(app, () => followTaskStreams(client, receipt, 200, next => checkpoints.push(structuredClone(next))));
    assert.equal(closes, 0, stage);
    assert.equal(client.calls.length, 1, 'a bounded observation must not reconnect after its deadline');
    assert.equal(signal.aborted, true, 'close only the stream observation, keeping the accepted task intact');
    assert.equal(receipt.conversationId, conversationId);
    assert.equal(receipt.runId, runId);
    assert.equal(checkpoints.length, 1);
    if (stage !== 'fetch') {
      assert.equal(receipt.liveMessages[0].message_id, '56310000000000002');
      assert.equal(receipt.handoffs[0].seq, stage === 'cancel' ? 9 : 8);
      assert.equal(cancels, 1);
    }
    assert.equal(Boolean(receipt.handoffs[0].completed), stage === 'cancel');
    const saved = structuredClone(receipt);
    if (releaseLate) {
      releaseLate(stage === 'fetch' ? new Response(lateChild) : { done: false, value: new TextEncoder().encode(lateChild) });
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(structuredClone(receipt), saved, 'late transport data must not mutate a returned checkpoint');
      assert.equal(client.calls.length, 1);
    }
  }
});

test('Web identity drift rejects a hung stream immediately instead of waiting for transport cleanup', async () => {
  let closes = 0;
  const client = clientFixture({ handler: async () => ({ ok: true, body: { getReader() { return {
    read() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); },
  }; } } }) });
  client.close = () => { closes++; };
  const receipt = { conversationId, runId, handoffs: [{ taskId: threadId, appendScene: 7, seq: 3 }] };
  const switchTimer = setTimeout(() => { client.identity.uid = 'account-B'; }, 10);
  try {
    await withApp(app, () => assert.rejects(followTaskStreams(client, receipt, 1000), /account changed/u));
  } finally { clearTimeout(switchTimer); }
  assert.equal(closes, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.handoffs[0].seq, 3);
});
