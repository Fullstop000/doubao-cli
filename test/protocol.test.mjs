import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationExt, modelProtocol, reduceStreamEvent } from '../src/protocol.mjs';

function streamState(waitForReply = true) {
  return {
    state: { conversationId: '', answer: '', thinking: '', completed: false, failed: null },
    options: { waitForReply },
  };
}

test('takes the conversation id from SSE_ACK and stops when not waiting', () => {
  const { state, options } = streamState(false);
  const signal = reduceStreamEvent(state, 'SSE_ACK', { ack_client_meta: { conversation_id: '123' } }, options);

  assert.equal(state.conversationId, '123');
  assert.equal(signal, 'stop');
});

test('keeps listening after SSE_ACK when waiting for the reply', () => {
  const { state, options } = streamState(true);
  const signal = reduceStreamEvent(state, 'SSE_ACK', { ack_client_meta: { conversation_id: '123' } }, options);

  assert.equal(state.conversationId, '123');
  assert.equal(signal, null);
  assert.equal(state.completed, false);
});

test('accumulates answer and thinking blocks from STREAM_CHUNK', () => {
  const { state, options } = streamState();
  const chunk = {
    patch_op: [{
      patch_value: {
        content_block: [
          { block_type: 10000, content: { text_block: { text: '你好' } } },
          { block_type: 10040, content: { thinking_block: { content: '思考一下' } } },
          { block_type: 10001, content: {} },
        ],
      },
    }],
  };

  assert.equal(reduceStreamEvent(state, 'STREAM_CHUNK', chunk, options), null);
  assert.equal(reduceStreamEvent(state, 'STREAM_CHUNK', chunk, options), null);
  assert.equal(state.answer, '你好你好');
  assert.equal(state.thinking, '思考一下思考一下');
  assert.equal(state.completed, false);
});

test('SSE_REPLY_END end_type 1 updates message text without completing the reply', () => {
  const { state, options } = streamState();
  state.answer = 'partial';

  const signal = reduceStreamEvent(state, 'SSE_REPLY_END', {
    end_type: 1,
    msg_finish_attr: { brief: '最终回复' },
  }, options);

  assert.equal(signal, null);
  assert.equal(state.answer, '最终回复');
  assert.equal(state.completed, false);
});

test('SSE_REPLY_END end_type 3 completes and stops the stream', () => {
  const { state, options } = streamState();

  const signal = reduceStreamEvent(state, 'SSE_REPLY_END', { end_type: 3 }, options);

  assert.equal(signal, 'stop');
  assert.equal(state.completed, true);
});

test('STREAM_ERROR marks the stream as failed and stops', () => {
  const { state, options } = streamState();

  const signal = reduceStreamEvent(state, 'STREAM_ERROR', { error_code: 42, error_msg: 'boom' }, options);

  assert.equal(signal, 'stop');
  assert.deepEqual(state.failed, { error: 42, detail: 'boom' });
  assert.equal(state.completed, false);
});

test('unknown events leave the stream incomplete', () => {
  const { state, options } = streamState();

  assert.equal(reduceStreamEvent(state, 'SSE_HEARTBEAT', {}, options), null);
  assert.equal(state.completed, false);
  assert.equal(state.failed, null);
});

test('conversationExt defaults to the app skill paths', () => {
  const ext = conversationExt(modelProtocol('auto'), '%LOCAL_MESSAGE_ID%', '/tmp/ws');
  const gtp = JSON.parse(ext.general_task_param);

  assert.deepEqual(gtp.client_option.shared_folder_path.slice(0, 1), ['/tmp/ws']);
  assert.equal(gtp.agent_task_param.workspace, '/tmp/ws');
  assert.ok(gtp.client_option.agent_workspace.local_skill_paths.length > 0);
});

test('conversationExt honors empty skill paths for isolation', () => {
  const ext = conversationExt(modelProtocol('auto'), '%LOCAL_MESSAGE_ID%', '/tmp/ws', { skillPaths: [] });
  const gtp = JSON.parse(ext.general_task_param);

  assert.deepEqual(gtp.client_option.agent_workspace.local_skill_paths, []);
});
