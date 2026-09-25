import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parseOptions } from '../src/cli.mjs';
import { projectContext, selectProject, resolveTaskContext, listProjects } from '../src/context.mjs';
import { conversationExt, sendChatCompletion, modelProtocol, skillMessage } from '../src/protocol.mjs';
import { currentApp } from '../src/app.mjs';

const project = { id: '123', name: 'demo', folders: [
  { deviceId: 'current', name: 'local', path: '/tmp/local', primary: true },
  { deviceId: 'other', name: 'other', path: '/tmp/other', primary: true },
] };
const skill = { name: 'doubao-enterprise-search', displayName: '企业知识', type: 2, externalId: 'dynamic-id' };

test('task flags validate scope, values and cloud/local conflicts before sending', () => {
  const args = parseOptions(['sessions', 'create', 'hello', '--runtime', 'local', '--project', 'demo', '--enterprise-knowledge', '--attach', '/tmp/a', '--permission', 'AlwaysAsk']);
  assert.equal(args.runtime, 'local'); assert.equal(args.project, 'demo'); assert.equal(args.enterpriseKnowledge, true);
  for (const flags of [['--runtime', 'typo'], ['--project'], ['--runtime', 'cloud', '--workspace', '/tmp'],
    ['--runtime', 'cloud', '--no-skills'], ['--runtime', 'cloud', '--mcp', '123456'], ['--runtime', 'cloud', '--permission', 'FullAccess']]) {
    assert.throws(() => parseOptions(['sessions', 'create', 'hello', ...flags]));
  }
  assert.throws(() => parseOptions(['sessions', 'create', '--runtime', 'local']), /require a message/);
  assert.throws(() => parseOptions(['models', '--enterprise-knowledge']), /require sessions/);
});

test('project selection uses exact names, rejects collisions and grants only this device folders', () => {
  assert.equal(selectProject([project], 'demo'), project);
  assert.equal(selectProject([project], '123'), project);
  assert.equal(selectProject([project], 'none'), null);
  assert.throws(() => selectProject([project], 'missing'), /not found/);
  assert.throws(() => selectProject([project, { ...project, id: '456' }], 'demo'), /Multiple projects/);
  assert.deepEqual(projectContext(project, 'current', 'local').folders.map(f => f.path), ['/tmp/local']);
  assert.deepEqual(projectContext(project, 'other', 'cloud').folders, []);
});

function mockClient({ fetch, prepare, reconcile = async () => ({ ok: true }), localReady = true }) {
  const req = id => {
    if (id === 763283) return { _: () => ({ invoke: reconcile }) };
    if (id === 987391) return { H: prepare };
    throw new Error('unexpected module ' + id);
  };
  req.e = async () => {};
  const context = vm.createContext({ URL, crypto, setTimeout, clearTimeout, TextDecoder, AbortController, AbortSignal,
    document: { querySelector: () => ({}) },
    performance: { getEntriesByType: () => [{ name: `https://www.doubao.com/im/chain/recent_conv?aid=${currentApp().aid}&device_id=current` }] },
    window: { '@flow-web/desktop:stable': { push: ([,,fn]) => fn(req) }, neotix: { taskMode: { runtime: {
      queryRuntimeInfo: async () => ({ status: localReady ? 'READY' : 'FAILED', env: localReady ? { environmentId: 'env' } : {} }),
    } } } }, fetch });
  return { evaluate: expression => vm.runInContext(expression, context), close() {} };
}

function info(extra, projectId = '') {
  return Response.json({ downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{
    conversation_id: '123', extra: JSON.stringify({ agent_task_param: JSON.stringify(extra) }), project_reference: { project_id: projectId },
  }] } } });
}

test('followups inherit the server JSON context and cloud does not require local readiness', async () => {
  const client = mockClient({ localReady: false, fetch: async () => info({ runtime_type: 1 }) });
  const resolved = await resolveTaskContext(client, '123', {});
  assert.equal(resolved.taskContext.runtime, 'cloud');
  assert.equal(resolved.workspace, undefined);
  await assert.rejects(resolveTaskContext(client, '123', { runtime: 'local' }), /not ready/);
});

test('local followups preserve workspace but require explicit consent to switch devices', async () => {
  const previous = { runtime_type: 2, local_device_id: 'current', local_app_id: currentApp().aid, workspace: '/tmp/original' };
  const client = mockClient({ fetch: async () => info(previous) });
  assert.equal((await resolveTaskContext(client, '123', {})).workspace, '/tmp/original');
  previous.local_device_id = 'other';
  await assert.rejects(resolveTaskContext(client, '123', {}), /another local device/);
  assert.notEqual((await resolveTaskContext(client, '123', { runtime: 'local' })).workspace, '/tmp/original');
});

test('project list follows cursors and excludes deleted projects', async () => {
  const cursors = [];
  const client = mockClient({ fetch: async (_, options) => {
    const p = JSON.parse(options.body).uplink_body.list_projects_uplink_body; cursors.push(p.cursor);
    return Response.json({ downlink_body: { list_projects_downlink_body: { projects: [{ project_id: p.cursor ? '2' : '1', name: 'project', status: 1 }, { project_id: '3', status: 3 }], has_more: !p.cursor, next_cursor: 'next' } } });
  } });
  assert.deepEqual((await listProjects(client)).map(p => p.id), ['1', '2']);
  assert.deepEqual(cursors, [undefined, 'next']);
});

test('cloud strips local parameters and records runtime/project changes', () => {
  const ext = conversationExt(modelProtocol('auto'), 'id', '/tmp/local', { existingConversation: true,
    taskContext: { runtime: 'cloud', previousAgentParam: { runtime_type: 2, sandbox_auth_type: 2, local_device_id: 'current' }, previousProjectId: '123', projectId: '', projectContext: {}, enterpriseSkill: skill } });
  const param = JSON.parse(ext.general_task_param);
  assert.deepEqual(param.agent_task_param, { runtime_type: 1 }); assert.equal(param.client_option, undefined);
  assert.equal(param.project_id, ''); assert.equal(param.need_modify_conversation, true);
  assert.equal(param.agent_task_param_change.runtime_changed, true);
  assert.equal(JSON.parse(param.task_input_json).home_dir, undefined);
  assert.deepEqual(param.skill_selections, [{ name: skill.name, skill_type: 2, skill_id: 'dynamic-id' }]);
  assert.match(skillMessage('hello', skill), /skill:\/\/doubao-enterprise-search\?type=2&id=dynamic-id/);
  assert.equal(skillMessage(skillMessage('hello', skill), skill), skillMessage('hello', skill));
});

test('actual no-wait request contains option task context, attachments and reconciles before returning', async () => {
  let body, bound = false;
  const client = mockClient({ fetch: async (_, options) => { body = JSON.parse(options.body); return new Response(
    'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"123"},"query_list":[{"question_id":"456"}]}\n\n'); },
    reconcile: async (_, args) => { assert.equal(args.instanceId, 'sandbox-test'); await new Promise(r => setTimeout(r, 5)); bound = true; return { ok: true }; } });
  const context = { runtime: 'local', projectId: '123', projectContext: { project_id: '123' }, deviceId: 'current', enterpriseSkill: skill };
  const result = await sendChatCompletion(client, { message: 'hello', model: modelProtocol('auto'), waitForReply: false, sandboxId: 'sandbox-test', taskContext: context,
    attachmentBlocks: [{ block_type: 10052, content: { attachment_block: { attachments: [{ file: { uri: 'upload' } }] } } }] });
  assert.equal(result.conversationId, '123'); assert.equal(bound, true);
  assert.deepEqual(body.option.general_task_param, JSON.parse(body.ext.general_task_param));
  assert.equal(body.option.conversation_init_option.project_id, '123');
  assert.equal(JSON.parse(body.option.conversation_init_ext.agent_task_param).runtime_type, 2);
  assert.equal(body.messages[0].content_block[0].content.attachment_block.attachments[0].file.uri, 'upload');
  assert.match(body.messages[0].content_block[1].content.text_block.text, /skill:\/\//);
});

test('sandbox rejection reports the accepted turn and cannot look like success', async () => {
  const client = mockClient({ reconcile: async () => ({ ok: false }), fetch: async () => new Response(
    'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"123"},"query_list":[{"question_id":"456"}]}\n\n') });
  await assert.rejects(sendChatCompletion(client, { message: 'hello', model: modelProtocol('auto'), waitForReply: false, sandboxId: 'sandbox-test' }),
    e => e.code === 'sandbox_reconcile_failed' && e.receipt.runId === '456');
});

test('module discovery survives changed ids and never requires a missing module', async () => {
  const { appModule } = await import('../src/app-modules.mjs');
  const calls = [];
  const req = id => { assert.ok(req.m[id]); calls.push(id); return { id }; };
  req.m = { 424242: function(e,t,r){r.d(t,{Wp:()=>s});const s='chat-ioc-manager: store';} };
  assert.equal(appModule(req, 'stores').id, 424242);
  assert.throws(() => appModule(req, 'attachments'), /unavailable/);
  assert.deepEqual(calls, [424242]);
});

test('generated local workspace is created before provisioning and missing user workspace fails', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { prepareToolSandbox } = await import('../src/mcp.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-context-'));
  const workspace = path.join(root, 'new');
  const client = mockClient({ prepare: async args => {
    assert.ok(fs.statSync(args.cwd).isDirectory());
    assert.deepEqual([...args.projectFolders], ['/tmp/project']);
    return { sandboxId: 'sandbox-prepared' };
  } });
  try {
    await assert.rejects(prepareToolSandbox(client, { workspace }), /not a directory/);
    const result = await prepareToolSandbox(client, { workspace, createWorkspace: true, projectFolders: ['/tmp/project'] });
    assert.equal(result.sandboxId, 'sandbox-prepared');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('old conversations without runtime metadata stay cloud unless local is explicit', async () => {
  const client = mockClient({ fetch: async () => info(null) });
  const resolved = await resolveTaskContext(client, '123', {});
  assert.equal(resolved.taskContext.runtime, 'cloud');
});

test('an inherited workspace override wins over the project primary folder', async () => {
  const client = mockClient({ fetch: async url => url.includes('/project/list')
    ? Response.json({ downlink_body: { list_projects_downlink_body: { projects: [{ project_id: 'project', name: 'demo', status: 1,
      folders: [{ folder_device_id: 'current', workspace: '/tmp/primary', is_primary: true }] }], has_more: false } } })
    : info({ runtime_type: 2, local_device_id: 'current', local_app_id: currentApp().aid, workspace: '/tmp/override' }, 'project') });
  assert.equal((await resolveTaskContext(client, '123', {})).workspace, '/tmp/override');
  assert.equal((await resolveTaskContext(client, '123', { project: 'project' })).workspace, '/tmp/primary');
});
