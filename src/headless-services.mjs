import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { projectCreationInput } from './context.mjs';
import { normalizeUsage } from './usage.mjs';
import { normalizeProfileAccount } from './profiles.mjs';

const CONVERSATION_ID = /^\d{12,24}$/u;
const ACCOUNT_ID = /^[1-9]\d{5,24}$/u;
const REASONING_EFFORTS = new Set(['3', '4', '5', '6', '7']);

function requestDeadline(timeoutMs) {
  const duration = Number(timeoutMs);
  const deadline = Date.now() + (Number.isFinite(duration) ? Math.max(0, duration) : 0);
  return () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw serviceError('Headless request timed out', 'timeout');
    return remaining;
  };
}

function assertConversationId(id) {
  if (!CONVERSATION_ID.test(String(id))) throw new Error('Invalid conversation id');
  return String(id);
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function serviceError(message, code) {
  return Object.assign(new Error(message), { code });
}

export async function listHeadlessProjects(client, timeoutMs = 10_000) {
  if (typeof client?.imRequest !== 'function') throw new TypeError('headless project client must provide imRequest()');
  const remaining = requestDeadline(timeoutMs);
  const projects = new Map();
  const cursors = new Set();
  let cursor;
  do {
    const body = await client.imRequest('project/list', 4605, 'list_projects_uplink_body', {
      limit: 100,
      include_invisible_projects: false,
      sort_type: 1,
      group_conversation_filter_param: { exclude_archive: true },
      ...(cursor ? { cursor } : {}),
    }, remaining());
    const page = body?.list_projects_downlink_body;
    if (!Array.isArray(page?.projects)) throw serviceError('Doubao project list could not be read', 'project_list_invalid');
    for (const project of page.projects) {
      if (project?.status !== 1 || project.project_id === undefined || project.project_id === null) continue;
      projects.set(String(project.project_id), {
        id: String(project.project_id),
        name: project.name,
        folders: (Array.isArray(project.folders) ? project.folders : []).map(folder => ({
          name: folder.folder_name,
          path: folder.workspace,
          deviceId: String(folder.folder_device_id || ''),
          deviceName: folder.folder_device_name,
          primary: Boolean(folder.is_primary),
        })),
      });
    }
    if (!page.has_more) break;
    if (typeof page.next_cursor !== 'string' || !page.next_cursor || cursors.has(page.next_cursor)) {
      throw serviceError('Doubao project pagination did not advance', 'project_pagination_invalid');
    }
    cursor = page.next_cursor;
    cursors.add(cursor);
  } while (true);
  return [...projects.values()];
}

export async function createHeadlessProject(client, { name, workspace, deviceId, deviceName } = {}, timeoutMs = 30_000) {
  if (typeof client?.imRequest !== 'function') throw new TypeError('headless project client must provide imRequest()');
  const remaining = requestDeadline(timeoutMs);
  const input = projectCreationInput(name, workspace);
  if (input.workspace && (typeof deviceId !== 'string' || !deviceId.trim())) {
    throw new Error('Creating a project with a workspace requires a verified local device id');
  }
  const operationId = randomUUID();
  const folders = input.workspace ? [{
    folder_name: path.basename(input.workspace) || input.workspace,
    workspace: input.workspace,
    is_primary: true,
    folder_device_id: deviceId,
    ...(deviceName ? { folder_device_name: deviceName } : {}),
  }] : [];
  let id;
  try {
    const response = await client.imRequest('project/create', 4600, 'create_project_uplink_body', {
      client_request_id: operationId,
      name: input.name,
      instruction: '',
      folders,
    }, remaining());
    const project = response?.create_project_downlink_body?.project;
    const projectId = project?.project_id ?? project?.projectId;
    if (projectId !== undefined && projectId !== null && String(projectId)) id = String(projectId);
    if (!id) throw new Error('Create project response has no project id');
    const confirmed = (await listHeadlessProjects(client, remaining())).find(project => project.id === id);
    if (!confirmed || confirmed.name !== input.name || (input.workspace
      ? !confirmed.folders.some(folder => folder.path === input.workspace && folder.deviceId === deviceId && folder.primary)
      : confirmed.folders.length > 0)) {
      throw new Error('Project name or folder binding could not be confirmed');
    }
    return { ...confirmed, operationId, verified: true };
  } catch (cause) {
    const error = new Error(`${id ? `Project ${id} was created, but readback failed` : 'Project creation could not be confirmed'}: ${cause.message}. Check "doubao projects list" before repeating create.`, { cause });
    error.code = cause?.code === 'timeout' ? 'timeout' : id ? 'project_readback_failed' : 'project_create_unconfirmed';
    error.result = { id: id || null, name: input.name, operationId, status: id ? 'created' : 'unknown', verified: false };
    throw error;
  }
}

export async function headlessEnterpriseSkill(client, runtime, timeoutMs = 15_000) {
  if (!['local', 'cloud'].includes(runtime)) throw new Error('Enterprise skill runtime must be local or cloud');
  if (typeof client?.json !== 'function') throw new TypeError('headless skill client must provide json()');
  const response = await client.json('/alice/office/skills/list_user_and_featured', {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime_type: runtime === 'local' ? 2 : 1 }),
  });
  if (!response || (response.code !== undefined && response.code !== 0) || !Array.isArray(response.data?.skills)) {
    throw serviceError('Doubao skill catalog could not be read', 'skill_catalog_unavailable');
  }
  const skill = response.data.skills.find(item => item?.name === 'doubao-enterprise-search' && item.visible !== false);
  if (!skill?.external_skill_id || !skill.type) {
    throw serviceError('企业知识 is unavailable for this account/runtime', 'enterprise_skill_unavailable');
  }
  return {
    name: skill.name,
    displayName: skill.display_name,
    type: skill.type,
    externalId: skill.external_skill_id,
  };
}

export async function readHeadlessUsage(client, timeoutMs = 15_000) {
  if (typeof client?.json !== 'function') throw new TypeError('headless usage client must provide json()');
  const response = await client.json('/alice/commerce/sale/subscription/quota/summary/', {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_line: 'membership' }),
  });
  return normalizeUsage(response);
}

export async function readHeadlessConversation(client, id, timeoutMs = 10_000) {
  const conversationId = assertConversationId(id);
  if (typeof client?.imRequest !== 'function') throw new TypeError('headless conversation client must provide imRequest()');
  const body = await client.imRequest('conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', {
    conversation_id: [conversationId],
    option: { recent_message_count_per_conv: 0 },
    ext: {},
  }, timeoutMs);
  const conversations = body?.batch_get_conv_info_downlink_body?.conversation_info_list;
  if (!Array.isArray(conversations)) throw serviceError('Doubao conversation lookup returned an invalid response', 'conversation_lookup_invalid');
  const conversation = conversations.find(item => String(item?.conversation_id) === conversationId);
  if (!conversation) throw serviceError('Doubao conversation was not found', 'conversation_not_found');
  return conversation;
}

/** Read only account metadata for caller-supplied cached identities. */
export async function headlessProfileMetadata(client, ids, timeoutMs = 15_000) {
  const empty = incompleteReason => ({ accounts: {}, incompleteReason });
  if (typeof client?.json !== 'function' || typeof client?.account !== 'function') {
    throw new TypeError('headless profile metadata client must provide json() and account()');
  }
  if (!Array.isArray(ids)) throw new TypeError('profile ids must be an array of strings');
  const requested = [...new Set(ids.filter(id => typeof id === 'string' && ACCOUNT_ID.test(id)))];
  const invalidInput = requested.length !== new Set(ids).size;
  if (!requested.length) return empty(invalidInput ? 'invalid_profile_ids' : null);
  const remaining = requestDeadline(timeoutMs);
  const expectedActiveId = typeof client.accountId === 'string' && ACCOUNT_ID.test(client.accountId) ? client.accountId : '';
  if (!expectedActiveId) return empty('account_identity_unavailable');

  const pinnedAccount = async () => {
    const current = await client.account({ timeoutMs: remaining() });
    if (current?.accountId !== expectedActiveId || client.accountId !== expectedActiveId) {
      throw serviceError('Headless account changed during profile metadata lookup', 'account_changed');
    }
  };
  try {
    await pinnedAccount();
    const response = await client.json('/alice/profile/multi', {
      method: 'POST',
      timeoutMs: remaining(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visit_ids: requested }),
    });
    await pinnedAccount();
    const datas = response?.datas;
    if (response?.code !== 0 || !datas || typeof datas !== 'object' || Array.isArray(datas)) {
      return empty('account_lookup_failed');
    }
    const accounts = {};
    let incomplete = invalidInput;
    for (const id of requested) {
      const profile = datas[id]?.profile_brief;
      // IDs are protocol strings. Reject numeric or mismatched entity ids so
      // large account identifiers can never be rounded and relabeled.
      if (!profile || typeof profile.entity_id !== 'string' || profile.entity_id !== id) {
        incomplete = true;
        continue;
      }
      const account = normalizeProfileAccount(profile);
      if (!account || account.id !== id) {
        incomplete = true;
        continue;
      }
      accounts[id] = account;
    }
    return { accounts, incompleteReason: incomplete ? 'incomplete_account_metadata' : null };
  } catch (error) {
    if (error?.code === 'timeout' || ['AbortError', 'TimeoutError'].includes(error?.name)) {
      throw serviceError('Headless request timed out', 'timeout');
    }
    if (error?.code === 'account_changed' || error?.message?.includes('PROFILE_ACCOUNT_CHANGED')) return empty('account_changed');
    if (error?.code === 'login_required') throw error;
    return empty('account_lookup_failed');
  }
}

export async function modifyHeadlessModel(client, conversationId, modelId, reasoningEffort, timeoutMs = 10_000) {
  const id = assertConversationId(conversationId);
  if (typeof client?.imRequest !== 'function') throw new TypeError('headless model client must provide imRequest()');
  const remaining = requestDeadline(timeoutMs);
  if ((typeof modelId !== 'string' && typeof modelId !== 'number') || !String(modelId).trim() || /[\r\n]/u.test(String(modelId))) {
    throw new Error('A model id is required');
  }
  const effort = String(reasoningEffort ?? '5');
  if (!REASONING_EFFORTS.has(effort)) throw new Error('Reasoning effort must be 3, 4, 5, 6, or 7');
  const selectedModel = String(modelId);
  await client.imRequest('conversation/modify', 1114, 'modify_conversation_uplink_body', {
    conversation_id: id,
    conversation_type: 3,
    bot_conversation_type: 3,
    mode_id: '3',
    model_item_key: selectedModel,
    reasoning_effort: effort,
  }, remaining());
  const conversation = await readHeadlessConversation(client, id, remaining());
  const extra = jsonObject(conversation.extra || conversation.ext);
  const actualModel = extra.model_item_key == null ? null : String(extra.model_item_key);
  const actualEffort = extra.reasoning_effort == null ? null : String(extra.reasoning_effort);
  if (actualModel !== selectedModel || actualEffort !== effort) {
    throw serviceError('Doubao did not confirm the requested model and reasoning settings', 'model_setting_unconfirmed');
  }
  return { conversationId: id, modelId: actualModel, reasoningEffort: actualEffort, changed: true };
}
