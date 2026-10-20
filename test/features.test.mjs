import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions } from '../src/cli.mjs';
import { activeGoalFromExtra, encodeFeatureRequest, goalAvailability, parseFeatureJson, supportsGoalVersion } from '../src/features.mjs';
import { completionBody } from '../src/headless.mjs';
import { conversationExt } from '../src/protocol.mjs';

test('goal version support uses the observed minimum and rejects malformed versions', () => {
  for (const version of ['2.32.9', '2.31.99', '2.32', '2.32.10-beta', 'unknown', '']) {
    assert.equal(supportsGoalVersion(version), false, version);
  }
  for (const version of ['2.32.10', '2.32.11', '2.33.0', '3.0.0']) {
    assert.equal(supportsGoalVersion(version), true, version);
  }
});

test('goal availability avoids requests on old versions and reflects account enablement', async () => {
  let calls = 0;
  const client = { async json() { calls += 1; return { code: 0, data: { ab_results: { goal_mode_enable: '1' } } }; } };
  const oldVersion = await goalAvailability(client, '2.32.9');
  assert.equal(oldVersion.available, false);
  assert.equal(oldVersion.reason, 'unsupported_version');
  assert.equal(calls, 0);

  client.json = async () => { calls += 1; return { code: 0, data: { ab_results: { goal_mode_enable: '0' } } }; };
  const disabled = await goalAvailability(client, '2.32.10');
  assert.equal(disabled.available, false);
  assert.equal(disabled.reason, 'account_not_enabled');

  client.json = async () => { calls += 1; return { code: 0, data: { ab_results: { goal_mode_enable: '1' } } }; };
  assert.equal((await goalAvailability(client, '2.32.10')).available, true);
  assert.equal(calls, 2);

  client.json = async () => { calls += 1; return { code: 1, data: {} }; };
  await assert.rejects(goalAvailability(client, '2.32.10'), /could not be verified/u);
});

test('feature JSON preserves int64 job IDs without changing ordinary numbers or strings', () => {
  const parsed = parseFeatureJson('{"job_id":9223372036854775807,"status":2,"prompt":"9223372036854775807","nested":{"job_id":9007199254740993}}');
  assert.equal(parsed.job_id, '9223372036854775807');
  assert.equal(parsed.nested.job_id, '9007199254740993');
  assert.equal(parsed.status, 2);
  assert.equal(parsed.prompt, '9223372036854775807');
});

test('feature request encoding emits exact int64 ID tokens and preserves prompt strings', () => {
  const id = '9223372036854775807';
  const encoded = encodeFeatureRequest({ job_id: id, status: 2, prompt: id, enum_value: '1' });
  assert.match(encoded, /"job_id":9223372036854775807/u);
  assert.match(encoded, /"prompt":"9223372036854775807"/u);
  assert.match(encoded, /"status":2/u);
  assert.match(encoded, /"enum_value":"1"/u);
});

test('active goal state is optional, inherited when singular, and rejects conflicts', () => {
  assert.equal(activeGoalFromExtra({}), undefined);
  assert.equal(activeGoalFromExtra(JSON.stringify({ goal_info: { GoalInfo: {
    'goal-active': { Status: 'active' }, 'goal-done': { Status: 'completed' },
  } } })), 'goal-active');
  assert.throws(() => activeGoalFromExtra({ goal_info: { GoalInfo: {
    'goal-one': { Status: 'active' }, 'goal-two': { Status: 'active' },
  } } }), /multiple active goals/u);
});

test('desktop conversation extension encodes goal action and leaves work action unchanged', () => {
  const baseOptions = { skillPaths: [], sharedFolderPath: [], sandboxId: 'stable-sandbox' };
  const goal = conversationExt({ ndt: 9 }, 'local-message', '/workspace', { ...baseOptions, goalId: 'goal-uuid' });
  const goalTask = JSON.parse(goal.general_task_param);
  assert.equal(goalTask.action, 4);
  assert.deepEqual(goalTask.goal_param, { goal_id: 'goal-uuid' });
  assert.deepEqual(JSON.parse(goal.leading_accessory_tags), [{ tag: 'goal', display_text: '目标' }]);

  const work = conversationExt({ ndt: 9 }, 'local-message', '/workspace', baseOptions);
  const workTask = JSON.parse(work.general_task_param);
  assert.equal(workTask.action, 0);
  assert.equal('goal_param' in workTask, false);
  assert.equal('leading_accessory_tags' in work, false);
});

test('headless completion body encodes a verified goal and requires its ID', () => {
  const body = completionBody({ mode: 'goal', message: 'Plan this', goalId: 'goal-uuid', localMessageId: 'local-message' });
  assert.equal(body.option.agent_mode, 1);
  assert.equal(body.option.general_task_param.action, 4);
  assert.deepEqual(body.option.general_task_param.goal_param, { goal_id: 'goal-uuid' });
  assert.match(body.ext.leading_accessory_tags, /"tag":"goal"/u);
  assert.equal('message_specific_ext' in body.messages[0], false);
  assert.throws(() => completionBody({ mode: 'goal', message: 'Plan this' }), /requires a verified goal ID/u);
});

test('a new headless goal preserves project binding in both initialization fields', () => {
  const body = completionBody({ mode: 'goal', message: 'Plan this', goalId: 'goal-uuid',
    taskContext: { runtime: 'cloud', projectId: 'project-42' } });
  const expected = { need_ack_conversation: true, project_id: 'project-42' };
  assert.deepEqual(body.option.conversation_init_option, expected);
  assert.deepEqual(JSON.parse(body.ext.conversation_init_option), expected);
  assert.equal(body.option.general_task_param.action, 4);
  assert.equal(body.option.general_task_param.goal_param.goal_id, 'goal-uuid');
});

test('follow-up payloads carry a singular active goal without changing the turn action', () => {
  const taskContext = { activeGoalId: 'goal-active' };
  const headless = completionBody({ conversationId: '123456789012', message: 'Continue', taskContext });
  assert.equal(headless.option.active_goal_id, 'goal-active');
  assert.equal(headless.ext.active_goal_id, 'goal-active');
  assert.equal(headless.option.general_task_param.action, 0);

  const desktop = conversationExt({ ndt: 9 }, 'local-message', '/workspace', {
    skillPaths: [], sharedFolderPath: [], sandboxId: 'stable-sandbox', taskContext,
  });
  assert.equal(desktop.active_goal_id, 'goal-active');
  assert.equal(JSON.parse(desktop.general_task_param).action, 0);
});

test('goal mode parses on desktop, headless and the web alias, and rejects an empty message', () => {
  assert.equal(parseOptions(['--app', 'doubao', '--mode', 'goal', 'sessions', 'create', 'plan']).mode, 'goal');
  assert.equal(parseOptions(['headless', '--mode', 'goal', 'sessions', 'create', 'plan']).mode, 'goal');
  assert.equal(parseOptions(['web', '--mode', 'goal', 'sessions', 'create', 'plan']).platform, 'headless');
  assert.throws(() => parseOptions(['--app', 'doubao', '--mode', 'goal', 'sessions', 'create']), /requires a message/u);
  assert.throws(() => parseOptions(['headless', '--mode', 'goal', 'sessions', 'create']), /requires a message/u);
});

test('automation help and invalid command contracts stop in parsing before backend work', () => {
  const help = parseOptions(['--app', 'doubao', 'automations', 'create', '--help']);
  assert.deepEqual(help.helpPath, ['automations', 'create']);
  assert.throws(() => parseOptions(['--app', 'doubao', 'sessions', 'create', 'hello', '--file', '/no/such/file']), /--file is not valid/u);
  assert.throws(() => parseOptions(['--app', 'doubao', 'automations', 'get']), /requires exactly one task ID/u);
  assert.throws(() => parseOptions(['--app', 'doubao', 'automations', 'create']), /requires --file/u);
});
