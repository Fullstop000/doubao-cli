import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  headlessEnterpriseSkill,
  createHeadlessProject,
  listHeadlessProjects,
  listHeadlessSessions,
  modifyHeadlessModel,
  readHeadlessUsage,
  readHeadlessConversation,
  headlessProfileMetadata,
} from '../src/headless-services.mjs';

const id = '38439138239851266';

const sessionCell = (offset, runtime = 1) => ({ conversation: {
  conversation_id: String(BigInt(id) + BigInt(offset)), name: `session-${offset}`,
  conv_extra: { agent_task_param: { runtime_type: runtime } },
} });

test('Headless all-session listing follows older cursors through empty pages and deduplicates IDs', async () => {
  const calls = [];
  const pages = [
    { cells: [sessionCell(0, 2), { conversation: { conversation_id: 'draft' } }], has_more: true, next_conv_version: '300' },
    { cells: [], has_more: true, next_conv_version: '200' },
    { cells: [sessionCell(0), sessionCell(1)], has_more: true, next_conv_version: '100' },
    { cells: [sessionCell(2)], has_more: false },
  ];
  const result = await listHeadlessSessions({ async imRequest(...args) {
    calls.push(args);
    return { pull_recent_conv_chain_downlink_body: pages[calls.length - 1] };
  } }, { all: true });
  assert.deepEqual(calls.map(x => x[3].conv_version), [0, 300, 200, 100]);
  assert.deepEqual(calls.map(x => x[3].direction), [3, 1, 1, 1]);
  assert.deepEqual(calls.map(x => x[3].option.need_coco_conversation), [true, false, false, false]);
  assert.ok(calls.every(x => x[0] === 'chain/recent_conv' && x[3].limit === 100 && x[3].option.not_need_message));
  assert.ok(calls.every(x => x[3].option.need_pc_pin_chain === true));
  assert.deepEqual(result.sessions.map(x => x.runtime), ['local', 'cloud', 'cloud']);
  assert.equal(result.hasMore, false);
  assert.equal(result.pages, 4);
});

test('Headless all-session listing carries the Work pinned phase across a cursor reset', async () => {
  const calls = [];
  const pages = [
    { cells: [sessionCell(0)], has_more: true, next_conv_version: '100', extra: { pc_pin_query_type: 0 } },
    { cells: [], has_more: true, next_conv_version: '0', extra: { pc_pin_query_type: 1 } },
    { cells: [sessionCell(1)], has_more: true, next_conv_version: '500', extra: { pc_pin_query_type: 1 } },
    { cells: [sessionCell(2)], has_more: false },
  ];
  const result = await listHeadlessSessions({ async imRequest(...args) {
    calls.push(args); return { pull_recent_conv_chain_downlink_body: pages[calls.length - 1] };
  } }, { all: true });
  assert.deepEqual(calls.map(x => [x[3].conv_version, x[3].option.pc_pin_query_type]), [[0, 0], [100, 0], [0, 1], [500, 1]]);
  assert.deepEqual(calls.map(x => x[3].direction), [3, 1, 3, 1]);
  assert.equal(result.sessions.length, 3);
  assert.equal(result.hasMore, false);
});

test('Headless session limit counts unique sessions across pages and preserves truncation status', async () => {
  let calls = 0;
  const result = await listHeadlessSessions({ async imRequest() {
    calls++;
    return { pull_recent_conv_chain_downlink_body: calls === 1
      ? { cells: [sessionCell(0), sessionCell(0)], has_more: true, next_conv_version: '100' }
      : { cells: [sessionCell(0), sessionCell(1), sessionCell(2), sessionCell(3)], has_more: false } };
  } }, { limit: 3 });
  assert.equal(calls, 2);
  assert.equal(result.sessions.length, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.complete, false);
  assert.equal(result.source, 'api');
  assert.equal(result.pages, 2);
});

test('Headless session paging retries the same read after an intermittent server rejection, with a fixed retry limit', async () => {
  const requests = [];
  const rejected = () => Object.assign(new Error('Doubao IM request was rejected (712010702)'), { code: 'request_rejected' });
  const result = await listHeadlessSessions({ async imRequest(...args) {
    requests.push(args[3]);
    if (requests.length === 1) throw rejected();
    return { pull_recent_conv_chain_downlink_body: { cells: [sessionCell(0)], has_more: false } };
  } }, { all: true });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.pages, 1);
  let calls = 0;
  await assert.rejects(listHeadlessSessions({ async imRequest() { calls++; throw rejected(); } }, { all: true }),
    error => error.code === 'request_rejected');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(listHeadlessSessions({ async imRequest() {
    calls++; throw Object.assign(new Error('login required'), { code: 'login_required' });
  } }, { all: true }), error => error.code === 'login_required');
  assert.equal(calls, 1);
});

test('Headless session pagination rejects missing, repeated, reversed and unsafe cursors', async () => {
  for (const next of [undefined, null, '', 'bad', '0', '9007199254740993', true, {}]) {
    await assert.rejects(listHeadlessSessions({ async imRequest() {
      return { pull_recent_conv_chain_downlink_body: { cells: [], has_more: true, next_conv_version: next } };
    } }, { all: true }), error => error.code === 'session_pagination_invalid', String(next));
  }
  for (const next of ['100', '200']) {
    let calls = 0;
    await assert.rejects(listHeadlessSessions({ async imRequest() {
      return { pull_recent_conv_chain_downlink_body: { cells: [], has_more: true, next_conv_version: ++calls === 1 ? '100' : next } };
    } }, { all: true }), error => error.code === 'session_pagination_invalid');
    assert.equal(calls, 2);
  }
  await assert.rejects(listHeadlessSessions({ async imRequest() {
    return { pull_recent_conv_chain_downlink_body: { cells: [], has_more: 'false' } };
  } }, { all: true }), error => error.code === 'session_list_invalid');
});

test('Headless session pagination shares one deadline and never returns a partial list as complete', async t => {
  let now = 10_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  await assert.rejects(listHeadlessSessions({ async imRequest() {
    calls++; now += 1000;
    return { pull_recent_conv_chain_downlink_body: { cells: [sessionCell(0)], has_more: true, next_conv_version: '100' } };
  } }, { all: true, timeoutMs: 1000 }), error => error.code === 'timeout');
  assert.equal(calls, 1);
});

test('Headless project listing follows verified IM cursors and filters inactive projects', async () => {
  const calls = [];
  const client = { async imRequest(...args) {
    calls.push(args);
    const request = args[3];
    return { list_projects_downlink_body: {
      projects: request.cursor
        ? [{ project_id: 2, name: 'second', status: 1, folders: [{ folder_name: 'src', workspace: '/src', folder_device_id: 12, is_primary: true }] }]
        : [{ project_id: 1, name: 'first', status: 1 }, { project_id: 3, status: 3 }],
      has_more: !request.cursor,
      next_cursor: 'page-2',
    } };
  } };
  assert.deepEqual(await listHeadlessProjects(client, 4321), [
    { id: '1', name: 'first', folders: [] },
    { id: '2', name: 'second', folders: [{ name: 'src', path: '/src', deviceId: '12', deviceName: undefined, primary: true }] },
  ]);
  assert.deepEqual(calls.map(([route, cmd, key, body]) => [route, cmd, key, body]), [
    ['project/list', 4605, 'list_projects_uplink_body', {
      limit: 100, include_invisible_projects: false, sort_type: 1,
      group_conversation_filter_param: { exclude_archive: true },
    }],
    ['project/list', 4605, 'list_projects_uplink_body', {
      limit: 100, include_invisible_projects: false, sort_type: 1,
      group_conversation_filter_param: { exclude_archive: true }, cursor: 'page-2',
    }],
  ]);
  assert.ok(calls.every(call => call[4] > 0 && call[4] <= 4321));
  assert.ok(calls[1][4] <= calls[0][4]);
});

test('Headless project pagination rejects missing and repeated cursors', async () => {
  await assert.rejects(listHeadlessProjects({ imRequest: async () => ({ list_projects_downlink_body: { projects: [], has_more: true } }) }),
    error => error.code === 'project_pagination_invalid');
  let call = 0;
  await assert.rejects(listHeadlessProjects({ imRequest: async () => ({ list_projects_downlink_body: {
    projects: [], has_more: true, next_cursor: ++call === 1 ? 'repeat' : 'repeat',
  } }) }), error => error.code === 'project_pagination_invalid');
});

test('project create uses verified IM schema and confirms by id through list readback', async () => {
  let mutationCount = 0;
  const calls = [];
  const client = { async imRequest(...args) {
    calls.push(args);
    if (args[0] === 'project/create') {
      mutationCount += 1;
      return { create_project_downlink_body: { project: { project_id: '123' } } };
    }
    return { list_projects_downlink_body: { projects: [{ project_id: '123', name: 'demo', status: 1, folders: [] }], has_more: false } };
  } };
  const result = await createHeadlessProject(client, { name: ' demo ' }, 5432);
  assert.equal(result.id, '123');
  assert.equal(result.name, 'demo');
  assert.equal(result.verified, true);
  assert.match(result.operationId, /^[0-9a-f-]{36}$/u);
  assert.equal(mutationCount, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['project/create', 4600, 'create_project_uplink_body']);
  assert.deepEqual(calls[0][3], {
    client_request_id: result.operationId, name: 'demo', instruction: '', folders: [],
  });
  assert.ok(calls[0][4] > 0 && calls[0][4] <= 5432);
  assert.ok(calls[1][4] > 0 && calls[1][4] <= calls[0][4]);
  assert.equal(calls[1][0], 'project/list');
});

test('workspace project creation requires a device id and confirms its primary folder', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-project-workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const client = { async imRequest(...args) {
    calls.push(args);
    if (args[0] === 'project/create') return { create_project_downlink_body: { project: { project_id: '124' } } };
    return { list_projects_downlink_body: { projects: [{ project_id: '124', name: 'folder', status: 1, folders: [{
      folder_name: path.basename(workspace), workspace, folder_device_id: 'device-1', is_primary: true,
    }] }], has_more: false } };
  } };
  await assert.rejects(createHeadlessProject(client, { name: 'folder', workspace }), /verified local device id/u);
  assert.equal(calls.length, 0);
  const result = await createHeadlessProject(client, { name: 'folder', workspace, deviceId: 'device-1' });
  assert.equal(result.verified, true);
  assert.deepEqual(calls[0][3].folders, [{ folder_name: path.basename(workspace), workspace,
    is_primary: true, folder_device_id: 'device-1' }]);
});

test('project create never resends after uncertain mutation or failed readback', async () => {
  let mutationCount = 0;
  const lostResponse = { async imRequest(route) {
    if (route === 'project/create') { mutationCount += 1; throw new Error('connection lost'); }
    assert.fail('create must not run list readback without an id');
  } };
  await assert.rejects(createHeadlessProject(lostResponse, { name: 'demo' }), error => {
    assert.equal(error.code, 'project_create_unconfirmed');
    assert.equal(error.result.id, null);
    assert.equal(error.result.status, 'unknown');
    return true;
  });
  assert.equal(mutationCount, 1);

  mutationCount = 0;
  const readbackMismatch = { async imRequest(route) {
    if (route === 'project/create') { mutationCount += 1; return { create_project_downlink_body: { project: { project_id: '125' } } }; }
    return { list_projects_downlink_body: { projects: [], has_more: false } };
  } };
  await assert.rejects(createHeadlessProject(readbackMismatch, { name: 'demo' }), error => {
    assert.equal(error.code, 'project_readback_failed');
    assert.equal(error.result.id, '125');
    assert.equal(error.result.status, 'created');
    assert.equal(error.result.verified, false);
    return true;
  });
  assert.equal(mutationCount, 1);
});

test('enterprise skill lookup uses verified route, runtime schema and exact visible skill', async () => {
  const calls = [];
  const client = { async json(...args) {
    calls.push(args);
    return { code: 0, data: { skills: [
      { name: 'other', type: 2, external_skill_id: 'other' },
      { name: 'doubao-enterprise-search', display_name: '企业知识', type: 2, external_skill_id: 'skill-42' },
      { name: 'doubao-enterprise-search', visible: false, type: 2, external_skill_id: 'hidden' },
    ] } };
  } };
  assert.deepEqual(await headlessEnterpriseSkill(client, 'local', 9876), {
    name: 'doubao-enterprise-search', displayName: '企业知识', type: 2, externalId: 'skill-42',
  });
  assert.equal(calls[0][0], '/alice/office/skills/list_user_and_featured');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].timeoutMs, 9876);
  assert.deepEqual(JSON.parse(calls[0][1].body), { runtime_type: 2 });
  const cloudCalls = [];
  await headlessEnterpriseSkill({ json: async (...args) => {
    cloudCalls.push(args);
    return { code: 0, data: { skills: [{ name: 'doubao-enterprise-search', type: 1, external_skill_id: 'cloud-skill' }] } };
  } }, 'cloud');
  assert.deepEqual(JSON.parse(cloudCalls[0][1].body), { runtime_type: 1 });
  await assert.rejects(headlessEnterpriseSkill({ json: async () => ({ code: 0, data: { skills: [] } }) }, 'local'),
    error => error.code === 'enterprise_skill_unavailable');
  await assert.rejects(headlessEnterpriseSkill({ json: async () => ({ code: 9, data: {} }) }, 'cloud'),
    error => error.code === 'skill_catalog_unavailable');
  await assert.rejects(headlessEnterpriseSkill(client, 'remote'), /runtime must be local or cloud/u);
});

test('quota read uses verified commerce route and normalizes service response', async () => {
  const calls = [];
  const response = { code: 0, data: { current_subscription: { display: { short_name: 'Pro' } },
    window_limit_section: { window_limit_groups: [{ feature_group: 'general', window_limits: [{ window_type: 1, used_percent: 12 }] }] } } };
  const client = { async json(...args) { calls.push(args); return response; } };
  const result = await readHeadlessUsage(client, 3210);
  assert.equal(result.subscription, 'Pro');
  assert.equal(result.windows[0].remainingPercent, 88);
  assert.equal(calls[0][0], '/alice/commerce/sale/subscription/quota/summary/');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].timeoutMs, 3210);
  assert.deepEqual(JSON.parse(calls[0][1].body), { product_line: 'membership' });
  await assert.rejects(readHeadlessUsage({ json: async () => ({ code: 403 }) }), /usage query failed/u);
});

test('conversation read uses batch_get and returns the exact matching conversation', async () => {
  const expected = { conversation_id: id, extra: JSON.stringify({ model_item_key: 'model-1', reasoning_effort: '5' }) };
  const calls = [];
  const client = { async imRequest(...args) {
    calls.push(args);
    return { batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: '38439138239851268' }, expected] } };
  } };
  assert.equal(await readHeadlessConversation(client, id, 7654), expected);
  assert.deepEqual(calls[0], ['conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', {
    conversation_id: [id], option: { recent_message_count_per_conv: 0 }, ext: {},
  }, 7654]);
  await assert.rejects(readHeadlessConversation(client, 'invalid'), /Invalid conversation id/u);
  await assert.rejects(readHeadlessConversation({ imRequest: async () => ({ batch_get_conv_info_downlink_body: { conversation_info_list: [] } }) }, id),
    error => error.code === 'conversation_not_found');
});

test('model modification uses IM 1114 then verifies stored model and effort', async () => {
  const calls = [];
  const expected = { conversation_id: id, extra: JSON.stringify({ model_item_key: 'model-2', reasoning_effort: '6' }) };
  const client = { async imRequest(...args) {
    calls.push(args);
    if (args[0] === 'conversation/batch_get') return { batch_get_conv_info_downlink_body: { conversation_info_list: [expected] } };
    return {};
  } };
  assert.deepEqual(await modifyHeadlessModel(client, id, 'model-2', '6', 4321), {
    conversationId: id, modelId: 'model-2', reasoningEffort: '6', changed: true,
  });
  assert.deepEqual(calls[0].slice(0, 4), ['conversation/modify', 1114, 'modify_conversation_uplink_body', {
    conversation_id: id, conversation_type: 3, bot_conversation_type: 3,
    mode_id: '3', model_item_key: 'model-2', reasoning_effort: '6',
  }]);
  assert.ok(calls[0][4] > 0 && calls[0][4] <= 4321);
  assert.ok(calls[1][4] > 0 && calls[1][4] <= calls[0][4]);
  assert.equal(calls[1][0], 'conversation/batch_get');
  await assert.rejects(modifyHeadlessModel(client, id, '', '6'), /model id is required/u);
  await assert.rejects(modifyHeadlessModel(client, id, 'model-2', '8'), /Reasoning effort/u);
  const mismatch = { imRequest: async route => route === 'conversation/modify' ? {} : ({
    batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: id, extra: { model_item_key: 'stale', reasoning_effort: '6' } }] },
  }) };
  await assert.rejects(modifyHeadlessModel(mismatch, id, 'model-2', '6'), error => error.code === 'model_setting_unconfirmed');
});

test('Headless profile metadata pins the active account and normalizes only exact string identities', async () => {
  const calls = [];
  const accountId = '12345678';
  const hugeId = '9007199254740993';
  const unsafeNumericEntityId = '9007199254740994';
  const client = {
    accountId,
    async account({ timeoutMs }) { calls.push({ kind: 'account', timeoutMs }); return { accountId }; },
    async json(route, options) {
      calls.push({ kind: 'json', route, options });
      return { code: 0, datas: {
        [accountId]: { profile_brief: { entity_id: accountId, nickname: 'Alice', enterprise_user_type: 101,
          tenant_info: { tenant_id: 0, tenant_name: 'Workspace', user_name: 'alice' } } },
        [hugeId]: { profile_brief: { entity_id: hugeId, nickname: 'Big ID', enterprise_user_type: 999,
          tenant_info: { tenant_id: '0', tenant_name: '', user_name: '' } } },
        [unsafeNumericEntityId]: { profile_brief: { entity_id: 9007199254740994, nickname: 'Rounded', enterprise_user_type: 0 } },
        '87654321': { profile_brief: { entity_id: '11111111', nickname: 'Mismatch', enterprise_user_type: 0 } },
      } };
    },
  };
  const result = await headlessProfileMetadata(client, [accountId, hugeId, unsafeNumericEntityId, 9007199254740993, '87654321', accountId], 9000);
  assert.deepEqual(result, { accounts: {
    [accountId]: { id: accountId, name: 'Alice', type: 'workspace', enterpriseUserType: 101,
      tenant: { id: '0', name: 'Workspace', userName: 'alice' }, source: 'live' },
    [hugeId]: { id: hugeId, name: 'Big ID', type: 'unknown', enterpriseUserType: 999,
      tenant: { id: '0', name: null, userName: null }, source: 'live' },
  }, incompleteReason: 'incomplete_account_metadata' });
  assert.equal(calls.filter(call => call.kind === 'account').length, 2);
  const request = calls.find(call => call.kind === 'json');
  assert.equal(request.route, '/alice/profile/multi');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { visit_ids: [accountId, hugeId, unsafeNumericEntityId, '87654321'] });
  assert.ok(request.options.timeoutMs > 0 && request.options.timeoutMs <= 9000);
});

test('Headless profile metadata reports unavailable and changed account states without relabeling rows', async () => {
  const base = { accountId: '12345678', async account() { return { accountId: this.accountId }; } };
  const rejected = await headlessProfileMetadata({ ...base, async json() { return { code: 7, datas: {} }; } }, ['12345678']);
  assert.deepEqual(rejected, { accounts: {}, incompleteReason: 'account_lookup_failed' });

  let accountCalls = 0;
  const changed = await headlessProfileMetadata({ ...base,
    async account() { accountCalls += 1; return { accountId: accountCalls === 1 ? '12345678' : '87654321' }; },
    async json() { return { code: 0, datas: { '12345678': { profile_brief: { entity_id: '12345678' } } } }; },
  }, ['12345678']);
  assert.deepEqual(changed, { accounts: {}, incompleteReason: 'account_changed' });

  const empty = await headlessProfileMetadata({ ...base, async json() {} }, [9007199254740993]);
  assert.deepEqual(empty, { accounts: {}, incompleteReason: 'invalid_profile_ids' });
});

test('project pagination and model readback share a single request deadline', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const calls = [];
    await assert.rejects(listHeadlessProjects({ async imRequest(...args) {
      calls.push(args);
      now += 1000;
      return { list_projects_downlink_body: { projects: [], has_more: true, next_cursor: 'next' } };
    } }, 1000), error => error.code === 'timeout');
    assert.equal(calls.length, 1);

    const modelCalls = [];
    await assert.rejects(modifyHeadlessModel({ async imRequest(...args) {
      modelCalls.push(args);
      now += 1000;
      return {};
    } }, id, 'model-2', '6', 1000), error => error.code === 'timeout');
    assert.equal(modelCalls.length, 1);
  } finally { Date.now = originalNow; }
});

test('project create does not start readback after the shared deadline expires', async () => {
  const originalNow = Date.now;
  let now = 20_000;
  Date.now = () => now;
  try {
    const calls = [];
    await assert.rejects(createHeadlessProject({ async imRequest(...args) {
      calls.push(args);
      now += 1000;
      return { create_project_downlink_body: { project: { project_id: '987' } } };
    } }, { name: 'deadline' }, 1000), error => {
      assert.equal(error.code, 'timeout');
      assert.equal(error.result.id, '987');
      assert.equal(error.result.status, 'created');
      return true;
    });
    assert.deepEqual(calls.map(call => call[0]), ['project/create']);
  } finally { Date.now = originalNow; }
});
