import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { resolveModelFromClient } from '../src/models.mjs';

// The current native submit pipeline carries the entire catalog
// model_extra_params object, not just its provider_id.
function catalogClient(config) {
  let open = false;
  const trigger = {
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    getAttribute: name => name === 'aria-controls' ? 'model-menu' : open ? 'open' : 'closed',
  };
  const item = {
    __reactFiberTest: { memoizedProps: { item: config } },
    querySelector: selector => selector.startsWith('span') ? { innerText: config.name } : null,
  };
  const menu = { getAttribute: () => open ? 'open' : 'closed', querySelectorAll: () => [item] };
  const context = vm.createContext({ document: {
    querySelectorAll: () => [trigger], getElementById: () => menu,
  } });
  return {
    evaluate: expression => vm.runInContext(expression, context),
    click: async () => { open = true; },
    pressEscape: async () => { open = false; },
  };
}

test('live model resolution preserves custom catalog metadata in object and serialized forms', async () => {
  const extra = { model_type: 'custom', provider_id: 'fixture-provider', memory_profile: '1000k_80',
    total_window_size: '1000000', disable_cot_summary: 'false' };
  for (const encoded of [extra, JSON.stringify(extra)]) {
    const resolved = await resolveModelFromClient(catalogClient({ name: 'Fixture custom model',
      model_item_key: 'fixture-custom', item_id: 10001, model_extra_params: encoded }), 'Fixture custom model');
    assert.deepEqual(JSON.parse(JSON.stringify(resolved.protocol)), {
      key: 'fixture-custom', ndt: 10001, provider: 'fixture-provider', extraParams: extra,
    });
  }
});
