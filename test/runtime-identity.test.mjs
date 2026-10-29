import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import os from 'node:os';
import { runtimeParameters } from '../src/protocol.mjs';
import { prepareToolSandbox } from '../src/mcp.mjs';
import { resolveApp, withApp } from '../src/app.mjs';

const key = 'general-agent:client-env-id';
const identity = '5232f7ce-ab12-4b92-8203-b7dd5642c4da';
const sandboxEnvironmentId = 'sandbox-environment-separate';
function client(storage, onPrepare = () => {}) {
  const req = id => {
    assert.equal(id, 987391);
    return { H: async options => { onPrepare(options); return { sandboxId: 'prepared-sandbox' }; } };
  };
  req.e = async () => {};
  const context = vm.createContext({ URL, crypto, setTimeout, clearTimeout,
    document: { querySelector: () => ({}) },
    performance: { getEntriesByType: () => [{ name: `https://www.doubao.com/im/fixture?aid=${resolveApp('work', {}).aid}&device_id=fixture-device` }] },
    window: { '@flow-web/desktop:stable': { push: ([,,fn]) => fn(req) }, neotix: {
      runtimeStorage: storage,
      taskMode: { runtime: { queryRuntimeInfo: async () => ({ env: { environmentId: sandboxEnvironmentId } }) } },
    } },
  });
  return { evaluate: expression => vm.runInContext(expression, context) };
}

test('Desktop client identity comes from native storage while sandbox preparation retains its environment id', async () => {
  for (const response of [identity, { isOK: true, data: identity }]) {
    let prepared;
    const c = client({ get: async requested => { assert.equal(requested, key); return response; },
      set: async () => assert.fail('an existing client identity must not be rewritten') }, options => { prepared = options; });
    await withApp(resolveApp('work', {}), async () => {
      const runtime = await runtimeParameters(c);
      assert.equal(runtime.clientEnvId, identity);
      assert.notEqual(runtime.clientEnvId, sandboxEnvironmentId);
      await prepareToolSandbox(c, { workspace: os.tmpdir(), permission: 'AskOnRisk' });
      assert.equal(prepared.envId, sandboxEnvironmentId);
    });
  }
});

test('missing native client identity initializes only its dedicated key and requires persisted readback', async () => {
  for (const wrapped of [false, true]) {
    let saved;
    const writes = [];
    const c = client({ get: async requested => { assert.equal(requested, key); return wrapped ? { isOK: true, data: saved } : saved; },
      set: async input => { writes.push(input); saved = input.value; } });
    const runtime = await withApp(resolveApp('work', {}), () => runtimeParameters(c));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, key);
    assert.match(writes[0].value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(runtime.clientEnvId, saved);
  }
});

test('unavailable or malformed storage never invents a sandbox-derived client identity', async () => {
  for (const storage of [undefined, { get: async () => ({ isOK: false, data: identity }) },
    { get: async () => ({ unexpected: identity }) }, { get: async () => { throw new Error('unavailable'); } }]) {
    if (storage) storage.set = async () => assert.fail('unreadable identity must not be overwritten');
    const runtime = await withApp(resolveApp('work', {}), () => runtimeParameters(client(storage)));
    assert.equal(runtime.clientEnvId, '');
  }
});

test('unconfirmed client identity initialization is not returned or retried', async () => {
  let writes = 0;
  const runtime = await withApp(resolveApp('work', {}), () => runtimeParameters(client({
    get: async () => undefined, set: async () => { writes++; },
  })));
  assert.equal(writes, 1);
  assert.equal(runtime.clientEnvId, '');
});


test('renderer identity mismatch cannot initialize another application storage', async () => {
  let reads = 0, writes = 0;
  const c = client({ get: async () => { reads++; }, set: async () => { writes++; } });
  await withApp(resolveApp('doubao', {}), () => assert.rejects(runtimeParameters(c), /identity does not match/u));
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});
