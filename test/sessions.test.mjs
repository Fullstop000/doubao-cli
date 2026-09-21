import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { sessionsFromSnapshots, stopGeneration } from '../src/sessions.mjs';
import { resolveApp, withApp } from '../src/app.mjs';

test('merges account-scoped snapshots without leaking other signed-in accounts', () => {
  const first = { conversation_id: '38443439495332098', name: 'latest' };
  const second = { conversation_id: '38443439495332099', name: 'project' };
  const rows = [
    { uid: 'other', schema: 'conversation-list-data-overall-v2', data: { conversations: [{ conversation_id: '38443439495332100', name: 'private' }] } },
    { uid: 'me', schema: 'conversation-list-data-non-project-v2', data: { conversations: [{ ...first, name: 'stale' }] } },
    { uid: 'me', schema: 'conversation-list-data-overall-v2', data: { conversations: [first] } },
    { uid: 'me', schema: 'conversation-list-data-project-v3', data: { projects: [{ conversations: [second, first] }] } },
    { uid: 'me', schema: 'conversation-list-data-device-group-v1', data: { devices: [{ conversations: [{ conversation_id: 'draft', name: 'draft' }] }] } },
  ];
  assert.deepEqual(sessionsFromSnapshots(rows, 'me'), [
    { id: first.conversation_id, title: 'latest' }, { id: second.conversation_id, title: 'project' },
  ]);
  assert.deepEqual(sessionsFromSnapshots(rows, 'missing'), []);
});

test('stop uses the latest server turn and confirms interruption even with a stale page', async () => {
  const id = '38443439495332098', replyId = '56219458376401922';
  let stopped = false;
  const requests = [];
  const context = vm.createContext({
    URL, crypto, AbortSignal, setTimeout,
    performance: { getEntriesByType: () => [{ name: 'https://www.doubao.com/im/chain/recent_conv?aid=1044603&device_id=test' }] },
    window: { neotix: { taskMode: { runtime: { queryRuntimeInfo: async () => ({ env: {} }) } } } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (url.includes('/message/break_stream_msg')) {
        assert.equal(body.uplink_body.break_stream_msg_uplink_body.reply_msg_id, replyId);
        stopped = true;
        return Response.json({ status_code: 0 });
      }
      return Response.json({ downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{
        conversation_id: id, conversation_type: 3,
        messages: [{ message_id: '56219458376401923', index_in_conv: '9007199254740994', user_type: 2,
          ext: { chat_id: replyId, ...(stopped ? { is_finish: '1', is_interrupted: 'true' } : {}) } }],
      }] } } });
    },
  });
  const client = { evaluate: expression => vm.runInContext(expression, context), close() {} };
  await withApp(resolveApp('work', {}), async () => {
    const result = await stopGeneration(client, id, 1000);
    assert.equal(result.stopped, true);
    assert.equal(result.interrupted, true);
    const count = requests.filter(x => x.cmd === 2240).length;
    assert.equal(count, 1);
    assert.equal((await stopGeneration(client, id, 1000)).stopped, true);
    assert.equal(requests.filter(x => x.cmd === 2240).length, count, 'idle stop must not send another break');
  });
});
