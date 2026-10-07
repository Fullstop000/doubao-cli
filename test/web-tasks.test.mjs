import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeParameters } from '../src/protocol.mjs';
import { imRequest, readTurn, receiptStore, stopTurn, summarizeTurn, waitTurn } from '../src/turns.mjs';
import { withApp, resolvePlatform, resolveApp } from '../src/app.mjs';

const conversationId = '38442602625749250';
const runId = '56322687642882050';
const childId = '56320433759901186';
const root = { user_type: 1, message_id: runId, index_in_conv: '1' };
const text = value => ({ block_type: 10000, content: { text_block: { text: value } } });
const task = thread => ({ block_type: 10090, content: { complex_task_block: { thread_id: thread, display_type: 'organizer' } } });
const assistant = { message_id: '56310000000000002', index_in_conv: '2', user_type: 2,
  bot_reply_message_id: runId, content_block: [text('working'), task(childId)], content_status: 100 };

function makeWebClient({ handler = async () => Response.json({}), aid = '497858', identity = 'web_id=web-user',
  origin = 'https://www.doubao.com', pathname = '/chat/', uid = 'web-user' } = {}) {
  const expressions = [], urls = [];
  const resource = `https://www.doubao.com/im/conversation/batch_get?aid=${aid}&${identity}&msToken=secret&a_bogus=secret&x-helios=secret&x-medusa=secret`;
  const context = vm.createContext({
    URL, crypto, AbortSignal, AbortController, TextDecoder, setTimeout, clearTimeout,
    location: { origin, pathname },
    performance: { getEntriesByType: () => [{ name: resource }] },
    window: new Proxy({}, { get(_target, key) { if (key === 'neotix') throw new Error('web must not access desktop runtime'); return undefined; } }),
    localStorage: { getItem: () => uid },
    fetch: async (url, options = {}) => { urls.push(String(url)); return handler(String(url), options); },
  });
  return {
    expressions, urls,
    evaluate(expression) { expressions.push(expression); return vm.runInContext(expression, context); },
    close() {},
  };
}

function makeDesktopClient(handler) {
  const context = vm.createContext({
    URL, crypto, AbortSignal, AbortController, TextDecoder, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => [{ name: 'https://www.doubao.com/im/conversation/batch_get?aid=1044603&device_id=desktop' }] },
    window: { neotix: { taskMode: { runtime: { queryRuntimeInfo: async () => ({ env: {} }) } } } },
    fetch: async (url, options = {}) => handler(String(url), options),
  });
  return { evaluate: expression => vm.runInContext(expression, context), close() {} };
}

test('Web runtime uses its own aid and non-secret request parameters without desktop runtime injection', async () => {
  const client = makeWebClient();
  const runtime = await withApp(resolvePlatform('web', { DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:9444' }),
    () => runtimeParameters(client));
  assert.equal(runtime.params.aid, '497858');
  assert.equal(runtime.params.web_id, 'web-user');
  assert.equal(runtime.accountId, 'web-user');
  assert.equal(runtime.clientEnvId, '');
  assert.doesNotMatch(runtime.query, /msToken|a_bogus|x-helios|x-medusa/);
  assert.doesNotMatch(client.expressions[0], /neotix|queryRuntimeInfo/);
});

test('the bare Doubao Web chat origin is accepted while API resources remain on www', async () => {
  const client = makeWebClient({ origin: 'https://doubao.com' });
  const runtime = await withApp(resolvePlatform('web', {}), () => runtimeParameters(client));
  assert.equal(runtime.params.aid, '497858');
});

test('Web runtime rejects spoofed origins and unrelated aid values', async () => {
  for (const client of [
    makeWebClient({ origin: 'https://attacker.example' }),
    makeWebClient({ aid: '1044603' }),
  ]) {
    await withApp(resolvePlatform('web', {}), () => assert.rejects(runtimeParameters(client), /Doubao Web runtime identity|Doubao Web runtime parameters/));
  }
});

test('Web runtime and receipt store reject an account switch before any IM request', async () => {
  const client = makeWebClient({ uid: 'new-user' });
  const app = { ...resolvePlatform('web', {}), accountId: 'pinned-user' };
  await withApp(app, () => assert.rejects(imRequest(client, 'conversation/batch_get', 1111,
    'batch_get_conv_info_uplink_body', { conversation_id: ['38442602625749250'] }), /account changed/));
  const generated = client.expressions[0];
  const identityCheck = generated.indexOf('accountId !== initialAccountId');
  assert.ok(identityCheck >= 0 && identityCheck < generated.indexOf("performance.getEntriesByType('resource')"));
  await withApp(app, () => assert.rejects(receiptStore(client), /account changed/));
  assert.deepEqual(client.urls, []);
});

test('receipt scope separates web endpoints and accounts from each other and desktop apps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-web-receipts-'));
  const oldConfig = process.env.DOUBAO_CLI_CONFIG_DIR;
  process.env.DOUBAO_CLI_CONFIG_DIR = dir;
  const firstApp = resolvePlatform('web', { DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:9444' });
  const secondApp = resolvePlatform('web', { DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:9555' });
  try {
    const first = await withApp(firstApp, () => receiptStore(makeWebClient()));
    first.save({ conversationId, runId, handoffs: [{ taskId: 'web-job', seq: 2 }] });
    const otherEndpoint = await withApp(secondApp, () => receiptStore(makeWebClient()));
    const otherAccount = await withApp(firstApp, () => receiptStore(makeWebClient({ uid: 'another-user' })));
    const desktop = await withApp(resolveApp('work', {}), () => receiptStore({ evaluate: async () => 'web-user' }));
    assert.deepEqual(otherEndpoint.read(conversationId, runId), {});
    assert.deepEqual(otherAccount.read(conversationId, runId), {});
    assert.deepEqual(desktop.read(conversationId, runId), {});
    assert.equal(first.read(conversationId, runId).handoffs[0].taskId, 'web-job');
  } finally {
    if (oldConfig === undefined) delete process.env.DOUBAO_CLI_CONFIG_DIR;
    else process.env.DOUBAO_CLI_CONFIG_DIR = oldConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Web stop sends a precise numeric thread id and does not retry a definitive HTTP 400', async () => {
  const expressions = [], urls = [];
  let terminateCount = 0;
  const client = makeWebClient({ handler: async (url, options = {}) => {
    urls.push(url);
    if (url.includes('/message/break_stream_msg')) return Response.json({ downlink_body: {} });
    if (url.includes('/alice/generaltask/terminate')) {
      terminateCount++;
      assert.equal(options.body, `{"thread_id":${childId}}`);
      return new Response('InvalidRequest: expected int', { status: 400 });
    }
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
    throw new Error(`Unexpected URL ${url}`);
  } });
  const evaluate = client.evaluate.bind(client);
  client.evaluate = expression => { expressions.push(expression); return evaluate(expression); };
  const app = resolvePlatform('web', {});
  const result = await withApp(app, () => stopTurn(client, conversationId, {
    runId, timeoutMs: 200, receipt: { handoffs: [{ taskId: childId, completed: true }] },
  }));
  assert.equal(result.stopped, false);
  assert.ok(urls.some(url => url.includes('/message/break_stream_msg')));
  const terminate = urls.find(url => url.includes('/alice/generaltask/terminate'));
  assert.ok(terminate);
  const parsed = new URL(terminate);
  assert.equal(parsed.origin, 'https://www.doubao.com');
  assert.equal(parsed.searchParams.get('aid'), '497858');
  assert.equal(parsed.searchParams.get('web_id'), 'web-user');
  assert.ok(expressions.every(expression => !expression.includes('@flow-web/desktop:stable')));
  assert.equal(terminateCount, 1);
});

test('Web stop reports success only after the server task tree confirms cancellation', async () => {
  let childStopped = false;
  const client = makeWebClient({ handler: async (url, options = {}) => {
    if (url.includes('/message/break_stream_msg')) return Response.json({ downlink_body: {} });
    if (url.includes('/alice/generaltask/terminate')) {
      assert.equal(options.body, `{"thread_id":${childId}}`);
      childStopped = true;
      return Response.json({ code: 0 });
    }
    if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
      batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId,
        conversation_type: 3, messages: [root, assistant] }] },
    } });
    if (url.includes('/thread/info')) return Response.json({ downlink_body: {
      get_thread_info_downlink_body: { thread_info: { source_conversation_id: conversationId,
        ext: { thread_status: childStopped ? 'cancelled' : 'running' } } },
    } });
    if (url.includes('/chain/thread_message')) return Response.json({ downlink_body: {
      pull_thread_message_chain_downlink_body: { messages: [], has_more: false },
    } });
    throw new Error(`Unexpected URL ${url}`);
  } });
  const receipt = { handoffs: [{ taskId: childId, completed: true }] };
  const result = await withApp(resolvePlatform('web', {}), () => stopTurn(client, conversationId, { runId, timeoutMs: 1000, receipt }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopped, true);
  assert.equal(receipt.cancellation.confirmed, true);
});

test('readTurn seeds native handoff threads but still verifies conversation ownership', async () => {
  const main = { ...assistant, content_block: [text('working')] };
  const makeHandler = sourceConversationId => async url => {
    if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
      batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId, messages: [root, main] }] },
    } });
    if (url.includes('/thread/info')) return Response.json({ downlink_body: {
      get_thread_info_downlink_body: { thread_info: { source_conversation_id: sourceConversationId, ext: { thread_status: 'running' } } },
    } });
    if (url.includes('/chain/thread_message')) return Response.json({ downlink_body: {
      pull_thread_message_chain_downlink_body: { messages: [], has_more: false },
    } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const receipt = { handoffs: [{ taskId: 'native-task', appendScene: 7, threadId: childId, seq: 0 }] };
  const wrong = makeWebClient({ handler: makeHandler('99999999999999999') });
  await withApp(resolvePlatform('web', {}), () => assert.rejects(readTurn(wrong, conversationId, { runId, receipt }), /does not belong/));

  const valid = makeWebClient({ handler: makeHandler(conversationId) });
  const snapshot = await withApp(resolvePlatform('web', {}), () => readTurn(valid, conversationId, { runId, receipt }));
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0].threadId, childId);
  assert.equal(snapshot.nodes[0].status, 'running');
  assert.equal(snapshot.result.tasks.total, 1);
});

test('Web stop does not confirm a root-only break while native task tracking is incomplete', async () => {
  let breakAccepted = false;
  const running = { ...assistant, content_block: [text('working')] };
  const cancelled = { ...running, content_block: [text('Stopped')], content_status: 120,
    ext: { is_interrupted: 'true' } };
  const client = makeWebClient({ handler: async url => {
    if (url.includes('/message/break_stream_msg')) { breakAccepted = true; return Response.json({ downlink_body: {} }); }
    if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
      batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId,
        conversation_type: 3, messages: [root, breakAccepted ? cancelled : running] }] },
    } });
    throw new Error(`Unexpected URL ${url}`);
  } });
  const result = await withApp(resolvePlatform('web', {}), () => stopTurn(client, conversationId, {
    runId, timeoutMs: 35, receipt: { taskTrackingIncomplete: true, handoffs: [] },
  }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopped, false);
  assert.match(result.reason, /task tracking was incomplete/);
});

test('Web stop keeps a naturally completed reply when the accepted break request races completion', async () => {
  let breakAccepted = false;
  const running = { ...assistant, content_block: [text('working')] };
  const completed = { ...running, content_block: [text('Finished before cancellation took effect')],
    content_status: undefined, ext: { is_finish: '1' } };
  const client = makeWebClient({ handler: async url => {
    if (url.includes('/message/break_stream_msg')) { breakAccepted = true; return Response.json({ downlink_body: {} }); }
    if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
      batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId,
        conversation_type: 3, messages: [root, breakAccepted ? completed : running] }] },
    } });
    throw new Error(`Unexpected URL ${url}`);
  } });
  const result = await withApp(resolvePlatform('web', {}), () => stopTurn(client, conversationId, { runId, timeoutMs: 1000 }));
  assert.equal(result.status, 'completed');
  assert.equal(result.reply.text, 'Finished before cancellation took effect');
  assert.equal(result.stopped, true);
  assert.equal(result.reason, undefined);
});

test('Web confirmed root cancellation with completed children stays cancelled on later reads', async () => {
  let breakAccepted = false, childTerminateRequested = false;
  const cancelledRoot = { ...assistant, content_block: [text('Stopped'), task(childId)],
    content_status: 120, ext: { is_interrupted: 'true' } };
  const client = makeWebClient({ handler: async (url, options = {}) => {
    if (url.includes('/message/break_stream_msg')) { breakAccepted = true; return Response.json({ downlink_body: {} }); }
    if (url.includes('/alice/generaltask/terminate')) {
      assert.equal(options.body, `{"thread_id":${childId}}`);
      childTerminateRequested = true;
      return Response.json({ code: 0 });
    }
    if (url.includes('/conversation/batch_get')) return Response.json({ downlink_body: {
      batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId,
        conversation_type: 3, messages: [root, breakAccepted ? cancelledRoot : assistant] }] },
    } });
    if (url.includes('/thread/info')) return Response.json({ downlink_body: {
      get_thread_info_downlink_body: { thread_info: { source_conversation_id: conversationId,
        ext: { thread_status: childTerminateRequested ? 'completed' : 'running' } } },
    } });
    if (url.includes('/chain/thread_message')) return Response.json({ downlink_body: {
      pull_thread_message_chain_downlink_body: { messages: [], has_more: false },
    } });
    throw new Error(`Unexpected URL ${url}`);
  } });
  const receipt = { handoffs: [{ taskId: childId, completed: true }] };
  const app = resolvePlatform('web', {});
  const result = await withApp(app, () => stopTurn(client, conversationId, { runId, timeoutMs: 1000, receipt }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopped, true);
  assert.equal(receipt.cancellation.confirmed, true);
  const later = await withApp(app, () => readTurn(client, conversationId, { runId, receipt }));
  assert.equal(later.result.status, 'cancelled');
  assert.equal(later.result.reply, null);
});

test('desktop accepted cancellation keeps its existing completed-to-cancelled mapping', async () => {
  const completed = { ...assistant, content_block: [text('done')], content_status: undefined, ext: { is_finish: '1' } };
  const result = await withApp(resolveApp('work', {}), () => summarizeTurn(conversationId, root, [completed], [], {
    cancellation: { accepted: true },
  }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reply, null);
});

test('Web wait never replays a stored request body through desktop protocol recovery', async () => {
  const client = makeWebClient({ handler: async url => {
    if (!url.includes('/conversation/batch_get')) throw new Error(`Unexpected write ${url}`);
    return Response.json({ downlink_body: { batch_get_conv_info_downlink_body: {
      conversation_info_list: [{ conversation_id: conversationId, messages: [root] }],
    } } });
  } });
  const app = resolvePlatform('web', {});
  await withApp(app, () => assert.rejects(waitTurn(client, conversationId, {
    runId, timeoutMs: 10, receipt: { requestBody: { messages: [{ content_block: [text('must never resend')] }] } },
  }), error => error.code === 'timeout'));
  assert.ok(client.urls.every(url => url.includes('/conversation/batch_get')));
  assert.ok(client.expressions.every(expression => !expression.includes('/chat/completion')));
});

test('Web waits through an empty final marker until answer text is persisted, without resending', async () => {
  const emptyFinal = { ...assistant, content_block: [], content_status: undefined, ext: { is_finish: '1' } };
  const final = { ...emptyFinal, content_block: [text('WEB_WORK_OK_20261007')] };
  let reads = 0;
  const client = makeWebClient({ handler: async url => {
    if (!url.includes('/conversation/batch_get')) throw new Error(`Unexpected write ${url}`);
    reads++;
    const messages = reads === 1 ? [root, emptyFinal] : [root, final];
    return Response.json({ downlink_body: { batch_get_conv_info_downlink_body: {
      conversation_info_list: [{ conversation_id: conversationId, messages }],
    } } });
  } });
  const result = await withApp(resolvePlatform('web', {}), () => waitTurn(client, conversationId, {
    runId, timeoutMs: 2000, receipt: { requestBody: { messages: [{ content_block: [text('must not resend')] }] } },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.reply.text, 'WEB_WORK_OK_20261007');
  assert.equal(reads, 2);
  assert.ok(client.urls.every(url => url.includes('/conversation/batch_get')));
});

test('desktop readTurn keeps its existing empty-final response behavior', async () => {
  const emptyFinal = { ...assistant, content_block: [], content_status: undefined, ext: { is_finish: '1' } };
  const client = makeDesktopClient(async url => {
    assert.ok(url.includes('/conversation/batch_get'));
    return Response.json({ downlink_body: { batch_get_conv_info_downlink_body: {
      conversation_info_list: [{ conversation_id: conversationId, messages: [root, emptyFinal] }],
    } } });
  });
  const snapshot = await withApp(resolveApp('work', {}), () => readTurn(client, conversationId, { runId }));
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.result.reply.text, '');
  assert.equal(snapshot.result.completionPending, undefined);
});
