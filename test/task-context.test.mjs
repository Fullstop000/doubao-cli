import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConversationContext, selectTaskContext, resolveContextValues } from '../src/task-context.mjs';
import { resolveHeadlessTaskContext } from '../src/headless-context.mjs';
import { taskPermission } from '../src/permissions.mjs';

const project = { id: 'new', name: 'New project', folders: [
  { deviceId: 'mine', name: 'other', path: '/foreign', primary: true },
  { deviceId: 'current', name: 'code', path: '/project', primary: true },
] };
const local = { runtime_type: 2, sandbox_auth_type: 1, local_device_id: 'current', local_app_id: 'app', workspace: '/saved' };
const previous = (agent = local, projectId = '') => parseConversationContext({ extra: { agent_task_param: agent }, project_reference: { project_id: projectId } });
const platforms = [
  { name: 'Desktop', defaultRuntime: 'local', defaultPermission: 'FullAccess', device: { id: 'current', appId: 'app' } },
  { name: 'Headless', defaultRuntime: 'cloud', defaultPermission: 'AskOnRisk', device: { id: 'current' } },
];
function resolve(policy, prior, options = {}, selectedProject = null, newConversation = false) {
  const selection = selectTaskContext(prior, options, { ...policy, newConversation });
  return resolveContextValues(prior, options, { selection, project: selectedProject, device: policy.device, defaultWorkspace: () => '/generated' });
}

for (const policy of platforms) {
  test(`${policy.name}: defaults stay platform-specific; saved runtime and permission win on follow-up`, () => {
    const fresh = resolve(policy, parseConversationContext(), {}, null, true);
    assert.equal(fresh.taskContext.runtime, policy.defaultRuntime);
    assert.equal(fresh.permission, policy.defaultRuntime === 'local' ? policy.defaultPermission : undefined);
    assert.equal(resolve(policy, parseConversationContext(), { runtime: 'local' }, null, true).permission, policy.defaultPermission);
    for (const [permission, code] of [['AlwaysAsk', 0], ['AskOnRisk', 1], ['FullAccess', 2]]) {
      const result = resolve(policy, previous({ ...local, sandbox_auth_type: code }));
      assert.equal(result.permission, permission); assert.equal(result.workspace, '/saved');
      assert.equal(resolve(policy, previous({ ...local, sandbox_auth_type: code }), { permission: 'ask-on-risk' }).permission, 'AskOnRisk');
    }
    const cloud = resolve(policy, previous({ runtime_type: 1 }));
    assert.equal(cloud.taskContext.runtime, 'cloud'); assert.equal(cloud.permission, undefined); assert.equal(cloud.workspace, undefined);
  });
  test(`${policy.name}: project switch, clear and explicit reselection discard old workspace`, () => {
    for (const value of ['new', 'New project']) {
      const result = resolve(policy, previous(local, 'old'), { project: value }, project);
      assert.equal(result.workspace, '/project'); assert.equal(result.taskContext.projectId, 'new');
      assert.deepEqual(result.taskContext.projectContext.folders.map(f => f.path), ['/project']);
    }
    const clear = resolve(policy, previous(local, 'old'), { project: 'none' });
    assert.equal(clear.workspace, '/generated'); assert.equal(clear.createWorkspace, true); assert.equal(clear.taskContext.projectId, '');
    assert.equal(resolve(policy, previous(local, 'new'), {}, project).workspace, '/saved');
    assert.equal(resolve(policy, previous(local, 'new'), { project: 'new' }, project).workspace, '/project');
    assert.equal(resolve(policy, previous(), { workspace: '/explicit', project: 'new' }, project).workspace, '/explicit');
  });
  test(`${policy.name}: foreign devices require an explicit runtime and cannot donate a workspace`, () => {
    const foreign = previous({ ...local, local_device_id: 'foreign' });
    for (const options of [{}, { workspace: '/explicit' }, { permission: 'AskOnRisk' }]) {
      assert.throws(() => resolve(policy, foreign, options), /another local device/u);
    }
    assert.equal(resolve(policy, foreign, { runtime: 'local' }).workspace, '/generated');
    assert.equal(resolve(policy, foreign, { runtime: 'cloud' }).workspace, undefined);
  });
  test(`${policy.name}: cloud removes local folders and local options cannot be silently ignored`, () => {
    const cloud = resolve(policy, previous(), { runtime: 'cloud' }, project);
    assert.deepEqual(cloud.taskContext.projectContext.folders, []);
    assert.equal(cloud.permission, undefined);
    assert.throws(() => resolve(policy, previous(), { runtime: 'cloud', noSkills: true }), /cannot use/u);
    assert.equal(resolve(policy, previous({ runtime_type: 1 }), { noSkills: true }).taskContext.runtime, 'local');
  });
}

test('Desktop requires app identity as well as device identity; Headless device IDs are profile-owned', () => {
  const prior = previous({ ...local, local_app_id: 'another-app' });
  assert.throws(() => resolve(platforms[0], prior), /another local device/u);
  assert.equal(resolve(platforms[1], prior).workspace, '/saved');
});

test('saved context accepts string/object forms and legacy null, but malformed execution metadata fails closed', () => {
  for (const extra of [{ agent_task_param: local }, JSON.stringify({ agent_task_param: JSON.stringify(local) })]) {
    assert.deepEqual(parseConversationContext({ extra }).agentParam, local);
    assert.deepEqual(parseConversationContext({ conv_extra: extra }).agentParam, local);
  }
  assert.equal(selectTaskContext(parseConversationContext({ extra: { agent_task_param: 'null' } }), {}, { newConversation: false }).runtime, 'cloud');
  for (const extra of ['broken', { agent_task_param: 'broken' }, { agent_task_param: [] }, { agent_task_param: { runtime_type: 99 } }]) {
    assert.throws(() => parseConversationContext({ extra }), /execution context/u);
  }
  assert.throws(() => taskPermission(undefined, { ...local, sandbox_auth_type: 99 }, 'FullAccess'), /invalid permission/u);
  assert.equal(taskPermission('AskOnRisk', { ...local, sandbox_auth_type: 99 }, 'FullAccess'), 'AskOnRisk');
});

test('Headless context adapter resets old project workspace without starting a local executor', async () => {
  const calls = [];
  const client = { device: { device_id: 'current' }, async imRequest(...args) {
    calls.push(args);
    return { list_projects_downlink_body: { projects: [{ project_id: 'new', name: 'New project', status: 1,
      folders: [{ folder_device_id: 'current', workspace: '/project', is_primary: true }] }], has_more: false } };
  } };
  const conversation = { extra: { agent_task_param: local }, project_reference: { project_id: 'old' } };
  const changed = await resolveHeadlessTaskContext(client, 'existing', { project: 'new' }, { conversation });
  assert.equal(changed.workspace, '/project'); assert.equal(changed.permission, 'AskOnRisk');
  const cleared = await resolveHeadlessTaskContext(client, 'existing', { project: 'none' }, { conversation });
  assert.notEqual(cleared.workspace, '/saved'); assert.equal(cleared.taskContext.projectId, '');
  assert.ok(calls.every(([route]) => route === 'project/list'));
});
