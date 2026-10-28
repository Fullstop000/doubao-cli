import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { headlessProfilePaths } from './headless-state.mjs';
import { listHeadlessProjects, readHeadlessConversation, headlessEnterpriseSkill } from './headless-services.mjs';
import { DEFAULT_HEADLESS_PERMISSION } from './permissions.mjs';
import { parseConversationContext, selectTaskContext, selectProject, resolveContextValues, validateTaskOptions } from './task-context.mjs';

export async function resolveHeadlessTaskContext(client, conversationId, options = {}, { conversation, profile = 'default', timeoutMs = 10_000 } = {}) {
  validateTaskOptions(options);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw Object.assign(new Error('Headless context lookup timed out'), { code: 'timeout' }); return ms; };
  const previous = parseConversationContext(conversation ?? (conversationId ? await readHeadlessConversation(client, conversationId, remaining()) : undefined));
  const selection = selectTaskContext(previous, options, {
    newConversation: !conversationId, defaultRuntime: 'cloud', defaultPermission: DEFAULT_HEADLESS_PERMISSION,
  });
  const project = selection.projectValue && selection.projectValue !== 'none'
    ? selectProject(await listHeadlessProjects(client, remaining()), selection.projectValue) : null;
  const resolved = resolveContextValues(previous, options, { selection, project,
    device: { id: client.device.device_id, name: os.hostname() },
    defaultWorkspace: () => path.join(headlessProfilePaths({ profile }).directory, 'workspaces', randomUUID()) });
  if (options.enterpriseKnowledge) resolved.taskContext.enterpriseSkill = await headlessEnterpriseSkill(client, selection.runtime, remaining());
  return resolved;
}
