import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseOptions } from '../src/cli.mjs';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { completionBody, executeHeadless } from '../src/headless.mjs';
import { headlessProfilePaths, updateHeadlessState } from '../src/headless-state.mjs';
import { receiptStore } from '../src/turns.mjs';

const ACCOUNT = '123456789012345678';
const CONVERSATION = '38439138239851266';
const NEXT_CONVERSATION = '38439138239851268';
const RUN = '38439138239851267';
const HEADLESS_APP = resolvePlatform('headless');

test('new cloud conversations bind the project in both initialization fields', () => {
  for (const projectId of ['project-42', '', undefined]) {
    const body = completionBody({ message: 'fixture', taskContext: { projectId } });
    const expected = { need_ack_conversation: true, ...(projectId ? { project_id: projectId } : {}) };
    assert.equal(body.option.need_create_conversation, true);
    assert.deepEqual(body.option.conversation_init_option, expected);
    assert.deepEqual(JSON.parse(body.ext.conversation_init_option), expected);
    assert.equal(body.option.general_task_param.need_modify_conversation, false);
  }
});

test('existing task changes persist runtime, device, permission, workspace and project after local parameter merging', () => {
  const local = { runtime_type: 2, local_device_id: '1234567890123', local_app_id: '1044603', sandbox_auth_type: 0, workspace: '/tmp/fixture' };
  const build = (previous, next, extra = {}) => completionBody({ conversationId: CONVERSATION, message: 'fixture',
    taskContext: { previousAgentParam: previous, previousProjectId: 'project-a', projectId: 'project-a', ...extra },
    ...(next.runtime_type === 2 ? { localTaskParam: { runtime_type: 2, agent_task_param: next,
      agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false }, need_modify_conversation: false } } : {}) })
    .option.general_task_param;
  const switched = build({ runtime_type: 1 }, local, { projectId: 'project-b' });
  assert.deepEqual(switched.agent_task_param_change, { runtime_changed: true, device_changed: true, sandbox_auth_type_changed: true });
  assert.equal(switched.project_id, 'project-b');
  assert.equal(switched.need_modify_conversation, true);
  assert.equal(build(local, local).need_modify_conversation, false);
  assert.deepEqual(build(local, { ...local, workspace: '/tmp/next' }).agent_task_param_change,
    { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false });
  assert.equal(build(local, { ...local, workspace: '/tmp/next' }).need_modify_conversation, true);
  assert.equal(build(local, { ...local, sandbox_auth_type: 1 }).agent_task_param_change.sandbox_auth_type_changed, true);
  const cloud = build(local, { runtime_type: 1 }, { projectId: '' });
  assert.deepEqual(cloud.agent_task_param_change, { runtime_changed: true, device_changed: true, sandbox_auth_type_changed: true });
  assert.equal(cloud.project_id, '');
  assert.equal(cloud.need_modify_conversation, true);
  const created = completionBody({ message: 'fixture', localTaskParam: { agent_task_param: local }, taskContext: { projectId: 'project-b' } }).option.general_task_param;
  assert.deepEqual(created.agent_task_param_change, { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false });
  assert.equal(created.need_modify_conversation, false);
});

function json(body, status = 200) { return Response.json(body, { status }); }

function eventStream(events) {
  return new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

function ack(conversationId, runId = RUN) {
  return { event: 'SSE_ACK', data: { ack_client_meta: { conversation_id: conversationId }, query_list: [{ question_id: runId }] } };
}

function modelCatalog(items) {
  return json({ code: 0, data: { entry_list: [{ action_bar_key: 'coco_deep_thinking', active_switch_conf: {
    menu_conf_v2: { mode_list: { item_list: [
      { agent_mode: 1, model_list: { item_list: items } },
      { agent_mode: 2, model_list: { item_list: items } },
    ] } },
  } }] } });
}

const ORANGE_55 = { model_item_key: '5255447810', item_id: '5255447810', name: 'Orange 5.5',
  model_extra_params: { provider_id: 'cis', model_type: 'custom' } };
const ORANGE_50 = { model_item_key: 'orange-5.0-live', item_id: 'orange-5.0-live', name: 'Orange 5.0',
  model_extra_params: { provider_id: '', model_type: 'custom' } };

function imResponse(key, body) {
  return json({ status_code: 0, downlink_body: { [key]: body } });
}

function isolated(t) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-headless-business-'));
  const previous = Object.fromEntries(['DOUBAO_CLI_CONFIG_DIR', 'DOUBAO_CLI_DISABLE_AUTO_UPDATE', 'DOUBAO_HEADLESS_COOKIE']
    .map(name => [name, process.env[name]]));
  process.env.DOUBAO_CLI_CONFIG_DIR = configDir;
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  process.env.DOUBAO_HEADLESS_COOKIE = 'sessionid=fixture-session';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  return configDir;
}

test('Headless recovery receipts isolate named profiles while retaining the legacy default scope', async t => {
  isolated(t);
  const storeFor = profile => withApp(HEADLESS_APP, () => receiptStore({ accountId: ACCOUNT, profile }));
  const defaultStore = await storeFor('default'), legacy = await storeFor(undefined);
  const alpha = await storeFor('alpha'), beta = await storeFor('beta');
  defaultStore.save({ conversationId: CONVERSATION, runId: RUN, marker: 'default' });
  alpha.save({ conversationId: CONVERSATION, runId: RUN, marker: 'alpha' });
  assert.equal(legacy.read(CONVERSATION, RUN).marker, 'default');
  assert.equal(defaultStore.read(CONVERSATION, RUN).marker, 'default');
  assert.equal(alpha.read(CONVERSATION, RUN).marker, 'alpha');
  assert.deepEqual(beta.read(CONVERSATION, RUN), {});
});

test('logout removes only the selected profile credentials and state', async t => {
  const configDir = isolated(t);
  for (const profile of ['alpha', 'beta']) {
    const files = headlessProfilePaths({ configDir, profile });
    fs.mkdirSync(files.directory, { recursive: true });
    fs.writeFileSync(files.credentials, JSON.stringify({ testFixture: profile }));
    await updateHeadlessState({ configDir, profile, accountId: ACCOUNT,
      currentConversationId: profile === 'alpha' ? CONVERSATION : NEXT_CONVERSATION,
      defaults: { modelId: `model-${profile}`, reasoning: 'medium' } });
  }
  const result = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions(['headless', '--profile', 'alpha', 'logout'])));
  assert.equal(result.profile, 'alpha');
  assert.equal(result.storedCredentialsRemoved, true);
  assert.equal(fs.existsSync(headlessProfilePaths({ configDir, profile: 'alpha' }).credentials), false);
  assert.equal(fs.existsSync(headlessProfilePaths({ configDir, profile: 'alpha' }).state), false);
  assert.equal(fs.existsSync(headlessProfilePaths({ configDir, profile: 'beta' }).credentials), true);
  const betaState = JSON.parse(fs.readFileSync(headlessProfilePaths({ configDir, profile: 'beta' }).state, 'utf8'));
  assert.equal(betaState.currentConversationId, NEXT_CONVERSATION);
  assert.equal(betaState.defaults.modelId, 'model-beta');
});

test('open/current read the authenticated server conversation and remain profile-scoped', async t => {
  const configDir = isolated(t);
  const routes = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    routes.push(url.pathname);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    assert.match(init.headers.cookie, /sessionid=fixture-session/u);
    if (url.pathname === '/im/conversation/batch_get') {
      const request = JSON.parse(init.body).uplink_body.batch_get_conv_info_uplink_body;
      assert.deepEqual(request.conversation_id, [CONVERSATION]);
      return imResponse('batch_get_conv_info_downlink_body', { conversation_info_list: [
        { conversation_id: CONVERSATION, name: 'server-confirmed title' },
      ] });
    }
    assert.fail(`unexpected route ${url.pathname}`);
  });
  const opened = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'alpha', 'sessions', 'open', CONVERSATION,
  ])));
  assert.deepEqual(opened, { platform: 'headless', profile: 'alpha', id: CONVERSATION,
    title: 'server-confirmed title', selected: true, browserOpened: false });
  const current = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'alpha', 'sessions', 'current',
  ])));
  assert.equal(current.id, CONVERSATION);
  assert.equal(current.title, 'server-confirmed title');
  await assert.rejects(withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'beta', 'sessions', 'current',
  ]))), /No current Headless conversation/u);
  assert.equal(routes.filter(route => route === '/im/conversation/batch_get').length, 2);
});

test('blank new-session draft clears only local selection and never sends completion', async t => {
  const configDir = isolated(t);
  await updateHeadlessState({ configDir, profile: 'alpha', accountId: ACCOUNT,
    currentConversationId: CONVERSATION, defaults: { modelId: 'model-a', reasoning: 'high' } });
  const routes = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input); routes.push(url.pathname);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    assert.fail(`unexpected route ${url.pathname}`);
  });
  const result = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'alpha', 'sessions', 'create',
  ])));
  assert.deepEqual(result, { platform: 'headless', conversationId: null, sent: null, draft: true });
  assert.deepEqual(routes, ['/passport/account/info/v2/']);
  const state = JSON.parse(fs.readFileSync(headlessProfilePaths({ configDir, profile: 'alpha' }).state, 'utf8'));
  assert.equal(state.currentConversationId, null);
  assert.deepEqual(state.defaults, { modelId: 'model-a', reasoning: 'high' });
});

test('usage and project list are direct authenticated read-only service calls', async t => {
  isolated(t);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input); seen.push(url.pathname);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    assert.match(init.headers.cookie, /sessionid=fixture-session/u);
    if (url.pathname === '/alice/commerce/sale/subscription/quota/summary/') {
      assert.deepEqual(JSON.parse(init.body), { product_line: 'membership' });
      return json({ code: 0, data: { current_subscription: { display: { short_name: 'Pro' } },
        window_limit_section: { window_limit_groups: [{ feature_group: 'chat', window_limits: [
          { window_type: 1, used_percent: 25, used_amount: 1, total_amount: 4 },
        ] }] } } });
    }
    if (url.pathname === '/im/project/list') {
      const request = JSON.parse(init.body).uplink_body.list_projects_uplink_body;
      assert.deepEqual(request, { limit: 100, include_invisible_projects: false, sort_type: 1,
        group_conversation_filter_param: { exclude_archive: true } });
      return imResponse('list_projects_downlink_body', { projects: [
        { project_id: 'project-1', name: 'Active', status: 1, folders: [] },
        { project_id: 'project-2', name: 'Archived', status: 8, folders: [] },
      ], has_more: false });
    }
    assert.fail(`unexpected route ${url.pathname}`);
  });
  const usage = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions(['headless', 'usage'])));
  assert.equal(usage.subscription, 'Pro');
  assert.equal(usage.windows[0].usedPercent, 25);
  const projects = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions(['headless', 'projects', 'list'])));
  assert.deepEqual(projects.projects.map(project => project.id), ['project-1']);
  assert.deepEqual(seen.filter(route => route !== '/passport/account/info/v2/'), [
    '/alice/commerce/sale/subscription/quota/summary/', '/im/project/list',
  ]);
});

test('confirmed model selection becomes the new-conversation default and task context is prepared natively', async t => {
  const configDir = isolated(t);
  await updateHeadlessState({ configDir, profile: 'alpha', accountId: ACCOUNT,
    currentConversationId: CONVERSATION, defaults: { modelId: 'model-old', reasoning: 'high' } });
  let currentExtra = { mode_id: '3', model_item_key: 'model-old', reasoning_effort: '5' };
  const requests = [];
  const modelModifications = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    if (url.pathname === '/alice/slot/action_bar_v3/brief_list') {
      return json({ code: 0, data: { entry_list: [{ action_bar_key: 'coco_deep_thinking', active_switch_conf: {
        menu_conf_v2: { mode_list: { item_list: [{ agent_mode: 1, model_list: { item_list: [
          { model_item_key: 'model-new', item_id: 'model-new', name: 'New model', model_extra_params: { provider_id: 'provider-x', model_type: 'custom' } },
        ] } }] } },
      } }] } });
    }
    if (url.pathname === '/im/conversation/batch_get') {
      return imResponse('batch_get_conv_info_downlink_body', { conversation_info_list: [
        { conversation_id: CONVERSATION, extra: JSON.stringify(currentExtra) },
      ] });
    }
    if (url.pathname === '/im/conversation/modify') {
      const body = JSON.parse(init.body).uplink_body.modify_conversation_uplink_body;
      assert.equal(body.conversation_id, CONVERSATION);
      assert.equal(body.model_item_key, 'model-new');
      assert.ok(['4', '6'].includes(body.reasoning_effort));
      modelModifications.push(body);
      currentExtra = { mode_id: '3', model_item_key: body.model_item_key, reasoning_effort: body.reasoning_effort };
      return imResponse('modify_conversation_downlink_body', {});
    }
    if (url.pathname === '/im/project/list') {
      return imResponse('list_projects_downlink_body', { projects: [
        { project_id: 'project-42', name: 'Research', status: 1, folders: [] },
      ], has_more: false });
    }
    if (url.pathname === '/alice/office/skills/list_user_and_featured') {
      const body = JSON.parse(init.body);
      assert.equal(body.runtime_type, 1);
      return json({ code: 0, data: { skills: [
        { name: 'doubao-enterprise-search', display_name: '企业知识', type: 2, external_skill_id: 'enterprise-7' },
      ] } });
    }
    if (url.pathname === '/chat/completion') {
      const body = JSON.parse(init.body); requests.push(body);
      return eventStream([ack(NEXT_CONVERSATION)]);
    }
    assert.fail(`unexpected route ${url.pathname}`);
  });

  const selected = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'alpha', 'model', 'select', 'New model', '--reasoning', 'xhigh',
  ])));
  assert.equal(selected.scope, 'conversation-and-new-conversations');
  assert.equal(selected.reasoning, 'xhigh');
  const saved = JSON.parse(fs.readFileSync(headlessProfilePaths({ configDir, profile: 'alpha' }).state, 'utf8'));
  assert.deepEqual(saved.defaults, { modelId: 'model-new', reasoning: 'xhigh' });

  const currentReasoning = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'alpha', 'model', 'reasoning', 'medium',
  ])));
  assert.equal(currentReasoning.reasoning, 'medium');
  assert.equal(modelModifications.at(-1).model_item_key, 'model-new');
  assert.equal(modelModifications.at(-1).reasoning_effort, '4');

  const created = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--profile', 'alpha', 'sessions', 'create', '--reasoning', 'xhigh', '--project', 'Research', '--enterprise-knowledge', 'hello from the CLI',
  ])));
  assert.equal(created.accepted, true);
  const [body] = requests;
  assert.equal(body.option.conversation_init_option.project_id, 'project-42');
  assert.equal(JSON.parse(body.ext.conversation_init_option).project_id, 'project-42');
  assert.equal(body.option.conversation_init_ext.model_item_key, 'model-new');
  assert.equal(body.option.conversation_init_ext.reasoning_effort, '6');
  assert.equal(body.option.model_config.reasoning_effort, 6);
  const task = body.option.general_task_param;
  assert.deepEqual(task.selected_skills, ['doubao-enterprise-search']);
  assert.deepEqual(task.skill_selections, [{ name: 'doubao-enterprise-search', skill_type: 2, skill_id: 'enterprise-7' }]);
  assert.deepEqual(JSON.parse(task.task_input_json).project_context, {
    project_id: 'project-42', project_name: 'Research', folders: [],
  });
});

test('model selection requires exact live display names and resolves stored IDs internally', async t => {
  const configDir = isolated(t);
  const completions = [];
  const modifications = [];
  let currentExtra = { mode_id: '3', model_item_key: '5255447810', reasoning_effort: '5' };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    if (url.pathname === '/alice/slot/action_bar_v3/brief_list') return modelCatalog([ORANGE_50, ORANGE_55]);
    if (url.pathname === '/im/conversation/batch_get') return imResponse('batch_get_conv_info_downlink_body', {
      conversation_info_list: [{ conversation_id: NEXT_CONVERSATION,
        extra: JSON.stringify(currentExtra) }],
    });
    if (url.pathname === '/im/conversation/modify') {
      const body = JSON.parse(init.body).uplink_body.modify_conversation_uplink_body;
      modifications.push(body);
      currentExtra = { mode_id: '3', model_item_key: body.model_item_key, reasoning_effort: body.reasoning_effort };
      return imResponse('modify_conversation_downlink_body', {});
    }
    if (url.pathname === '/chat/completion') {
      completions.push(JSON.parse(init.body));
      return eventStream([ack(NEXT_CONVERSATION)]);
    }
    assert.fail(`unexpected route ${url.pathname}`);
  });

  const selected = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', 'model', 'select', 'Orange 5.5',
  ])));
  assert.equal(selected.id, '5255447810');
  const selectedOld = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', 'model', 'select', 'Orange 5.0',
  ])));
  assert.equal(selectedOld.id, 'orange-5.0-live');
  await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', 'model', 'select', 'Orange 5.5',
  ])));
  const state = JSON.parse(fs.readFileSync(headlessProfilePaths({ configDir }).state, 'utf8'));
  assert.equal(state.defaults.modelId, '5255447810');

  const defaultReasoning = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', 'model', 'reasoning', 'high',
  ])));
  assert.equal(defaultReasoning.reasoning, 'high');

  for (const value of ['orange', 'orange-5.5', '5255447810', 'orange 5.5']) {
    await assert.rejects(withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
      'headless', 'model', 'select', value,
    ]))), /unknown model|exact model name|Available models/iu, value);
    await assert.rejects(withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
      'headless', 'sessions', 'create', '--model', value, 'invalid model message',
    ]))), /unknown model|exact model name|Available models/iu, value);
  }
  assert.equal(completions.length, 0);
  assert.equal(modifications.length, 0);

  const defaultCreated = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', 'sessions', 'create', 'default model message',
  ])));
  assert.equal(defaultCreated.accepted, true);
  assert.equal(completions[0].option.model_config.model_item_key, '5255447810');
  assert.equal(completions[0].option.model_config.reasoning_effort, 5);

  for (const [model, expectedId] of [['Orange 5.0', 'orange-5.0-live'], ['Orange 5.5', '5255447810']]) {
    const result = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
      'headless', 'sessions', 'create', '--model', model, 'fixture message',
    ])));
    assert.equal(result.accepted, true, model);
    assert.equal(completions.at(-1).option.model_config.model_item_key, expectedId);
    assert.equal(completions.at(-1).option.aggregate_params.provider_id,
      expectedId === '5255447810' ? 'cis' : '');
    if (expectedId === '5255447810') {
      assert.equal(completions.at(-1).ext.use_deep_think, '10001');
      assert.equal(completions.at(-1).option.need_deep_think, 10001);
    }
  }

  const currentReasoning = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', 'model', 'reasoning', 'medium',
  ])));
  assert.equal(currentReasoning.reasoning, 'medium');
  assert.equal(modifications.at(-1).model_item_key, '5255447810');
  assert.equal(modifications.at(-1).reasoning_effort, '4');
});

test('unavailable or chat-unsupported Orange 5.5 fails before completion', async t => {
  for (const fixture of [
    { name: 'unavailable', model: { ...ORANGE_55, disabled: true }, mode: 'work' },
    { name: 'work-only in chat mode', model: ORANGE_55, mode: 'chat' },
  ]) {
    await t.test(fixture.name, async t => {
      isolated(t);
      let completionRequests = 0;
      t.mock.method(globalThis, 'fetch', async (input) => {
        const url = new URL(input);
        if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
        if (url.pathname === '/alice/slot/action_bar_v3/brief_list') {
          if (fixture.mode === 'chat') {
            return json({ code: 0, data: { entry_list: [{ action_bar_key: 'coco_deep_thinking', active_switch_conf: {
              menu_conf_v2: { mode_list: { item_list: [{ agent_mode: 1, model_list: { item_list: [fixture.model] } }] } },
            } }] } });
          }
          return modelCatalog([fixture.model]);
        }
        if (url.pathname === '/chat/completion') { completionRequests += 1; return eventStream([ack(NEXT_CONVERSATION)]); }
        assert.fail(`unexpected route ${url.pathname}`);
      });
      await assert.rejects(withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
        'headless', 'sessions', 'create', '--mode', fixture.mode, '--model', 'Orange 5.5', 'fixture message',
      ]))), /Select an available headless model|exact model name|available model/u);
      assert.equal(completionRequests, 0);
    });
  }
});

test('delayed local SSE headers do not block dispatch and ACK storage failure cancels the preflight', { timeout: 5000 }, async t => {
  const configDir = isolated(t);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-headless-recovery-workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let completionRequests = 0;
  let channelCancelled = 0;
  let channelResponseReleased = false;
  let resolveChannelResponse;
  let preflightSandboxId;
  let preflightDeviceId;
  const routeOrder = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    routeOrder.push(url.pathname);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    if (url.pathname === '/alice/office/tool_local/chunk_stream') {
      assert.equal(channelResponseReleased, false);
      const request = JSON.parse(init.body);
      preflightSandboxId = request.client_attrs.sandbox_id;
      preflightDeviceId = request.device_id;
      return new Promise(resolve => { resolveChannelResponse = resolve; });
    }
    if (url.pathname === '/chat/completion') {
      completionRequests += 1;
      assert.equal(typeof resolveChannelResponse, 'function', 'local SSE request must be dispatched first');
      const frame = { event_type: 1, sandbox_id: preflightSandboxId, seq: 7,
        signature: { device_id: preflightDeviceId, key_id: 'fixture-key', signature: 'fixture-signature',
          timestamp_ms: 1_800_000_000_000, user_id: ACCOUNT },
        tool_call: { id: 'write-before-receipt', name: 'Write',
          input: JSON.stringify({ file_path: 'created-before-receipt.txt', content: 'must not run' }),
          option: { agent_id: 'agent-fixture', generate_timestamp_ms: 1_800_000_000_000 } } };
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); },
        cancel() { channelCancelled += 1; },
      });
      resolveChannelResponse(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      channelResponseReleased = true;
      return eventStream([ack(CONVERSATION, RUN)]);
    }
    if (url.pathname === '/alice/office/tool_local/upload_tool_call_result') {
      assert.fail('local tool call must not be consumed before its ACK receipt is durable');
    }
    assert.fail(`unexpected route ${url.pathname}`);
  });
  const originalMkdirSync = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', function (directory, options) {
    if (path.resolve(String(directory)).startsWith(path.join(configDir, 'turns') + path.sep)) {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return originalMkdirSync.call(fs, directory, options);
  });

  let caught;
  try {
    await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
      'headless', '--timeout', '1000', '--profile', 'alpha', '--runtime', 'local', '--workspace', workspace,
      '--wait', 'sessions', 'create', 'accepted local task',
    ])));
    assert.fail('expected receipt storage failure');
  } catch (error) { caught = error; }

  assert.equal(completionRequests, 1);
  assert.equal(channelResponseReleased, true, 'completion dispatch releases the delayed SSE headers');
  assert.deepEqual(routeOrder.slice(0, 3), [
    '/passport/account/info/v2/', '/alice/office/tool_local/chunk_stream', '/chat/completion',
  ]);
  assert.equal(routeOrder.filter(route => route === '/alice/office/tool_local/chunk_stream').length, 1);
  assert.equal(channelCancelled, 1, 'the preflight response is canceled when ACK persistence fails');
  assert.equal(fs.existsSync(path.join(workspace, 'created-before-receipt.txt')), false,
    'the queued native tool call must not run before the ACK receipt is durable');
  assert.equal(caught.code, 'ENOSPC');
  assert.equal(caught.result.accepted, true);
  assert.equal(caught.result.conversationId, CONVERSATION);
  assert.equal(caught.result.runId, RUN);
  assert.equal(caught.result.durableRecoveryAvailable, false);
  assert.match(caught.result.recovery, /Restore recoveryReceipt/u);
  assert.equal(caught.result.recoveryReceipt.conversationId, CONVERSATION);
  assert.equal(caught.result.recoveryReceipt.runId, RUN);
  assert.equal(caught.result.recoveryReceipt.accepted, true);
  assert.equal(caught.result.recoveryReceipt.localRuntime.workspace, workspace);
  assert.equal(caught.result.recoveryReceipt.requestBody.messages[0].content_block[0].content.text_block.text,
    'accepted local task');
  assert.equal(caught.result.recoveryReceipt.cookies, undefined);
  assert.equal(JSON.stringify(caught.result.recoveryReceipt).includes('fixture-session'), false);
  const expectedStore = await withApp(HEADLESS_APP, () => receiptStore({ accountId: ACCOUNT, profile: 'alpha' }));
  assert.equal(caught.result.recoveryReceiptPath, expectedStore.filePath(CONVERSATION, RUN));
  assert.equal(fs.existsSync(caught.result.recoveryReceiptPath), false);
});

test('local create accepts a config ancestor alias when the config directory itself is real', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-headless-home-alias-'));
  const canonicalHome = path.join(root, 'data00', 'home', 'user');
  const homeAlias = path.join(root, 'home', 'user');
  fs.mkdirSync(canonicalHome, { recursive: true });
  fs.mkdirSync(path.dirname(homeAlias), { recursive: true });
  fs.symlinkSync(canonicalHome, homeAlias, 'dir');

  const envNames = ['DOUBAO_CLI_CONFIG_DIR', 'DOUBAO_CLI_DISABLE_AUTO_UPDATE', 'DOUBAO_HEADLESS_COOKIE'];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const configDir = path.join(homeAlias, '.config', 'doubao-cli');
  process.env.DOUBAO_CLI_CONFIG_DIR = configDir;
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  process.env.DOUBAO_HEADLESS_COOKIE = 'sessionid=fixture-session';
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let completionRequest;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/passport/account/info/v2/') return json({ data: { user_id_str: ACCOUNT } });
    if (url.pathname === '/alice/office/tool_local/chunk_stream') {
      return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname === '/chat/completion') {
      completionRequest = JSON.parse(init.body);
      return eventStream([ack(NEXT_CONVERSATION)]);
    }
    if (url.pathname === '/im/conversation/batch_get') {
      const request = JSON.parse(init.body).uplink_body.batch_get_conv_info_uplink_body;
      assert.deepEqual(request.conversation_id, [NEXT_CONVERSATION]);
      return imResponse('batch_get_conv_info_downlink_body', { conversation_info_list: [{
        conversation_id: NEXT_CONVERSATION,
        messages: [
          { user_type: 1, message_id: RUN, local_message_id: completionRequest.messages[0].local_message_id },
          { user_type: 2, message_id: '38439138239851269', bot_reply_message_id: RUN,
            ext: { is_finish: '1' }, content_block: [{ block_type: 10000, content: { text_block: { text: 'finished' } } }] },
        ],
      }] });
    }
    assert.fail(`unexpected route ${url.pathname}`);
  });

  const result = await withApp(HEADLESS_APP, () => executeHeadless(parseOptions([
    'headless', '--timeout', '1000', '--profile', 'alpha', '--runtime', 'local', '--no-skills', '--wait',
    'sessions', 'create', 'alias path task',
  ])));
  assert.equal(result.status, 'completed');
  assert.equal(result.reply.text, 'finished');
  assert.equal(fs.lstatSync(configDir).isSymbolicLink(), false, 'the final config directory is a real directory');
  const profileDirectory = headlessProfilePaths({ profile: 'alpha' }).directory;
  const journalRoot = path.join(fs.realpathSync(profileDirectory), 'runtime');
  assert.equal(fs.readdirSync(journalRoot).length, 1, 'the journal is stored under the canonical profile directory');
  assert.equal(fs.existsSync(path.join(profileDirectory, 'runtime')), true);
});
