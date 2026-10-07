import test from 'node:test';
import assert from 'node:assert/strict';
import { observeWebSend } from '../src/web-stream.mjs';

class FakeCdp {
  listeners = new Map();
  bufferedData = '';
  async send(method) {
    if (method === 'Network.streamResourceContent') return { bufferedData: this.bufferedData };
    return {};
  }
  subscribe(method, callback) {
    const list = this.listeners.get(method) || new Set();
    list.add(callback);
    this.listeners.set(method, list);
    return () => list.delete(callback);
  }
  emit(method, params) { for (const callback of this.listeners.get(method) || []) callback(params); }
}

function request(requestId = 'native-1', overrides = {}, agentMode = 2) {
  return {
    requestId,
    request: {
      method: 'POST',
      url: 'https://www.doubao.com/chat/completion',
      postData: JSON.stringify({
        client_meta: { conversation_id: '' },
        option: { agent_mode: agentMode },
        messages: [{ local_message_id: 'local-msg-123', content_block: [{ content: { text_block: { text: 'hello   world' } } }] }],
      }),
      ...overrides,
    },
  };
}

function frame(event, data, ending = '\n\n') {
  return `event: ${event}\ndata: ${JSON.stringify(data)}${ending}`;
}
function b64(value) { return Buffer.from(value).toString('base64'); }
function startResponse(client, requestId = 'native-1', body = '', agentMode = 2) {
  client.bufferedData = b64(body);
  client.emit('Network.requestWillBeSent', request(requestId, {}, agentMode));
  client.emit('Network.responseReceived', {
    requestId,
    response: { status: 200, mimeType: 'text/event-stream' },
  });
}

const ack = { ack_client_meta: { conversation_id: '123456789012' }, query_list: [{ question_id: '234567890123' }] };
const end = { end_type: 3 };

test('ignores unrelated traffic and completes only a matching native Web reply', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', waitForReply: true, timeoutMs: 1000 });
  monitor.arm();
  client.emit('Network.requestWillBeSent', request('wrong-text', { postData: '{}' }));
  client.emit('Network.responseReceived', { requestId: 'wrong-text', response: { status: 200, mimeType: 'text/event-stream' } });
  assert.equal(monitor.snapshot().requestDispatched, false);

  const answer = frame('STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
    { block_type: 10000, content: { text_block: { text: 'native reply' } } },
  ] } }] });
  startResponse(client, 'native-1', frame('SSE_ACK', ack) + answer + frame('SSE_REPLY_END', end));
  const result = await monitor.result;
  assert.deepEqual(result, {
    platform: 'web', mode: 'chat', conversationId: '123456789012', runId: '234567890123', localMessageId: 'local-msg-123', status: 'completed',
    accepted: true, requestDispatched: true, reply: { role: 'assistant', text: 'native reply' },
  });
  assert.ok([...client.listeners.values()].every(list => list.size === 0));
});

test('web work returns only native acceptance IDs and leaves completion to task-tree reads', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', mode: 'work', timeoutMs: 1000 });
  monitor.arm();
  startResponse(client, 'native-work', frame('SSE_ACK', ack)
    + frame('STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, content: { text_block: { text: 'partial task message' } } },
    ] } }] }) + frame('SSE_REPLY_END', end), 1);
  const result = await monitor.result;
  assert.deepEqual(result, {
    platform: 'web', mode: 'work', conversationId: '123456789012', runId: '234567890123',
    localMessageId: 'local-msg-123', status: 'running', accepted: true, requestDispatched: true, reply: null,
    handoffs: [], liveMessages: [],
  });
});

test('work observer waits past ACK and captures native handoff plus live controls', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', mode: 'work', timeoutMs: 1000 });
  monitor.arm();
  const control = { block_id: 'approval-1', block_type: 10080,
    content: { interaction_ask_block: { status: 1, questions: [{ title: 'Choose' }] } } };
  startResponse(client, 'native-work', frame('SSE_ACK', ack)
    + frame('STREAM_MSG_NOTIFY', { meta: { message_id: 'assistant-live', thread_id: '0' }, content: { content_block: [control] } })
    + frame('FETCH_STREAM', { fetch_type: 2, fetch_key: 'task-native', append_scene: 7, thread_id: '56333333333333' }), 1);
  const result = await monitor.result;
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'running');
  assert.deepEqual(result.handoffs, [{ taskId: 'task-native', appendScene: 7, threadId: '56333333333333', seq: 0 }]);
  assert.equal(result.liveMessages[0].message_id, 'assistant-live');
  assert.equal(result.liveMessages[0].content_block[0].content.interaction_ask_block.status, 1);
  assert.ok([...client.listeners.values()].every(list => list.size === 0));
});

test('work observer checkpoints ACK before later handoff and control events', async () => {
  const client = new FakeCdp();
  const checkpoints = [];
  const monitor = await observeWebSend(client, { message: 'hello world', mode: 'work', timeoutMs: 1000,
    onReceipt: receipt => checkpoints.push(receipt) });
  monitor.arm();
  client.bufferedData = b64(frame('SSE_ACK', ack));
  client.emit('Network.requestWillBeSent', request('native-work', {}, 1));
  client.emit('Network.responseReceived', { requestId: 'native-work', response: { status: 200, mimeType: 'text/event-stream' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].accepted, true);
  assert.equal(checkpoints[0].conversationId, '123456789012');
  assert.equal(checkpoints[0].runId, '234567890123');
  assert.deepEqual(checkpoints[0].handoffs, []);

  const control = { block_id: 'approval-1', block_type: 10080,
    content: { interaction_ask_block: { status: 1, questions: [{ title: 'Choose' }] } } };
  client.emit('Network.dataReceived', { requestId: 'native-work', data: b64(
    frame('STREAM_MSG_NOTIFY', { meta: { message_id: 'assistant-live', thread_id: '0' }, content: { content_block: [control] } })
      + frame('FETCH_STREAM', { fetch_type: 2, fetch_key: 'task-native', append_scene: 7, thread_id: '56333333333333' })) });
  const result = await monitor.result;
  assert.equal(checkpoints.length, 3);
  assert.equal(checkpoints[1].liveMessages.length, 1);
  assert.equal(checkpoints[2].handoffs[0].taskId, 'task-native');
  assert.equal(result.runId, checkpoints[0].runId);
});

test('work observer preserves accepted IDs when a receipt callback throws', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', mode: 'work', timeoutMs: 1000,
    onReceipt() { throw new Error('receipt storage unavailable'); } });
  monitor.arm();
  startResponse(client, 'native-work', frame('SSE_ACK', ack)
    + frame('FETCH_STREAM', { fetch_type: 2, fetch_key: 'task-native', append_scene: 7, thread_id: '56333333333333' }), 1);
  const result = await monitor.result;
  assert.equal(result.accepted, true);
  assert.equal(result.conversationId, '123456789012');
  assert.equal(result.runId, '234567890123');
  assert.equal(result.handoffs[0].taskId, 'task-native');
});

test('work observer timeout after ACK returns accepted incomplete tracking instead of send failure', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', mode: 'work', timeoutMs: 5 });
  monitor.arm();
  client.bufferedData = b64(frame('SSE_ACK', ack));
  client.emit('Network.requestWillBeSent', request('native-work', {}, 1));
  client.emit('Network.responseReceived', { requestId: 'native-work', response: { status: 200, mimeType: 'text/event-stream' } });
  const result = await monitor.result;
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'running');
  assert.equal(result.taskTrackingIncomplete, true);
  assert.equal(result.conversationId, '123456789012');
  assert.equal(result.runId, '234567890123');
});

test('new native conversation requests may omit client_meta.conversation_id', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', timeoutMs: 1000 });
  monitor.arm();
  const nativeRequest = request();
  const body = JSON.parse(nativeRequest.request.postData);
  delete body.client_meta.conversation_id;
  nativeRequest.request.postData = JSON.stringify(body);
  client.emit('Network.requestWillBeSent', nativeRequest);
  assert.equal(monitor.snapshot().requestDispatched, true);
  client.bufferedData = b64(frame('SSE_ACK', ack));
  client.emit('Network.responseReceived', { requestId: 'native-1', response: { status: 200, mimeType: 'text/event-stream' } });
  const result = await monitor.result;
  assert.equal(result.status, 'running');
  assert.equal(result.conversationId, '123456789012');
});

test('parses buffered plus raced fragmented CRLF events and split UTF-8 safely', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', waitForReply: true, timeoutMs: 1000 });
  monitor.arm();
  const ackBytes = Buffer.from(frame('SSE_ACK', ack, '\r\n\r\n'));
  const chunkBytes = Buffer.from(frame('STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
    { block_type: 10000, content: { text_block: { text: '你好' } } },
  ] } }] }, '\r\n\r\n'));
  const allBytes = Buffer.concat([ackBytes, chunkBytes, Buffer.from(frame('SSE_REPLY_END', end, '\r\n\r\n'))]);
  const cut = ackBytes.length + chunkBytes.indexOf(Buffer.from('好')) + 1;
  client.bufferedData = b64(allBytes.subarray(0, ackBytes.length + 2));
  client.emit('Network.requestWillBeSent', request());
  client.emit('Network.responseReceived', { requestId: 'native-1', response: { status: 200, mimeType: 'text/event-stream' } });
  // Arrives before streamResourceContent's buffered bytes are consumed.
  client.emit('Network.dataReceived', { requestId: 'native-1', data: b64(allBytes.subarray(ackBytes.length + 2, cut)) });
  client.emit('Network.dataReceived', { requestId: 'native-1', data: b64(allBytes.subarray(cut)) });
  const result = await monitor.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.reply.text, '你好');
});

test('keeps a CRLF frame boundary intact when transport splits between CR and LF', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', waitForReply: true, timeoutMs: 1000 });
  monitor.arm();
  const wire = Buffer.from(frame('SSE_ACK', ack, '\r\n\r\n')
    + frame('STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, content: { text_block: { text: 'ok' } } },
    ] } }] }, '\r\n\r\n') + frame('SSE_REPLY_END', end, '\r\n\r\n'));
  const firstBoundary = Buffer.from('\r\n\r\n');
  const ackBoundary = wire.indexOf(firstBoundary) + 1;
  client.bufferedData = b64(wire.subarray(0, ackBoundary));
  client.emit('Network.requestWillBeSent', request());
  client.emit('Network.responseReceived', { requestId: 'native-1', response: { status: 200, mimeType: 'text/event-stream' } });
  client.emit('Network.dataReceived', { requestId: 'native-1', data: b64(wire.subarray(ackBoundary)) });
  const result = await monitor.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.reply.text, 'ok');
});

test('reports stream errors and unsupported task handoffs without success', async () => {
  for (const [event, data, message] of [
    ['STREAM_ERROR', { error_code: 7, error_msg: 'private provider detail' }, 'web response failed'],
    ['FETCH_STREAM', { fetch_type: 2 }, 'web work task handoff is unsupported'],
  ]) {
    const client = new FakeCdp();
    const monitor = await observeWebSend(client, { message: 'hello world', waitForReply: true, timeoutMs: 1000 });
    monitor.arm();
    startResponse(client, 'native-1', frame('SSE_ACK', ack) + frame(event, data));
    await assert.rejects(monitor.result, error => {
      assert.match(error.message, new RegExp(message));
      assert.equal(error.result.status, event === 'STREAM_ERROR' ? 'failed' : 'unknown');
      assert.equal(error.result.accepted, true);
      assert.equal(error.result.reply, null);
      assert.deepEqual(error.result.progress, { conversationId: '123456789012', runId: '234567890123', answerLength: 0 });
      if (event === 'STREAM_ERROR') {
        assert.equal(error.result.errorCode, 7);
        assert.doesNotMatch(JSON.stringify(error.result), /private provider detail/);
      }
      return true;
    });
    assert.ok([...client.listeners.values()].every(list => list.size === 0));
  }
});

test('timeout and reply end without a valid acknowledgement remain unknown', async () => {
  const timed = await observeWebSend(new FakeCdp(), { message: 'hello', timeoutMs: 5 });
  await assert.rejects(timed.result, error => error.result.status === 'unknown' && error.result.requestDispatched === false);

  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', waitForReply: true, timeoutMs: 1000 });
  monitor.arm();
  startResponse(client, 'native-1', frame('SSE_REPLY_END', end));
  await assert.rejects(monitor.result, error => error.result.status === 'unknown' && error.result.reply === null);
});

test('loadingFinished flushes pending data and fails unknown when no completion was observed', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', waitForReply: true, timeoutMs: 1000 });
  monitor.arm();
  client.bufferedData = b64(frame('SSE_ACK', ack) + frame('STREAM_CHUNK', { patch_op: [] }));
  client.emit('Network.requestWillBeSent', request());
  client.emit('Network.responseReceived', { requestId: 'native-1', response: { status: 200, mimeType: 'text/event-stream' } });
  client.emit('Network.loadingFinished', { requestId: 'native-1' });
  await assert.rejects(monitor.result, error => error.result.accepted && error.result.status === 'unknown');
});

test('unmatched URL and conversation requests are ignored', async () => {
  for (const override of [
    { url: 'https://www.doubao.com/other' },
    { postData: JSON.stringify({ client_meta: { conversation_id: '999999999999' }, option: { agent_mode: 2 }, messages: [{ content_block: [{ content: { text_block: { text: 'hello world' } } }] }] }) },
  ]) {
    const client = new FakeCdp();
    const monitor = await observeWebSend(client, { message: 'hello world', timeoutMs: 5 });
    monitor.arm();
    client.emit('Network.requestWillBeSent', request('unmatched', override));
    await assert.rejects(monitor.result, error => error.result.requestDispatched === false);
  }
});

test('a matching request in a non chat mode is rejected before acceptance', async () => {
  const client = new FakeCdp();
  const monitor = await observeWebSend(client, { message: 'hello world', timeoutMs: 1000 });
  monitor.arm();
  const wrongMode = request();
  wrongMode.request.postData = JSON.stringify({ ...JSON.parse(wrongMode.request.postData), option: { agent_mode: 1 } });
  client.emit('Network.requestWillBeSent', wrongMode);
  await assert.rejects(monitor.result, error => error.message === 'unsupported web work task'
    && error.result.accepted === false && error.result.requestDispatched === true);
});

test('work cannot request direct reply completion and chat rejects native work requests', async () => {
  const client = new FakeCdp();
  await assert.rejects(observeWebSend(client, { message: 'hello world', mode: 'work', waitForReply: true }),
    /completion must be verified through the task tree/);
  assert.equal([...client.listeners.values()].length, 0);

  const monitor = await observeWebSend(client, { message: 'hello world', mode: 'chat', timeoutMs: 1000 });
  monitor.arm();
  client.emit('Network.requestWillBeSent', request('work-request', {}, 1));
  await assert.rejects(monitor.result, error => error.message === 'unsupported web work task'
    && error.result.mode === 'chat' && !error.result.accepted);
});
