import { sessionMetadata } from './session-metadata.mjs';
export { sessionMetadata } from './session-metadata.mjs';
import { randomUUID } from 'node:crypto';
import { listApiProjects, requestDeadline } from './list-services.mjs';
import { selectProject } from './context.mjs';

export const SESSION_ACTIONS = ['archive', 'unarchive', 'pin', 'unpin', 'rename', 'move'];

export function sessionMutationInput(action, id, value = '') {
  if (!SESSION_ACTIONS.includes(action)) throw new Error('Unknown session action');
  if (typeof id !== 'string' || !/^[1-9]\d{11,23}$/u.test(id)) throw new Error('conversation id must contain 12 to 24 digits');
  value = value.trim();
  if (action === 'rename' && !value) throw new Error('sessions rename requires a non-empty title');
  if (action === 'rename' && value.length > 20) throw new Error('Session title exceeds 20 characters');
  if (action === 'move' && !value) throw new Error('sessions move requires a project ID, exact name, or none');
  return { action, id, value };
}

async function readSession(client, id, timeoutMs) {
  const body = await client.imRequest('conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', {
    conversation_id: [id], option: { recent_message_count_per_conv: 0 }, ext: {},
  }, timeoutMs);
  const items = body?.batch_get_conv_info_downlink_body?.conversation_info_list;
  if (!Array.isArray(items)) throw new Error('Doubao conversation lookup returned an invalid response');
  const conversation = items.find(item => String(item?.conversation_id) === id);
  if (!conversation) throw new Error('Doubao conversation was not found');
  return conversation;
}

// Both transports use the official IM operations and confirm the saved state.
// Never retry a write: a lost response may already have changed the session.
export async function mutateApiSession(client, input, timeoutMs = 30_000) {
  const { action, id, value } = sessionMutationInput(input.action, input.id, input.value);
  const remaining = requestDeadline(timeoutMs);
  let desired;
  if (action === 'move') {
    desired = value === 'none' ? null : selectProject(await listApiProjects(client, remaining()), value).id;
  } else if (action === 'rename') desired = value;
  else desired = ['pin', 'archive'].includes(action);
  const field = action === 'move' ? 'projectId' : action === 'rename' ? 'title'
    : ['pin', 'unpin'].includes(action) ? 'pinned' : 'archived';
  const before = await readSession(client, id, remaining());
  remaining();
  const metadata = sessionMetadata(before);
  if (metadata[field] === desired) return { ...metadata, action, changed: false, verified: true };

  const operationId = randomUUID();
  let acknowledged = false;
  try {
    let response;
    if (action === 'rename') {
      response = await client.imRequest('conversation/update_name', 4150, 'update_conversation_name_uplink_body', {
        conversation_id: id, name: desired, conversation_type: before.conversation_type ?? 3,
      }, remaining());
    } else if (['pin', 'unpin'].includes(action)) {
      response = await client.imRequest('conversation/operate', 1120, 'operate_conv_uplink_body', {
        conversation_id: id, operate_type: desired ? 1 : 2, conversation_type: before.conversation_type ?? 3,
      }, remaining());
    } else if (['archive', 'unarchive'].includes(action)) {
      response = await client.imRequest('conversation/batch_operate', 1125, 'batch_operate_conv_uplink_body', {
        conversation_id_list: [id], operate_type: desired ? 8 : 9,
      }, remaining());
      const data = response?.batch_operate_conv_downlink_body;
      if (data?.has_failure || data?.conversation_list?.some(item => item.success !== true)) {
        throw new Error('Doubao did not archive/unarchive the conversation successfully');
      }
    } else {
      response = await client.imRequest('project/move_conversation', 4603, 'move_conversation_to_project_uplink_body', {
        client_request_id: operationId, conversation_id: id, target_project_id: desired ?? '',
      }, remaining());
      if (response?.move_conversation_to_project_downlink_body?.success === false) throw new Error('Doubao did not move the conversation');
    }
    acknowledged = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const after = sessionMetadata(await readSession(client, id, remaining()));
      remaining();
      if (after[field] === desired) return { ...after, action, changed: true, verified: true, operationId };
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, Math.min(100 * (attempt + 1), remaining())));
    }
    throw new Error('Saved session state does not match the requested change');
  } catch (cause) {
    const error = new Error(`Session ${action} ${acknowledged ? 'was acknowledged, but readback failed' : 'could not be confirmed'}: ${cause.message}. Inspect the session before retrying.`, { cause });
    error.code = acknowledged ? 'session_readback_failed' : 'session_change_unconfirmed';
    error.result = { conversationId: id, action, operationId, requested: { [field]: desired }, verified: false, status: 'unknown' };
    throw error;
  }
}
