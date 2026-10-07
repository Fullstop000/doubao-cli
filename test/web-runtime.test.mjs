import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { runtimeParameters } from '../src/protocol.mjs';
import { imRequest } from '../src/turns.mjs';

const app = { ...resolvePlatform('web', {}), accountId: 'account-A' };
const resource = { name: 'https://www.doubao.com/im/conversation/batch_get?aid=497858&web_id=observed-account-A&msToken=secret' };

function hydrationClient({ resourcesAfter = 2, onWait = () => {} } = {}) {
  const state = { clock: 1000, uid: 'account-A', origin: 'https://www.doubao.com', pathname: '/chat/', reads: 0, waits: [], requests: [], requestTimers: [] };
  let hydrating = false;
  const context = vm.createContext({ URL, crypto, AbortSignal, AbortController, clearTimeout,
    Date: { now: () => state.clock }, location: state,
    localStorage: { getItem: () => state.uid },
    performance: { getEntriesByType() {
      state.reads++;
      return state.reads > resourcesAfter ? [resource] : [];
    } },
    setTimeout(callback, ms) {
      if (!hydrating) { state.requestTimers.push(ms); return setTimeout(callback, ms); }
      state.waits.push(ms);
      state.clock += ms;
      onWait(state);
      queueMicrotask(callback);
    },
    fetch: async (url, options) => {
      state.requests.push({ url, options });
      return Response.json({ downlink_body: { fixture: true } });
    },
  });
  return { state, evaluate: expression => {
    hydrating = expression.includes('const keys =');
    return vm.runInContext(expression, context);
  }, close() {} };
}

test('Web native parameter hydration waits briefly for an observed resource without fetching or inventing parameters', async () => {
  const client = hydrationClient();
  const runtime = await withApp(app, () => runtimeParameters(client, { timeoutMs: 1000 }));
  assert.equal(runtime.params.web_id, 'observed-account-A');
  assert.equal(runtime.accountId, 'account-A');
  assert.doesNotMatch(runtime.query, /msToken/u);
  assert.equal(client.state.reads, 3);
  assert.equal(client.state.waits.reduce((sum, ms) => sum + ms, 0), 200);
  assert.equal(client.state.requests.length, 0);
});

test('Web parameter hydration stops immediately when account or origin changes while resources are absent', async () => {
  for (const patch of [{ uid: 'account-B' }, { origin: 'https://example.com' }]) {
    const client = hydrationClient({ resourcesAfter: Infinity, onWait: state => Object.assign(state, patch) });
    await withApp(app, () => assert.rejects(runtimeParameters(client, { timeoutMs: 1000 }), /account changed|outside the chat origin/u));
    assert.equal(client.state.reads, 1, 'identity drift must be checked before another parameter lookup');
    assert.equal(client.state.waits.length, 1);
    assert.equal(client.state.requests.length, 0);
  }
});

test('Web parameter hydration fails at its deadline even if a late timer reveals a valid native resource', async () => {
  const client = hydrationClient({ resourcesAfter: 1, onWait: state => { state.clock += 1000; } });
  await withApp(app, () => assert.rejects(runtimeParameters(client, { timeoutMs: 250 }), /not ready before the deadline/u));
  assert.equal(client.state.reads, 1);
  assert.equal(client.state.waits.length, 1);
  assert.equal(client.state.requests.length, 0);
});

test('Web IM uses the remaining request timeout after native parameter hydration', async t => {
  const client = hydrationClient();
  t.mock.method(Date, 'now', () => client.state.clock);
  const result = await withApp(app, () => imRequest(client, 'conversation/batch_get', 1111,
    'batch_get_conv_info_uplink_body', { conversation_id: ['38442602625749250'] }, 500));
  assert.equal(result.fixture, true);
  assert.equal(client.state.clock, 1200);
  assert.equal(client.state.requestTimers.length, 1);
  assert.ok(client.state.requestTimers[0] > 0 && client.state.requestTimers[0] <= 300,
    'parameter hydration and the CDP return allowance must consume the existing timeout instead of resetting it');
  assert.equal(client.state.requests.length, 1);
});
