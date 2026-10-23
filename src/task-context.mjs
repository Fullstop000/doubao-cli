import path from 'node:path';
import { activeGoalFromExtra } from './features.mjs';
import { taskPermission } from './permissions.mjs';

function contextObject(value) {
  if (value == null || value === '') return {};
  try { value = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error('Doubao conversation execution context is invalid'); }
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Doubao conversation execution context is invalid');
  return value;
}

export function parseConversationContext(conversation) {
  const extra = contextObject(conversation?.conv_extra ?? conversation?.extra ?? conversation?.ext);
  const agentParam = extra.agent_task_param == null ? null : contextObject(extra.agent_task_param);
  if (agentParam?.runtime_type !== undefined && ![1, 2].includes(agentParam.runtime_type)) {
    throw new Error('Doubao conversation execution context has an invalid runtime');
  }
  return { extra, agentParam, projectId: String(conversation?.project_reference?.project_id || ''), activeGoalId: activeGoalFromExtra(extra) };
}

export function validateTaskOptions(options) {
  if (options.runtime !== undefined && !['local', 'cloud'].includes(options.runtime)) throw new Error('--runtime requires local or cloud');
  if (options.runtime === 'cloud' && hasLocalOptions(options)) {
    throw new Error('--runtime cloud cannot use --mcp, --workspace, --permission, or --no-skills');
  }
}

function hasLocalOptions(options) {
  return Boolean(options.mcps?.length || options.workspace || options.permission || options.noSkills || options.skillPaths?.length === 0);
}

export function selectTaskContext(previous, options, { newConversation, defaultRuntime, defaultPermission }) {
  validateTaskOptions(options);
  const runtime = options.runtime || (hasLocalOptions(options) ? 'local' : newConversation ? defaultRuntime
    : previous.agentParam?.runtime_type === 2 ? 'local' : 'cloud');
  return { runtime, permission: runtime === 'local' ? taskPermission(options.permission, previous.agentParam, defaultPermission) : undefined,
    projectValue: options.project ?? previous.projectId };
}

export function selectProject(projects, value) {
  if (!value || value === 'none') return null;
  const byId = projects.find(p => p.id === value);
  if (byId) return byId;
  const matches = projects.filter(p => p.name === value);
  if (matches.length > 1) throw new Error(`Multiple projects named "${value}"; use a project id`);
  if (!matches.length) throw new Error(`Doubao project not found: ${value}. Run "doubao projects list"`);
  return matches[0];
}

export function projectContext(project, deviceId, runtime) {
  if (!project) return {};
  return { project_id: project.id, project_name: project.name,
    folders: runtime === 'local' ? project.folders.filter(f => f.deviceId === deviceId && f.path?.trim())
      .map(f => ({ folder_name: f.name?.trim() || '', path: f.path.trim(), is_primary: f.primary })) : [] };
}

export function resolveContextValues(previous, options, { selection, project, device = {}, defaultWorkspace }) {
  const { runtime, permission } = selection;
  const prior = previous.agentParam;
  // Desktop identity includes the app; the Headless profile owns its device ID.
  const sameDevice = prior?.local_device_id === device.id && (!device.appId || prior?.local_app_id === device.appId);
  if (runtime === 'local' && !device.id) throw new Error('Doubao local device identity is unavailable');
  if (runtime === 'local' && prior?.runtime_type === 2 && !sameDevice && !options.runtime) {
    throw new Error('This session uses another local device/app; pass --runtime local or --runtime cloud explicitly');
  }
  const projectId = project?.id || '', projectChanged = projectId !== previous.projectId;
  const context = projectContext(project, device.id || '', runtime);
  const selectedWorkspace = options.workspace
    || (options.project === undefined && !projectChanged && sameDevice ? prior?.workspace : '')
    || context.folders?.find(f => f.is_primary)?.path || context.folders?.[0]?.path;
  const createWorkspace = runtime === 'local' && !selectedWorkspace;
  const workspace = runtime === 'local' ? path.resolve(selectedWorkspace || defaultWorkspace()) : undefined;
  return { workspace, createWorkspace, permission, taskContext: { runtime, projectId, projectContext: context,
    previousAgentParam: prior, previousProjectId: previous.projectId, activeGoalId: previous.activeGoalId,
    deviceId: device.id || '', deviceName: device.name || '' } };
}
