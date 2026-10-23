import { sessionRuntime } from './session-runtime.mjs';

export function requestDeadline(timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  return () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw serviceError('Doubao request timed out', 'timeout');
    return remaining;
  };
}

function serviceError(message, code) {
  return Object.assign(new Error(message), { code });
}

export async function listApiSessions(client, { limit = 20, all = false, timeoutMs = 10_000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Session limit must be from 1 to 100');
  const remaining = requestDeadline(timeoutMs);
  const sessions = new Map(), cursors = new Set(['0:0']);
  let cursor = 0, pinType = 0, pages = 0;
  const requestPage = async request => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.imRequest('chain/recent_conv', 3200, 'pull_recent_conv_chain_uplink_body', request, remaining());
      } catch (error) {
        if (attempt >= 2 || error.code !== 'request_rejected' || !error.message.includes('(712010702)')) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(remaining(), 100 * 2 ** attempt)));
      }
    }
  };
  while (true) {
    const result = await requestPage({
      limit: all ? 100 : Math.min(limit, 100), api_version: 1, conv_version: cursor, direction: cursor ? 1 : 3,
      option: { not_need_message: true, need_complete_conversation: true,
        need_coco_conversation: cursor === 0, need_coco_bot: cursor === 0,
        // Without the PC chain, the cursor skips most Work conversations.
        need_pc_pin_chain: true, pc_pin_query_type: pinType },
    });
    remaining();
    pages++;
    const data = result?.pull_recent_conv_chain_downlink_body;
    if (!Array.isArray(data?.cells) || typeof data.has_more !== 'boolean') {
      throw serviceError('Doubao session list is unavailable', 'session_list_invalid');
    }
    for (const cell of data.cells) {
      const conversation = cell?.conversation;
      const id = conversation?.conversation_id;
      if (!/^[1-9]\d{11,23}$/u.test(id || '') || sessions.has(id)) continue;
      sessions.set(id, { id, title: conversation.name, runtime: sessionRuntime(conversation), updatedAt: conversation.update_time });
    }
    if (!data.has_more || !all && sessions.size >= limit) {
      return { source: 'api', complete: !data.has_more && (all || sessions.size <= limit), sessions: [...sessions.values()].slice(0, all ? undefined : limit),
        hasMore: data.has_more || !all && sessions.size > limit, pages };
    }
    const next = data.next_conv_version;
    const numeric = typeof next === 'string' && /^\d+$/u.test(next) || typeof next === 'number';
    const nextCursor = numeric ? Number(next) : NaN;
    // Works carries this phase alongside the cursor: pinned (0), then unpinned (1).
    const nextPinType = data.extra?.pc_pin_query_type ?? pinType;
    const key = `${nextPinType}:${nextCursor}`;
    if (![0, 1].includes(nextPinType) || nextPinType < pinType || !Number.isSafeInteger(nextCursor) || nextCursor < 0
      || cursors.has(key) || nextPinType === pinType && (!nextCursor || cursor && nextCursor >= cursor)) {
      throw serviceError('Doubao session pagination did not advance', 'session_pagination_invalid');
    }
    cursors.add(key);
    cursor = nextCursor;
    pinType = nextPinType;
  }
}

export async function listApiProjects(client, timeoutMs = 10_000) {
  if (typeof client?.imRequest !== 'function') throw new TypeError('project list client must provide imRequest()');
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
    remaining();
    const page = body?.list_projects_downlink_body;
    if (!Array.isArray(page?.projects) || typeof page.has_more !== 'boolean') throw serviceError('Doubao project list could not be read', 'project_list_invalid');
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
