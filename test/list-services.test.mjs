import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listDesktopSessionsFromClient, listDesktopSessions } from '../src/sessions.mjs';
import { listHeadlessSessions, listHeadlessProjects } from '../src/headless-services.mjs';
import { listProjects } from '../src/context.mjs';
import { resolveApp, withApp, currentApp } from '../src/app.mjs';

const id = '38443439495332098';
const cell = (n, type = 1) => ({ conversation: { conversation_id: String(BigInt(id) + BigInt(n)), name: `session-${n}`,
  conv_extra: { agent_task_param: { runtime_type: type } } } });
function renderer(respond, { selections = {}, changeBeforeRead = 0 } = {}) {
  let account = '12345678901234', reads = 0;
  const requests = [];
  const req = module => module === 464468 ? { oI: () => ({ get: () => ({ getState: key => ({ selection: { runtimeType: selections[key] ?? 1 } }) }) }) }
    : module === 438244 ? { getInputToolConversationRuntimeEnvironment: key => selections[key] == null ? {} : { runtimeType: selections[key] } }
    : module === 67651 ? { ZP: { RuntimeEnvironment: { Service: 'runtime' } } } : assert.fail(`Unknown module ${module}`);
  const context = vm.createContext({ URL, crypto, setTimeout, clearTimeout, AbortSignal,
    localStorage: { getItem() { if (++reads === changeBeforeRead) account = '99999999999999'; return account; } },
    performance: { getEntriesByType: () => [{ name: `https://www.doubao.com/im/project/list?aid=${currentApp().aid}&device_id=device` }] },
    window: { '@flow-web/desktop:stable': { push: ([,,done]) => done(req) }, neotix: { taskMode: { runtime: {
      queryRuntimeInfo: async () => ({ env: {} }),
    } } } },
    fetch: async (url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      return Response.json(await respond(request, requests.length));
    },
  });
  return { requests, async evaluate(expression) {
    try { return await vm.runInContext(expression, context); }
    catch (error) { throw new Error(error.message); } // CDP serializes exceptions without custom fields.
  }, close() {} };
}

test('Desktop and Headless use the same pinned pagination, runtime mapping and completeness metadata', async () => {
  const pages = [
    { cells: [cell(0, 2)], has_more: true, next_conv_version: '0', extra: { pc_pin_query_type: 1 } },
    { cells: [cell(0), cell(1), cell(2, 99)], has_more: false },
  ];
  const desktop = renderer((_, count) => ({ downlink_body: { pull_recent_conv_chain_downlink_body: pages[count - 1] } }));
  let calls = 0;
  const headless = await listHeadlessSessions({ imRequest: async () => ({ pull_recent_conv_chain_downlink_body: pages[calls++] }) }, { all: true });
  const result = await listDesktopSessionsFromClient(desktop, { all: true });
  assert.deepEqual({ ...result, platform: 'headless' }, headless);
  assert.deepEqual(result.sessions.map(s => s.runtime), ['local', 'cloud', 'unknown']);
  assert.deepEqual(desktop.requests.map(r => [r.uplink_body.pull_recent_conv_chain_uplink_body.conv_version,
    r.uplink_body.pull_recent_conv_chain_uplink_body.option.pc_pin_query_type]), [[0, 0], [0, 1]]);
  assert.equal(result.source, 'api'); assert.equal(result.complete, true); assert.equal(result.pages, 2);
});

test('Desktop overlays explicit selections and ignores the Cloud default for unloaded sessions', async () => {
  const desktop = renderer(() => ({ downlink_body: { pull_recent_conv_chain_downlink_body: {
    cells: [cell(0, 2), cell(1), cell(2, 2)], has_more: false,
  } } }), { selections: { [id]: 1, [String(BigInt(id) + 1n)]: 2 } });
  const result = await listDesktopSessionsFromClient(desktop, { all: true });
  assert.deepEqual(result.sessions.map(s => s.runtime), ['cloud', 'local', 'local']);
});

test('Desktop and Headless project lists return the same normalized folders across pages', async () => {
  const page = cursor => ({ projects: [{ project_id: cursor ? 2 : 1, status: 1, name: 'project',
    folders: [{ folder_name: 'code', workspace: '/code', folder_device_id: 7, is_primary: true }] }],
    has_more: !cursor, next_cursor: 'next' });
  const desktop = renderer(request => ({ downlink_body: { list_projects_downlink_body: page(request.uplink_body.list_projects_uplink_body.cursor) } }));
  const actual = await listProjects(desktop);
  const expected = await listHeadlessProjects({ imRequest: async (_r, _c, _k, body) => ({ list_projects_downlink_body: page(body.cursor) }) });
  assert.deepEqual(actual, expected); assert.equal(actual.length, 2);
});

test('Desktop pins one account across pages and the runtime overlay, with no mixed-account success', async () => {
  for (const changeBeforeRead of [2, 3, 5]) {
    const desktop = renderer((_, count) => ({ downlink_body: { pull_recent_conv_chain_downlink_body: count === 1
      ? { cells: [cell(0)], has_more: true, next_conv_version: '100' }
      : { cells: [cell(1)], has_more: false } } }), { changeBeforeRead });
    await assert.rejects(listDesktopSessionsFromClient(desktop, { all: true }), e => e.code === 'account_changed');
  }
});

test('Desktop retries only the known intermittent read rejection and fails malformed project pages', async () => {
  const desktop = renderer((_, count) => count === 1 ? { status_code: 712010702 } : { downlink_body: {
    pull_recent_conv_chain_downlink_body: { cells: [cell(0)], has_more: false },
  } });
  assert.equal((await listDesktopSessionsFromClient(desktop)).sessions.length, 1);
  assert.equal(desktop.requests.length, 2);
  for (const has_more of [undefined, 'false']) {
    await assert.rejects(listProjects(renderer(() => ({ downlink_body: { list_projects_downlink_body: { projects: [], has_more } } }))),
      e => e.code === 'project_list_invalid');
  }
});

test('a late final Desktop page cannot succeed after the traversal deadline', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const desktop = renderer(() => { now += 1000; return { downlink_body: { pull_recent_conv_chain_downlink_body: { cells: [], has_more: false } } }; });
  await assert.rejects(listDesktopSessionsFromClient(desktop, { all: true, timeoutMs: 1000 }), e => e.code === 'timeout');
});

test('inactive desktop profiles never query the active account; empty caches remain incomplete', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-list-cache-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'Other', 'IndexedDB', 'chrome_doubaowork-chat_0.indexeddb.leveldb'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Default', info_cache: { Default: {}, Other: {} } } }));
  await withApp(resolveApp('work', { DOUBAO_DATA_DIR: dataDir }), async () => {
    const result = await listDesktopSessions({ directory: 'Other', path: path.join(dataDir, 'Other') }, { all: true });
    assert.equal(result.source, 'disk-cache'); assert.equal(result.complete, false); assert.equal(result.hasMore, null);
    assert.equal(result.incompleteReason, 'inactive_profile'); assert.deepEqual(result.sessions, []);
  });
  const result = spawnSync(process.execPath, ['bin/doubao.mjs', '--app', 'work', '--profile', 'Other', 'sessions', 'list', '--all', '--json'], {
    encoding: 'utf8', env: { ...process.env, DOUBAO_DATA_DIR: dataDir, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' },
  });
  assert.equal(result.status, 1, result.stderr); assert.equal(JSON.parse(result.stdout).complete, false);
});
