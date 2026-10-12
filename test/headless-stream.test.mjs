import test from 'node:test';
import assert from 'node:assert/strict';
import { completionBody, streamCompletion } from '../src/headless.mjs';

const conversationId = '38439138239851266', runId = '38439138239851267';
const ack = { ack_client_meta: { conversation_id: conversationId }, query_list: [{ question_id: runId }] };
const response = () => new Response(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });

test('accepted IDs survive a receipt persistence failure without a second dispatch', async () => {
  let requests = 0;
  await assert.rejects(streamCompletion({ request: async () => { requests++; return response(); } },
    completionBody({ message: 'fixture', mode: 'chat' }), {
      timeoutMs: 1000, onReceipt() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    }), error => {
    assert.equal(error.code, 'ENOSPC');
    assert.equal(error.result.accepted, true);
    assert.equal(error.result.conversationId, conversationId);
    assert.equal(error.result.runId, runId);
    assert.match(error.result.recovery, /do not resend/u);
    return true;
  });
  assert.equal(requests, 1);
});

test('native timeout exceptions become recoverable errors without writing readonly code', async () => {
  await assert.rejects(streamCompletion({ request: async () => { throw new DOMException('expired', 'TimeoutError'); } },
    completionBody({ message: 'fixture' }), { timeoutMs: 1 }), error => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.result.accepted, false);
    assert.equal(error.result.requestDispatched, true);
    return true;
  });
});
