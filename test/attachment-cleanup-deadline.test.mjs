import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { clearUploadedAttachments, removeAttachmentsByUploadKey } from '../src/attachments.mjs';

const record = { fileKey: 'owned', localKey: 'local', index: 0, params: { chatId: 'accepted', skillType: 'default' } };

test('discovery and durable readback consume one cleanup deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let present = true, reads = 0;
  await assert.rejects(removeAttachmentsByUploadKey({
    list: () => {
      if (++reads === 1) t.mock.timers.setTime(1090);
      return present ? [record] : [];
    },
    remove: () => { present = false; },
    readDurable: () => { t.mock.timers.setTime(1101); return []; },
  }, ['owned'], { timeoutMs: 100, intervalMs: 1 }), /cleanup timed out/);
  assert.equal(present, false);
});

for (const operation of ['list', 'remove', 'readDurable']) {
  test(`bounds a hung native ${operation}`, async () => {
    let present = true;
    const callbacks = {
      list: () => present ? [record] : [],
      remove: () => { present = false; },
      readDurable: () => [],
    };
    callbacks[operation] = () => new Promise(() => {});
    const start = Date.now();
    await assert.rejects(removeAttachmentsByUploadKey(callbacks, ['owned'], { timeoutMs: 20 }), /cleanup timed out/);
    assert.ok(Date.now() - start < 1000);
  });
}

test('a late discovery cannot trigger deletion after cleanup has timed out', async () => {
  let release;
  let removed = 0;
  await assert.rejects(removeAttachmentsByUploadKey({
    list: () => new Promise(resolve => { release = resolve; }),
    remove: () => { removed++; },
    readDurable: () => [],
  }, ['owned'], { timeoutMs: 10 }), /cleanup timed out/);
  release([record]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(removed, 0);
});

test('does not start cleanup evaluation when the command deadline is exhausted', async () => {
  await assert.rejects(clearUploadedAttachments({
    evaluate: () => assert.fail('must not touch the renderer after expiry'),
  }, {}, 'accepted', { deadline: Date.now() - 1 }), /operation deadline expired/);
});

test('caps cleanup polling sleeps at the remaining budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const timers = t.mock.method(globalThis, 'setTimeout');
  const cleanup = removeAttachmentsByUploadKey({
    list: () => { t.mock.timers.setTime(1007); return []; },
    remove: () => assert.fail('no owned records'), readDurable: () => [],
  }, ['owned'], { timeoutMs: 20, intervalMs: 10_000 });
  const rejected = assert.rejects(cleanup, /Could not identify/);
  // Let discovery settle so the only live timer is the polling sleep.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.mock.calls.map(call => call.arguments[1]), [20, 13]);
  t.mock.timers.tick(13);
  await rejected;
});

test('bounds a hung cleanup evaluation with the remaining command budget', async () => {
  let closed = 0;
  const start = Date.now();
  await assert.rejects(clearUploadedAttachments({
    evaluate: () => new Promise(() => {}), close: () => { closed++; },
  }, { params: { chatId: 'origin' }, fileKeys: ['owned'] }, 'accepted', { deadline: Date.now() + 20 }), { code: 'timeout' });
  assert.equal(closed, 1);
  assert.ok(Date.now() - start < 1000);
});

test('send and create preserve accepted results and primary errors when cleanup has no budget', () => {
  const root = new URL('../src/', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    let now = 1000;
    Date.now = () => now;
    let fail = false, waitForReply = false, cleanupCalls = 0;
    const primary = Object.assign(new Error('original send failure'), { result: { conversationId: 'accepted', runId: 'run' } });
    mock.module(${JSON.stringify(root + 'cdp.mjs')}, { namedExports: {
      withChatClient: callback => callback({ evaluate: async () => true }),
    } });
    mock.module(${JSON.stringify(root + 'attachments.mjs')}, { namedExports: {
      uploadAttachmentsFromClient: async () => [{ name: 'owned.txt', size: 1, type: 'text/plain' }],
      uploadedAttachmentBlocks: async () => ({ blocks: [], params: {}, fileKeys: ['owned'] }),
      clearUploadedAttachments: async (_client, _snapshot, id, options) => {
        cleanupCalls++;
        assert.equal(id, 'accepted');
        assert.equal(options.deadline, 1100);
        assert.equal(now, 1101);
        throw new Error('cleanup deadline expired');
      },
    } });
    mock.module(${JSON.stringify(root + 'models.mjs')}, { namedExports: {
      resolveModelFromClient: () => {}, resolveReasoningEffort: () => {}, selectModelFromClient: () => {}, setReasoningForConversation: () => {},
    } });
    mock.module(${JSON.stringify(root + 'context.mjs')}, { namedExports: {
      resolveTaskContext: async () => ({ taskContext: { runtime: 'remote' } }),
      publicTaskContext: value => value, validateTaskOptions: () => {},
    } });
    mock.module(${JSON.stringify(root + 'turns.mjs')}, { namedExports: {
      refreshTurn: () => {}, readTurn: () => {}, stopTurn: () => {},
      waitTurn: async () => {
        if (fail) throw primary;
        return { conversationId: 'accepted', runId: 'run' };
      },
      receiptStore: async () => ({ save: () => {} }),
    } });
    mock.module(${JSON.stringify(root + 'protocol.mjs')}, { namedExports: {
      AUTOMATIC_MODEL_PROTOCOL: {}, switchConversationModel: () => {},
      sendChatCompletion: async () => {
        now = 1101;
        if (fail && !waitForReply) throw primary;
        return { conversationId: 'accepted', runId: 'run' };
      },
    } });
    // MCP is not used in these attachment flows.
    mock.module(${JSON.stringify(root + 'mcp.mjs')}, { namedExports: { sendWithConnectors: () => {}, prepareToolSandbox: () => {} } });
    const { sendMessage, createConversation } = await import(${JSON.stringify(root + 'automation.mjs')});
    for (const action of [options => sendMessage('accepted', 'hello', options), options => createConversation('hello', options)]) {
      for (waitForReply of [false, true]) {
        for (fail of [false, true]) {
          now = 1000;
          delete primary.attachmentCleanupWarning;
          if (fail) {
            await assert.rejects(action({ attachments: ['owned.txt'], timeoutMs: 100, waitForReply }), error => {
              assert.equal(error, primary);
              assert.equal(error.attachmentCleanupWarning, 'cleanup deadline expired');
              assert.equal(error.result.runId, 'run');
              return true;
            });
          } else {
            const value = await action({ attachments: ['owned.txt'], timeoutMs: 100, waitForReply });
            assert.equal(value.conversationId, 'accepted');
            assert.equal(value.runId, 'run');
            assert.equal(value.attachmentCleanupWarning, 'cleanup deadline expired');
            assert.equal(value.attachments[0].name, 'owned.txt');
          }
        }
      }
    }
    assert.equal(cleanupCalls, 8);
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
