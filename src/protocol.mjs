import { currentApp, agentWorkspace } from './app.mjs';
// Protocol-direct messaging: issues chat/completion requests inside the
// authenticated Doubao renderer, where the webmssdk fetch hook transparently
// attaches msToken / a_bogus / x-helios / x-medusa and cookies, so the request
// is indistinguishable from the app's own traffic. This avoids DOM-driven
// composer automation and UI-state timing entirely.

import os from 'node:os';
import { resolvePermission } from './permissions.mjs';

const HOME = os.homedir();

const CHAT_URL = 'https://api5-normal-gl.doubao.com/chat/completion';
const MODIFY_URL = 'https://www.doubao.com/im/conversation/modify';
const BOT_ID = '7338286299411103781';
export const CONNECTOR_API_BASE = 'https://www.doubao.com/alice/office/skills/manage/connector';

// Read only the common, non-secret request parameters from this renderer.
// Never copy signature/token fields or use another application's device ids.
export async function runtimeParameters(client) {
  const runtime = await evaluateWithWatchdog(client, `(async () => {
    const keys = ['aid', 'real_aid', 'channel', 'chromium_version', 'client_platform',
      'device_id', 'device_platform', 'doubao_device_platform', 'doubao_pc_version',
      'fp', 'language', 'pc_version', 'pkg_type', 'region', 'runtime', 'runtime_version',
      'samantha_web', 'sys_region', 'tea_uuid', 'tz_name', 'use-olympus-account',
      'version_code', 'web_id', 'web_platform', 'web_tab_id'];
    const entry = performance.getEntriesByType('resource').slice().reverse().find(entry => {
      try { const u = new URL(entry.name); return u.origin === 'https://www.doubao.com'
        && u.pathname.startsWith('/im/') && u.searchParams.has('device_id') && u.searchParams.has('aid'); }
      catch { return false; }
    });
    if (!entry) throw new Error('Doubao runtime parameters are not ready; open a chat and retry');
    const source = new URL(entry.name).searchParams;
    const params = Object.fromEntries(keys.filter(key => source.has(key)).map(key => [key, source.get(key)]));
    const runtime = await window.neotix.taskMode.runtime.queryRuntimeInfo({ env: true });
    return { params, clientEnvId: runtime?.env?.environmentId || '' };
  })()`, 10_000);
  if (runtime?.params?.aid !== currentApp().aid || !runtime.params.device_id) {
    throw new Error(`Runtime identity does not match ${currentApp().name}`);
  }
  return { ...runtime, query: new URLSearchParams(runtime.params).toString() };
}

// Model is a conversation-level setting (POST im/conversation/modify, cmd=1114).
// key = model_item_key; ndt = need_deep_think in the chat body; provider =
// aggregate_params.provider_id. Values captured from live traffic.
export const MODEL_PROTOCOL = new Map([
  ['auto', { key: '9', ndt: 9, provider: '' }],
  ['doubao-2.1-turbo', { key: '4', ndt: 4, provider: '' }],
  ['doubao-2.1-pro', { key: '5', ndt: 5, provider: '' }],
  ['orange-5.0', { key: '6', ndt: 4, provider: '' }],
  ['gemini-3.7-flash', { key: '1946880770', ndt: 10001, provider: 'cis' }],
  ['gpt-5.6-sol', { key: '2123520258', ndt: 10001, provider: 'cis' }],
]);

export function modelProtocol(modelId) {
  return MODEL_PROTOCOL.get(modelId) || MODEL_PROTOCOL.get('auto');
}

// The create-conversation handshake requires a complete top-level `ext` plus
// `user_context`; omitting either silently merges the message into the current
// conversation instead of creating one.
export function conversationExt(model, localMessageId, workspace, options = {}) {
  const skillPaths = options.skillPaths || [`${HOME}/${currentApp().name}/skills`, `${HOME}/.agents/skills`];
  const sandboxAuthType = resolvePermission(options.permission);
  const gtp = {
    action: 0,
    thread_local_message_id: [localMessageId],
    client_option: {
      enable_sandbox: true,
      os: 'Mac',
      shared_folder_path: options.sharedFolderPath || [workspace, agentWorkspace()],
      agent_workspace: {
        agent_workspace: agentWorkspace(),
        local_skill_paths: skillPaths,
      },
      client_env_id: options.clientEnvId || '',
      sandbox_id: options.sandboxId || `route-${crypto.randomUUID()}`,
      workspace,
      sandbox_auth_type: sandboxAuthType,
    },
    runtime_type: 2,
    agent_task_param: {
      runtime_type: 2,
      sandbox_auth_type: sandboxAuthType,
      device_name: os.hostname(),
      folder_name: '',
      local_app_id: currentApp().aid,
      local_device_id: options.deviceId || '',
      workspace,
    },
    // MCP follow-ups apply this turn's permission even when the UI has stale state.
    agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: Boolean(options.updatePermission) },
    need_modify_conversation: Boolean(options.updatePermission),
    task_input_json: JSON.stringify({
      agents_md: { files: [], state: 2 },
      schema_version: 1,
      home_dir: HOME,
      project_context: {},
      localConnectors: options.localConnectors || [],
    }),
  };
  return {
    general_task_param: JSON.stringify(gtp),
    use_deep_think: String(model.ndt),
    agent_mode: '1',
    sub_conv_firstmet_type: '1',
    collection_id: '',
    is_finish: '1',
    conversation_init_option: '{"need_ack_conversation":true}',
    commerce_credit_config_enable: '0',
  };
}

// SSE stream reducer. Injected into the renderer via Function#toString, so it
// must not reference anything outside its own scope. Mutates state and returns
// 'stop' when the stream should be terminated early.
export function reduceStreamEvent(state, event, data, options) {
  if (event === 'SSE_ACK') {
    state.conversationId = data?.ack_client_meta?.conversation_id || state.conversationId;
    return options.waitForReply ? null : 'stop';
  }
  if (event === 'STREAM_CHUNK') {
    for (const op of data.patch_op || []) {
      for (const block of op.patch_value?.content_block || []) {
        if (block.block_type === 10000 && block.content?.text_block?.text) {
          state.answer += block.content.text_block.text;
        }
        if (block.block_type === 10040 && block.content?.thinking_block?.content) {
          state.thinking += block.content.thinking_block.content;
        }
      }
    }
    return null;
  }
  if (event === 'SSE_REPLY_END') {
    if (data.end_type === 1 && data.msg_finish_attr?.brief) {
      state.answer = data.msg_finish_attr.brief;
      state.completed = true;
    }
    if (data.end_type === 3) {
      state.completed = true;
      return 'stop';
    }
    return null;
  }
  if (event === 'STREAM_ERROR') {
    state.failed = { error: data.error_code || 'stream_error', detail: data.error_msg || '' };
    return 'stop';
  }
  return null;
}

// Evaluated inside the chat page. Returns
// { conversationId, answer, thinking } or { error, detail }.
const SEND_EXPRESSION = `(async () => {
  const reduceStreamEvent = %REDUCER%;
  const args = %ARGS%;
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), args.timeoutMs);
  const state = {
    conversationId: args.conversationId || '',
    answer: '',
    thinking: '',
    completed: false,
    failed: null,
  };
  try {
    const localMessageId = args.localMessageId || crypto.randomUUID();
    const body = {
      client_meta: {
        local_conversation_id: args.localConversationId || ('local_' + Date.now()),
        conversation_id: args.conversationId || '',
        bot_id: args.botId,
        last_section_id: '',
        last_message_index: null,
      },
      messages: [{
        local_message_id: localMessageId,
        content_block: [{
          block_type: 10000,
          content: { text_block: { text: args.message } },
          block_id: crypto.randomUUID(),
        }],
        message_status: 0,
      }],
      option: {
        create_time_ms: Date.now(),
        agent_mode: 1,
        need_deep_think: args.model.ndt,
        unique_key: crypto.randomUUID(),
        need_create_conversation: !args.conversationId,
        is_old_user: true,
        message_from: 0,
        sse_recv_event_options: { support_chunk_delta: true },
        conversation_init_option: !args.conversationId ? { need_ack_conversation: true } : undefined,
        conversation_init_ext: !args.conversationId
          ? { model_item_key: args.model.key, reasoning_effort: args.reasoningEffort || '5', mode_id: '3' }
          : undefined,
        model_config: args.reasoningEffort
          ? { model_item_key: args.model.key, reasoning_effort: Number(args.reasoningEffort) }
          : undefined,
        aggregate_params: (args.model.provider || args.reasoningEffort)
          ? {
            provider_id: args.model.provider || '',
            ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
          }
          : undefined,
      },
    };
    if (args.ext) {
      args.ext.general_task_param = args.ext.general_task_param.replace(
        '%LOCAL_MESSAGE_ID%', localMessageId);
      body.ext = args.ext;
      body.user_context = [];
    }
    const resp = await fetch(args.url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) return { error: resp.status, detail: (await resp.text()).slice(0, 300) };
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const trace = [];
    let reconciled = false;
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\\n\\n')) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const eventLine = chunk.split('\\n').find((line) => line.startsWith('event:'));
        const raw = chunk.split('\\n').filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim()).join('');
        if (!raw) continue;
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        const event = eventLine ? eventLine.slice(6).trim() : '';
        if (args.debug) {
          trace.push({ event, data: raw.slice(0, 600) });
          if (trace.length > 80) trace.shift();
        }
        if (reduceStreamEvent(state, event, data, args) === 'stop') break outer;
        // A provisioned sandbox starts out bound to the local conversation
        // id; once the server assigns the real id, bind it or local tool
        // calls fail with sandbox_profile_conversation_id_missing.
        if (args.sandboxId && event === 'SSE_ACK' && state.conversationId && !reconciled) {
          reconciled = true;
          const step = (name) => { if (args.debug) trace.push({ event: 'RECONCILE_STEP', data: name }); };
          try {
            await Promise.race([
              (async () => {
                step('push');
                // The chunk id must be unique per push: webpack dedupes
                // already-loaded chunk ids and the runtime callback would
                // never fire again.
                const req = await new Promise((res) => {
                  window['@flow-web/desktop:stable'].push([['probe_rec_' + Date.now()], {}, (r) => res(r)]);
                });
                step('require');
                // Bind the sandbox route to the real conversation id. The bus
                // invoke returns { ok }; module 410467's helper swallows it,
                // so call the bus directly. instanceId means the sandboxId.
                const comm = req(763283)._();
                step('invoke');
                const upd = await comm.invoke('cua.local_file.sandbox_instance.update_conversation', {
                  instanceId: args.sandboxId,
                  conversationId: state.conversationId,
                });
                step('invoked:' + JSON.stringify(upd).slice(0, 120));
                if (!upd || upd.ok !== true) {
                  throw new Error('update_conversation rejected: ' + JSON.stringify(upd).slice(0, 120));
                }
              })(),
              // Reconcile must never stall the reply stream (module ids drift
              // between app versions and the page may not have them loaded).
              new Promise((_, rej) => setTimeout(() => rej(new Error('reconcile timeout')), 5000)),
            ]);
            if (args.debug) trace.push({ event: 'RECONCILE_OK', data: state.conversationId });
          } catch (e) {
            if (args.debug) trace.push({ event: 'RECONCILE_FAIL', data: String(e?.message || e) });
          }
        }
      }
    }
    try { reader.cancel(); } catch {}
    if (state.failed) return { conversationId: state.conversationId, ...state.failed, ...(args.debug ? { trace } : {}) };
    if (args.waitForReply && !state.completed) {
      return {
        error: 'incomplete_stream',
        detail: 'stream ended without SSE_REPLY_END after ' + state.answer.length + ' answer chars',
        answer: state.answer,
        conversationId: state.conversationId,
        ...(args.debug ? { trace } : {}),
      };
    }
    return { conversationId: state.conversationId, answer: state.answer, thinking: state.thinking, ...(args.debug ? { trace } : {}) };
  } catch (error) {
    if (ac.signal.aborted) {
      return {
        error: 'timeout',
        detail: 'no completion within ' + args.timeoutMs + ' ms',
        conversationId: state.conversationId,
        answer: state.answer,
      };
    }
    return { error: 'exception', detail: String(error?.message || error), conversationId: state.conversationId };
  } finally {
    clearTimeout(killer);
  }
})()`;

const MODIFY_EXPRESSION = `(async () => {
  const args = %ARGS%;
  const resp = await fetch(args.url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json; encoding=utf-8' },
    body: JSON.stringify({
      cmd: 1114,
      uplink_body: {
        modify_conversation_uplink_body: {
          conversation_id: args.conversationId,
          conversation_type: 3,
          bot_conversation_type: 3,
          mode_id: '3',
          model_item_key: args.modelKey,
          reasoning_effort: args.reasoningEffort || '5',
        },
      },
      sequence_id: crypto.randomUUID(),
      channel: 2,
      version: '1',
    }),
  });
  let detail = '';
  try { detail = await resp.text(); } catch {}
  let statusCode = null;
  let statusDesc = '';
  try {
    const payload = JSON.parse(detail);
    statusCode = payload?.status_code ?? null;
    statusDesc = payload?.status_desc || '';
  } catch {}
  return { status: resp.status, statusCode, statusDesc, detail: detail.slice(0, 200) };
})()`;

function buildExpression(template, args) {
  return template
    .replace('%REDUCER%', reduceStreamEvent.toString())
    .replace('%ARGS%', JSON.stringify(args));
}

// Races a page-side evaluation against a hard deadline: closing the socket
// rejects the orphaned in-page promise, so a wedged renderer can never hang
// the CLI forever.
export async function evaluateWithWatchdog(client, expression, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      client.evaluate(expression),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          client.close();
          const error = new Error(`Doubao page evaluation did not settle within ${timeoutMs} ms`);
          error.code = 'timeout';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function defaultWorkspace() {
  return `${HOME}/${currentApp().name}/chats/${new Date().toISOString().slice(0, 10)}/cli-${Date.now()}`;
}

export async function sendChatCompletion(client, { conversationId, message, model, reasoningEffort, timeoutMs, waitForReply = true, workspace, skillPaths, permission, localConnectors, sandboxId, sharedFolderPath, localConversationId, localMessageId, debug, withExt }) {
  const runtime = await runtimeParameters(client);
  const createNew = !conversationId;
  const expression = buildExpression(SEND_EXPRESSION, {
    url: `${CHAT_URL}?${runtime.query}`,
    botId: BOT_ID,
    conversationId: conversationId || null,
    message,
    model,
    reasoningEffort: reasoningEffort || null,
    timeoutMs: Math.max(10_000, timeoutMs || 120_000),
    waitForReply,
    localConversationId: localConversationId || null,
    localMessageId: localMessageId || null,
    sandboxId: sandboxId || null,
    debug: Boolean(debug),
    ext: (createNew || withExt)
      ? conversationExt(model, localMessageId || '%LOCAL_MESSAGE_ID%',
        workspace || defaultWorkspace(),
        { clientEnvId: runtime.clientEnvId, deviceId: runtime.params.device_id, skillPaths, permission, localConnectors, sandboxId, sharedFolderPath, updatePermission: !createNew && Boolean(sandboxId) })
      : null,
  });
  const result = await evaluateWithWatchdog(client, expression, Math.max(10_000, timeoutMs || 120_000) + 30_000);
  if (!result) throw new Error('Doubao chat completion returned no result');
  if (result.error) {
    const error = new Error(`Doubao chat completion failed: ${result.error} ${result.detail || ''}`.trim());
    error.code = result.error;
    if (result.conversationId) error.conversationId = result.conversationId;
    if (result.answer) error.partialAnswer = result.answer;
    throw error;
  }
  if (!result.conversationId) throw new Error('Doubao did not assign a conversation id');
  return result;
}

// reasoning_effort values observed from the app: 低=3 中=4 高=5 极高=6 最高=7.
export async function switchConversationModel(client, conversationId, modelKey, reasoningEffort) {
  const runtime = await runtimeParameters(client);
  const result = await client.evaluate(buildExpression(MODIFY_EXPRESSION, {
    url: `${MODIFY_URL}?${runtime.query}`,
    conversationId,
    modelKey,
    reasoningEffort: reasoningEffort || null,
  }));
  if (!result || result.status !== 200) {
    throw new Error(`Doubao model switch failed: HTTP ${result?.status} ${result?.detail || ''}`.trim());
  }
  // The API reports application-level failures with HTTP 200; status_code 0
  // means success (e.g. omitting model_item_key returns 712012002).
  if (result.statusCode) {
    throw new Error(`Doubao model switch failed: ${result.statusDesc || `status_code ${result.statusCode}`}`);
  }
  return result;
}
