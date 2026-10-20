import assert from 'node:assert/strict';
import test from 'node:test';
import { waitWithLocalRuntime } from '../src/headless-turn.mjs';

test('returns a completed turn without waiting for tool-channel headers', async () => {
  const controller = new AbortController();
  let aborted = false;
  const result = await waitWithLocalRuntime(async () => ({ status: 'completed', reply: 'OK' }),
    () => new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('No tools needed', 'AbortError'));
    }, { once: true })), { abortStartup: () => controller.abort() });
  assert.deepEqual(result, { status: 'completed', reply: 'OK' });
  assert.equal(aborted, true);
});

test('keeps a ready runtime alive until the server turn completes and then closes it', async () => {
  let finishTurn, runtimeReady;
  let closed = 0;
  const ready = new Promise(resolve => { runtimeReady = resolve; });
  const result = waitWithLocalRuntime(() => new Promise(resolve => { finishTurn = resolve; }),
    async () => { runtimeReady(); return { close: async () => { closed++; } }; });
  await ready;
  assert.equal(closed, 0);
  finishTurn({ status: 'completed' });
  assert.deepEqual(await result, { status: 'completed' });
  assert.equal(closed, 1);
});

test('reports startup failure and aborts outstanding startup on a turn failure', async () => {
  const failure = new Error('local channel failed');
  let waiterAborted = false;
  await assert.rejects(waitWithLocalRuntime(signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { waiterAborted = true; reject(signal.reason); }, { once: true });
  }), async () => { throw failure; }), error => error === failure);
  assert.equal(waiterAborted, true);
  const controller = new AbortController();
  await assert.rejects(waitWithLocalRuntime(async () => { throw failure; }, () => new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }), { abortStartup: () => controller.abort() }), error => error === failure);
});
