import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { removeConnector } from '../src/mcp.mjs';

function clientFor({ disconnectDeletes = false, listFails = false, disableFails = false, lingering = false, paginated = false } = {}) {
  let enabled = true;
  let exists = true;
  let disableCalls = 0;
  const api = {
    async AGWManageDisconnectConnector() { if (disconnectDeletes) exists = false; },
    async AGWManageSetConnectorEnabled() {
      disableCalls++;
      if (disableFails) throw new Error('disable rejected');
      enabled = false;
    },
    async AGWManageListUserConnectors() {
      if (listFails) throw new Error('list unavailable');
      return { code: 0, data: { items: exists ? [{ connector_id: '123456', enabled }] : [], has_more: paginated } };
    },
  };
  const context = vm.createContext({
    crypto,
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout,
    document: { querySelector: () => ({}) },
    Date: class extends Date { static now() { return Date.now() + (lingering ? (this.n = (this.n || 0) + 10001) : 0); } },
    window: {
      '@flow-web/desktop:stable': { push: ([,, ready]) => {
        let loaded = false;
        const requireModule = () => { assert.equal(loaded, true, 'must load the chunk before requiring it'); return { Sf: api }; };
        requireModule.e = async () => { loaded = true; };
        ready(requireModule);
      } },
      neotix: {
        taskMode: { runtime: { triggerUpdate: async () => {} } },
        mcp: { getAllTools: async () => ({ connectors: lingering ? [{ connectorId: '123456' }] : [] }) },
      },
    },
  });
  return { evaluate: expression => vm.runInContext(expression, context), close() {}, disableCalls: () => disableCalls };
}

test('disconnect that deletes the connector succeeds without a second disable', async () => {
  const client = clientFor({ disconnectDeletes: true });
  const result = await removeConnector(client, '123456');
  assert.equal(result.removed, true);
  assert.equal(result.state, 'absent');
  assert.equal(client.disableCalls(), 0);
});

test('removal requires both account state and local tool release', async () => {
  const client = clientFor();
  const result = await removeConnector(client, '123456');
  assert.equal(result.removed, true);
  assert.equal(result.state, 'disabled');
  assert.equal(client.disableCalls(), 1);
  for (const options of [{ listFails: true }, { disableFails: true }, { lingering: true }, { disconnectDeletes: true, paginated: true }]) {
    assert.equal((await removeConnector(clientFor(options), '123456')).removed, false);
  }
});
