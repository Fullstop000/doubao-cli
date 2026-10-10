import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { main, parseOptions } from '../src/cli.mjs';
import { completionBody, executeHeadless, streamCompletion, validateHeadlessOptions } from '../src/headless.mjs';
import { messageText } from '../src/turns.mjs';

const conversationId = '38439138239851266';
const runId = '38439138239851267';
const accountId = '123456789012345678';
const headlessApp = resolvePlatform('headless');

function sseResponse(events, status = 200) {
  const text = events.map(({ event, data, id }) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

function ack(conv = conversationId, run = runId) {
  return { event: 'SSE_ACK', data: { ack_client_meta: { conversation_id: conv }, query_list: [{ question_id: run }] } };
}

function isolatedConfig(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-headless-test-'));
  const previous = Object.fromEntries(['DOUBAO_CLI_CONFIG_DIR', 'DOUBAO_CLI_DISABLE_AUTO_UPDATE', 'DOUBAO_HEADLESS_COOKIE']
    .map(name => [name, process.env[name]]));
  process.env.DOUBAO_CLI_CONFIG_DIR = directory;
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  delete process.env.DOUBAO_HEADLESS_COOKIE;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('headless creates the cloud Work body without desktop runtime or local-app fields', () => {
  const body = completionBody({ mode: 'work', message: 'hello', model: { id: 'model-x', provider: 'provider-x', needDeepThink: 5 }, localMessageId: 'local-1' });
  assert.equal(body.option.agent_mode, 1);
  assert.equal(body.option.general_task_param.runtime_type, 1);
  assert.equal(body.option.general_task_param.agent_task_param.runtime_type, 1);
  assert.equal(body.option.conversation_init_ext.mode_id, '3');
  assert.equal(body.option.conversation_init_ext.model_item_key, 'model-x');
  assert.equal(body.option.model_config.model_item_key, 'model-x');
  assert.equal(body.option.aggregate_params.provider_id, 'provider-x');
  assert.equal(body.option.need_deep_think, 5);
  assert.equal(body.option.recovery_option.is_recovery, false);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /desktop|local_app|runtime_type.?[": ]+2|app_path|workspace_path/iu);

  const chat = completionBody({ mode: 'chat', conversationId, message: 'continue' });
  assert.equal(chat.option.agent_mode, 2);
  assert.equal(chat.client_meta.conversation_id, conversationId);
  assert.equal(chat.option.need_create_conversation, false);
  assert.equal(chat.option.conversation_init_ext, undefined);
});

test('turn text accepts legacy JSON content when structured blocks are empty', () => {
  assert.equal(messageText({ content_block: [], content: JSON.stringify({ text: 'legacy server reply' }) }), 'legacy server reply');
});

test('final reply omits thinking descendants while preserving visible answer blocks', () => {
  assert.equal(messageText({ content_block: [
    { block_id: 'answer', content: { text_block: { text: '{"ok":true}' } } },
    { block_id: 'thinking-text', parent_id: 'thinking', content: { text_block: { text: 'private reasoning' } } },
    { block_id: 'thinking', content: { thinking_block: { finish_title: 'Reasoning' } } },
  ] }), '{"ok":true}');
});

test('stream completion accepts only a matching ACK and records the acknowledged IDs', async () => {
  const body = completionBody({ message: 'hello' });
  const client = { async request(route, options) {
    assert.equal(route, '/chat/completion');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).option.general_task_param.runtime_type, 1);
    return sseResponse([ack(), { event: 'STREAM_CHUNK', data: { patch_op: [] } },
      { event: 'SSE_REPLY_END', data: { end_type: 3 } }]);
  } };
  const result = await withApp(headlessApp, () => streamCompletion(client, body, { timeoutMs: 1000, waitForReply: true }));
  assert.equal(result.accepted, true);
  assert.equal(result.conversationId, conversationId);
  assert.equal(result.runId, runId);
  assert.equal(result.completed, true);

  const interrupted = { async request() { return sseResponse([ack()]); } };
  const acceptedButOpen = await withApp(headlessApp, () => streamCompletion(interrupted,
    completionBody({ message: 'hello' }), { timeoutMs: 1000 }));
  assert.equal(acceptedButOpen.accepted, true);
  assert.equal(acceptedButOpen.completed, false);
});

test('mismatched ACK and stream failure preserve safe, explicit acceptance state', async () => {
  const body = completionBody({ conversationId, message: 'hello' });
  const mismatch = { async request() { return sseResponse([ack('38439138239851268', runId)]); } };
  await assert.rejects(withApp(headlessApp, () => streamCompletion(mismatch, body, { timeoutMs: 1000, runId })), error => {
    assert.match(error.message, /mismatched acceptance receipt/u);
    assert.equal(error.result.accepted, false);
    assert.equal(error.result.requestDispatched, true);
    assert.equal(error.result.status, 'unknown');
    return true;
  });
  const wrongRun = { async request() { return sseResponse([ack(conversationId, '38439138239851268')]); } };
  await assert.rejects(withApp(headlessApp, () => streamCompletion(wrongRun, body, { timeoutMs: 1000, runId })), error => {
    assert.match(error.message, /mismatched acceptance receipt/u);
    assert.equal(error.result.accepted, false);
    return true;
  });
  const wrongLocal = { async request() { const event = ack(); event.data.query_list[0].local_message_id = 'different-send'; return sseResponse([event]); } };
  await assert.rejects(withApp(headlessApp, () => streamCompletion(wrongLocal, body, { timeoutMs: 1000 })), /mismatched acceptance receipt/u);

  const secret = 'cookie-never-print-this';
  const failed = { async request() { return sseResponse([{ event: 'STREAM_ERROR', data: { error_msg: secret, error_code: 500 } }]); } };
  await assert.rejects(withApp(headlessApp, () => streamCompletion(failed, body, { timeoutMs: 1000 })), error => {
    assert.equal(error.code, 'stream_error');
    assert.equal(error.result.accepted, false);
    assert.equal(error.result.status, 'failed');
    assert.doesNotMatch(error.message, /cookie-never-print-this/u);
    assert.doesNotMatch(JSON.stringify(error.result), /cookie-never-print-this/u);
    return true;
  });

  const noAck = { async request() { return sseResponse([{ event: 'SOME_EVENT', data: {} }]); } };
  await assert.rejects(withApp(headlessApp, () => streamCompletion(noAck, body, { timeoutMs: 1000 })), error => {
    assert.match(error.message, /without a verified acceptance receipt/u);
    assert.equal(error.result.accepted, false);
    assert.equal(error.result.status, 'unknown');
    assert.match(error.result.recovery, /Acceptance is unknown/u);
    return true;
  });
});

test('headless option validation rejects desktop-only options before any request', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return new Response('{}'); });
  const options = { ...parseOptions(['headless', 'status']), targetId: 'cdp-target' };
  assert.throws(() => validateHeadlessOptions(options), /--target is not supported/u);
  await assert.rejects(main(['headless', 'status', '--target', 'cdp-target']), /--target is not supported/u);
  assert.deepEqual(calls, []);
});

test('wait recovery replays the same task request with only is_recovery enabled', async t => {
  isolatedConfig(t);
  process.env.DOUBAO_HEADLESS_COOKIE = 'sessionid=test-session';
  const requests = [];
  let completionCount = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/passport/account/info/v2/') {
      return Response.json({ data: { user_id_str: accountId } });
    }
    if (url.pathname === '/chat/completion') {
      const body = JSON.parse(init.body);
      requests.push(body);
      completionCount += 1;
      if (completionCount === 1) return sseResponse([ack()]);
      return sseResponse([ack(), { event: 'STREAM_ERROR', data: { error_code: 'recovery_fixture' } }]);
    }
    if (url.pathname === '/im/conversation/batch_get') {
      return Response.json({ status_code: 0, downlink_body: {
        batch_get_conv_info_downlink_body: { conversation_info_list: [] },
      } });
    }
    assert.fail(`unexpected headless request route ${url.pathname}`);
  });

  const options = parseOptions(['headless', 'sessions', 'create', '--mode', 'work', '--wait', '--timeout', '3', 'exact original request']);
  await assert.rejects(withApp(headlessApp, () => executeHeadless(options)), error => {
    assert.equal(error.code, 'task_unavailable');
    return true;
  });
  assert.equal(requests.length, 2);
  const initial = structuredClone(requests[0]);
  const recovered = structuredClone(requests[1]);
  initial.option.recovery_option.is_recovery = true;
  assert.deepEqual(recovered, initial);
  assert.equal(requests[0].option.recovery_option.is_recovery, false);
  assert.equal(requests[1].option.recovery_option.is_recovery, true);
  for (const body of requests) {
    assert.equal(body.messages[0].content_block[0].content.text_block.text, 'exact original request');
    assert.equal(body.option.general_task_param.runtime_type, 1);
  }
});
