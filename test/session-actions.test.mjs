import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseOptions } from '../src/cli.mjs';
import { currentApp } from '../src/app.mjs';
import { desktopListClient } from '../src/desktop-list-client.mjs';
import { mutateApiSession, sessionMetadata, sessionMutationInput } from '../src/session-actions.mjs';
import { listHeadlessSessions } from '../src/headless-services.mjs';

const id = '38443439495332098';
const initial = () => ({ conversation_id: id, name: 'before', pinned_time: '0', status: 1,
  project_reference: { project_id: 'p1' }, conversation_type: 3 });
const projectPage = projects => ({ list_projects_downlink_body: { projects, has_more: false } });

function fakeClient({ projects = [{ project_id: 'p1', status: 1, name: 'Alpha' }, { project_id: 'p2', status: 1, name: 'Beta' }],
  applyWrites = true, beforeEachRequest } = {}) {
  const state = initial();
  const calls = [];
  const client = { async imRequest(route, cmd, key, body, timeoutMs) {
    calls.push({ route, cmd, key, body, timeoutMs });
    beforeEachRequest?.({ route, cmd, key, body, state, calls });
    if (route === 'conversation/batch_get') return { batch_get_conv_info_downlink_body: { conversation_info_list: [{ ...state }] } };
    if (route === 'project/list') return projectPage(projects);
    if (route === 'conversation/update_name') {
      if (applyWrites) state.name = body.name;
      return { update_conversation_name_downlink_body: {} };
    }
    if (route === 'conversation/operate') {
      if (applyWrites) state.pinned_time = body.operate_type === 1 ? '1710000000' : '0';
      return { operate_conv_downlink_body: {} };
    }
    if (route === 'conversation/batch_operate') {
      if (applyWrites) state.status = body.operate_type === 8 ? 8 : 1;
      return { batch_operate_conv_downlink_body: { has_failure: false, conversation_list: [{ success: true }] } };
    }
    if (route === 'project/move_conversation') {
      if (applyWrites) state.project_reference = body.target_project_id ? { project_id: body.target_project_id } : null;
      return { move_conversation_to_project_downlink_body: { success: true } };
    }
    assert.fail(`Unexpected route: ${route}`);
  } };
  return { client, state, calls };
}

test('archive, pin, rename, and move actions round-trip through their official request schemas', async () => {
  const { client, state, calls } = fakeClient();
  const cases = [
    ['archive', '', 'conversation/batch_operate', 1125, 'batch_operate_conv_uplink_body', { conversation_id_list: [id], operate_type: 8 }],
    ['unarchive', '', 'conversation/batch_operate', 1125, 'batch_operate_conv_uplink_body', { conversation_id_list: [id], operate_type: 9 }],
    ['pin', '', 'conversation/operate', 1120, 'operate_conv_uplink_body', { conversation_id: id, operate_type: 1, conversation_type: 3 }],
    ['unpin', '', 'conversation/operate', 1120, 'operate_conv_uplink_body', { conversation_id: id, operate_type: 2, conversation_type: 3 }],
    ['rename', 'after', 'conversation/update_name', 4150, 'update_conversation_name_uplink_body', { conversation_id: id, name: 'after', conversation_type: 3 }],
    ['move', 'p2', 'project/move_conversation', 4603, 'move_conversation_to_project_uplink_body', { conversation_id: id, target_project_id: 'p2' }],
  ];
  for (const [action, value, route, cmd, key, expectedBody] of cases) {
    const result = await mutateApiSession(client, sessionMutationInput(action, id, value));
    const write = calls.filter(call => call.route === route).at(-1);
    assert.equal(write.cmd, cmd, action);
    assert.equal(write.key, key, action);
    for (const field of Object.keys(expectedBody)) assert.deepEqual(write.body[field], expectedBody[field], `${action}.${field}`);
    assert.equal(result.action, action);
    assert.equal(result.changed, true);
    assert.equal(result.verified, true);
  }
  assert.equal(state.status, 1);
  assert.equal(state.pinned_time, '0');
  assert.equal(state.name, 'after');
  assert.equal(state.project_reference.project_id, 'p2');
});

test('already-satisfied actions skip writes and invalid or missing inputs fail before network access', async () => {
  const { client, calls } = fakeClient();
  const already = await mutateApiSession(client, sessionMutationInput('unpin', id));
  assert.equal(already.changed, false);
  assert.equal(already.verified, true);
  assert.equal(calls.length, 1, 'only the initial state read should be sent');
  for (const [action, operand] of [['rename', ' '], ['move', ''], ['pin', 'bad-id']]) {
    assert.throws(() => sessionMutationInput(action, action === 'pin' ? operand : id, action === 'pin' ? '' : operand));
  }
  assert.equal(calls.length, 1);
});

test('rename matches the app dialog title limit in UTF-16 units', () => {
  assert.equal(sessionMutationInput('rename', id, '12345678901234567890').value.length, 20);
  assert.equal(sessionMutationInput('rename', id, '😀'.repeat(10)).value.length, 20);
  assert.throws(() => sessionMutationInput('rename', id, '123456789012345678901'), /20 characters/u);
  assert.throws(() => sessionMutationInput('rename', id, '😀'.repeat(11)), /20 characters/u);
});

test('raw conversation status maps archive state and malformed values stay unknown', () => {
  assert.equal(sessionMetadata({ conversation_id: id, status: 8 }).archived, true);
  assert.equal(sessionMetadata({ conversation_id: id, status: 1 }).archived, false);
  assert.equal(sessionMetadata({ conversation_id: id, status: 7 }).archived, null);
  assert.equal(sessionMetadata({ conversation_id: id, status: '8' }).archived, null);
});

test('a failed readback reports unknown state and never repeats the write', async () => {
  const { client, calls } = fakeClient({ applyWrites: false });
  await assert.rejects(mutateApiSession(client, sessionMutationInput('rename', id, 'after')),
    error => error.code === 'session_readback_failed' && error.result?.verified === false && error.result?.status === 'unknown');
  assert.equal(calls.filter(call => call.route === 'conversation/update_name').length, 1);
  assert.equal(calls.filter(call => call.route === 'conversation/batch_get').length, 4, 'one initial read and three readback attempts');
});

test('move resolves exact project IDs and names, treats none as clearing, and rejects duplicate names', async () => {
  const projects = [{ project_id: 'p1', status: 1, name: 'Alpha' }, { project_id: 'p2', status: 1, name: 'Beta' }];
  const byName = fakeClient({ projects });
  assert.equal((await mutateApiSession(byName.client, sessionMutationInput('move', id, 'Beta'))).projectId, 'p2');
  assert.equal(byName.calls.find(call => call.route === 'project/move_conversation').body.target_project_id, 'p2');
  const clear = fakeClient({ projects });
  assert.equal((await mutateApiSession(clear.client, sessionMutationInput('move', id, 'none'))).projectId, null);
  assert.equal(clear.calls.find(call => call.route === 'project/move_conversation').body.target_project_id, '');
  const duplicate = fakeClient({ projects: [...projects, { project_id: 'p3', status: 1, name: 'Beta' }] });
  await assert.rejects(mutateApiSession(duplicate.client, sessionMutationInput('move', id, 'Beta')), /Multiple projects named/u);
  assert.equal(duplicate.calls.some(call => call.route === 'project/move_conversation'), false);
  const exactId = fakeClient({ projects: [...projects, { project_id: 'p3', status: 1, name: 'Beta' }] });
  assert.equal((await mutateApiSession(exactId.client, sessionMutationInput('move', id, 'p3'))).projectId, 'p3');
});

test('Headless archived listing requests archive-only results and maps raw session metadata', async () => {
  const requests = [];
  const client = { async imRequest(route, cmd, key, body) {
    requests.push({ route, cmd, key, body });
    return { pull_recent_conv_chain_downlink_body: { has_more: false, cells: [
      { conversation: { conversation_id: id, name: 'Old', status: 8, pinned_time: '1710000000', project_reference: { project_id: 9007199254740993n.toString() } } },
      { conversation: { conversation_id: String(BigInt(id) + 1n), name: 'Unknown', status: 7, pinned_time: 'bad' } },
    ] } };
  } };
  const result = await listHeadlessSessions(client, { archived: true, all: true });
  assert.equal(result.sessions[0].archived, true);
  assert.equal(result.sessions[0].pinned, true);
  assert.equal(result.sessions[0].projectId, '9007199254740993');
  assert.equal(result.sessions[1].archived, null);
  assert.equal(result.sessions[1].pinned, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, 'chain/recent_conv');
  assert.equal(requests[0].cmd, 3200);
  assert.equal(requests[0].key, 'pull_recent_conv_chain_uplink_body');
  assert.deepEqual({ need_pc_pin_chain: requests[0].body.option.need_pc_pin_chain,
    exclude_archive: requests[0].body.option.exclude_archive, only_archive: requests[0].body.option.only_archive },
  { need_pc_pin_chain: false, exclude_archive: false, only_archive: true });
});

test('request deadline expiry after acknowledgement surfaces failed readback without replaying the mutation', async t => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const { client, calls } = fakeClient({ beforeEachRequest: () => { now += 10; } });
  await assert.rejects(mutateApiSession(client, sessionMutationInput('pin', id), 25), error => error.code === 'session_readback_failed');
  assert.equal(calls.filter(call => call.route === 'conversation/operate').length, 1);
});

function desktopRenderer(respond) {
  const requests = [];
  const context = vm.createContext({ URL, crypto, AbortSignal, setTimeout, clearTimeout,
    localStorage: { getItem: key => key === 'flow_tea_user_id' ? '12345678901234' : null },
    performance: { getEntriesByType: () => [{ name: `https://www.doubao.com/im/project/list?aid=${currentApp().aid}&device_id=device` }] },
    window: { '@flow-web/desktop:stable': { push: ([,,done]) => done(() => ({})) },
      neotix: { taskMode: { runtime: { queryRuntimeInfo: async () => ({ env: {} }) } } } },
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return Response.json(await respond(request));
    },
  });
  return { requests, async evaluate(expression) {
    try { return await vm.runInContext(expression, context); }
    catch (error) { throw new Error(error.message); }
  }, close() {} };
}

test('Desktop renderer transport uses the shared service for pin and rename', async () => {
  const state = initial();
  const desktop = desktopRenderer(request => {
    const uplink = request.uplink_body;
    if (request.cmd === 1111) return { downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{ ...state }] } } };
    if (request.cmd === 1120) { state.pinned_time = uplink.operate_conv_uplink_body.operate_type === 1 ? '1710000000' : '0'; return { downlink_body: { operate_conv_downlink_body: {} } }; }
    if (request.cmd === 4150) { state.name = uplink.update_conversation_name_uplink_body.name; return { downlink_body: { update_conversation_name_downlink_body: {} } }; }
    assert.fail(`Unexpected Desktop command ${request.cmd}`);
  });
  const client = desktopListClient(desktop);
  assert.equal((await mutateApiSession(client, sessionMutationInput('pin', id))).pinned, true);
  assert.equal((await mutateApiSession(client, sessionMutationInput('rename', id, 'Desktop title'))).title, 'Desktop title');
  assert.deepEqual(desktop.requests.map(request => request.cmd), [1111, 1120, 1111, 1111, 4150, 1111]);
  assert.equal(state.name, 'Desktop title');
});

test('Desktop and Headless parse mutation commands, expose Headless help, and reject unrelated flags', () => {
  assert.equal(parseOptions(['--platform', 'doubao', 'sessions', 'archive', id]).args[1], 'archive');
  assert.equal(parseOptions(['headless', 'sessions', 'move', id, 'none']).args[1], 'move');
  assert.equal(parseOptions(['headless', 'sessions', 'list', '--archived']).archived, true);
  assert.equal(parseOptions(['--platform', 'doubao', 'sessions', 'list', '--archived']).archived, true);
  const help = parseOptions(['headless', 'help', 'sessions']);
  assert.deepEqual(help.helpPath, ['sessions']);
  assert.throws(() => parseOptions(['headless', 'sessions', 'pin', id, '--limit', '2']), /--limit requires sessions list or read/u);
  assert.throws(() => parseOptions(['--platform', 'doubao', 'sessions', 'archive', id, '--all']), /--all requires sessions list/u);
});

test('scoped help prints a concrete usage line for every Desktop and Headless session action', async t => {
  const actions = ['archive', 'unarchive', 'pin', 'unpin', 'rename', 'move'];
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  for (const [backend, prefix, commandPrefix] of [
    ['Desktop', ['--app', 'work'], 'doubao sessions'],
    ['Headless', ['headless'], 'doubao headless sessions'],
  ]) {
    for (const action of actions) {
      output.length = 0;
      await main([...prefix, 'sessions', action, '--help']);
      const text = output.join('\n');
      const operand = action === 'rename' ? '<conversation-id> <title>'
        : action === 'move' ? '<conversation-id> <project-id-or-name|none>' : '<conversation-id>';
      assert.ok(text.startsWith('Usage:'), `${backend} ${action} should print scoped usage`);
      assert.ok(text.includes(`${commandPrefix} ${action} ${operand}`), `${backend} ${action} should print its concrete usage`);
      assert.match(text, /--json/u, `${backend} ${action} JSON option`);
      assert.match(text, /--timeout/u, `${backend} ${action} timeout option`);
    }
  }
});

test('inactive Desktop profiles reject session mutations before making network requests', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-session-action-profile-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'Local State'), JSON.stringify({ profile: {
    last_used: 'Default', info_cache: { Default: {}, Other: {} },
  } }));
  const previousDataDir = process.env.DOUBAO_DATA_DIR;
  const previousDisableAutoUpdate = process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE;
  process.env.DOUBAO_DATA_DIR = dataDir;
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.DOUBAO_DATA_DIR;
    else process.env.DOUBAO_DATA_DIR = previousDataDir;
    if (previousDisableAutoUpdate === undefined) delete process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE;
    else process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = previousDisableAutoUpdate;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected network access'); });
  await assert.rejects(main(['--app', 'work', '--profile', 'Other', 'sessions', 'archive', id, '--json']), /Profile Other is not active/u);
  assert.equal(requests, 0);
});
