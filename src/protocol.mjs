// Protocol-direct messaging: issues chat/completion requests inside the
// authenticated Doubao renderer, where the webmssdk fetch hook transparently
// attaches msToken / a_bogus / x-helios / x-medusa and cookies, so the request
// is indistinguishable from the app's own traffic. This avoids DOM-driven
// composer automation and UI-state timing entirely.

const CHAT_URL = 'https://api5-normal-gl.doubao.com/chat/completion';
const MODIFY_URL = 'https://www.doubao.com/im/conversation/modify';
const BOT_ID = '7338286299411103781';

// Captured from Doubao.app 2.27.11 traffic. New-conversation requests are only
// honored with the full device parameter set (a reduced set silently merges
// into the account's current conversation).
const CHAT_QS = 'aid=582478&channel=mac_official&chromium_version=147.0.7727.149&client_platform=pc_client'
  + '&device_id=4123623653382612&device_platform=web&doubao_device_platform=desktop'
  + '&doubao_pc_version=2.27.11&fp=verify_4123623653382612&language=zh&pc_version=2.27.11'
  + '&pkg_type=release_version&real_aid=582478&region=CN&runtime=web&runtime_version=3.35.4'
  + '&samantha_web=1&sys_region=CN&tea_uuid=4123623653382612&tz_name=Asia%2FShanghai'
  + '&use-olympus-account=1&version_code=20800&web_id=7672758390314255922&web_platform=desktop'
  + '&web_tab_id=5c7c0822-57bf-4d15-87b5-c7b5d3d78687';
const MODIFY_QS = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop'
  + '&aid=582478&real_aid=582478&pkg_type=release_version&device_id=4123623653382612'
  + '&pc_version=2.27.11&doubao_pc_version=2.27.11&region=CN&sys_region=CN&samantha_web=1'
  + '&web_platform=desktop&use-olympus-account=1&runtime=web&runtime_version=3.35.4'
  + '&client_platform=pc_client&channel=mac_official&fp=verify_4123623653382612';

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
function conversationExt(model, localMessageId, workspace) {
  const gtp = {
    action: 0,
    thread_local_message_id: [localMessageId],
    client_option: {
      enable_sandbox: true,
      os: 'Mac',
      shared_folder_path: [workspace, '/Users/bytedance/Library/Application Support/Doubao/Profile 1/.doubao/agent_mode/workspace'],
      agent_workspace: {
        agent_workspace: '/Users/bytedance/Library/Application Support/Doubao/Profile 1/.doubao/agent_mode/workspace',
        local_skill_paths: ['/Users/bytedance/Doubao/skills', '/Users/bytedance/.agents/skills'],
      },
      client_env_id: '85dd66b1-4866-483a-a37a-da832ae9a35f',
      sandbox_id: `route-${crypto.randomUUID()}`,
      workspace,
      sandbox_auth_type: 2,
    },
    runtime_type: 2,
    agent_task_param: {
      runtime_type: 2,
      sandbox_auth_type: 2,
      device_name: 'MacBook Pro (4)',
      folder_name: '',
      local_app_id: '582478',
      local_device_id: '4123623653382612',
      workspace,
    },
    agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false,
    task_input_json: '{"agents_md":{"files":[],"state":2},"schema_version":1,"home_dir":"/Users/bytedance","project_context":{},"localConnectors":[]}',
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

// Evaluated inside the chat page. Returns
// { conversationId, answer, thinking } or { error, detail }.
const SEND_EXPRESSION = `(async () => {
  const args = %ARGS%;
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), args.timeoutMs);
  try {
    const localMessageId = crypto.randomUUID();
    const body = {
      client_meta: {
        local_conversation_id: 'local_' + Date.now(),
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
          ? { model_item_key: args.model.key, reasoning_effort: '5', mode_id: '3' }
          : undefined,
        aggregate_params: args.model.provider ? { provider_id: args.model.provider } : undefined,
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
    let conversationId = args.conversationId || '';
    let answer = '';
    let thinking = '';
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
        if (event === 'SSE_ACK') {
          conversationId = data?.ack_client_meta?.conversation_id || conversationId;
          if (!args.waitForReply) {
            try { reader.cancel(); } catch {}
            return { conversationId, answer: '', thinking: '' };
          }
        }
        if (event === 'STREAM_CHUNK') {
          for (const op of data.patch_op || []) {
            for (const block of op.patch_value?.content_block || []) {
              if (block.block_type === 10000 && block.content?.text_block?.text) {
                answer += block.content.text_block.text;
              }
              if (block.block_type === 10040 && block.content?.thinking_block?.content) {
                thinking += block.content.thinking_block.content;
              }
            }
          }
        }
        if (event === 'SSE_REPLY_END' && data.end_type === 1 && data.msg_finish_attr?.brief) {
          answer = data.msg_finish_attr.brief;
        }
        if (event === 'SSE_REPLY_END' && data.end_type === 3) break outer;
      }
    }
    try { reader.cancel(); } catch {}
    return { conversationId, answer, thinking };
  } catch (error) {
    return { error: 'exception', detail: String(error?.message || error) };
  } finally {
    clearTimeout(killer);
  }
})()`;

const MODIFY_EXPRESSION = `(async () => {
  const args = %ARGS%;
  const resp = await fetch(args.url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cmd: 1114,
      uplink_body: {
        modify_conversation_uplink_body: {
          conversation_id: args.conversationId,
          conversation_type: 3,
          bot_conversation_type: 3,
          mode_id: '3',
          model_item_key: args.modelKey,
          reasoning_effort: '5',
        },
      },
      sequence_id: crypto.randomUUID(),
      channel: 2,
      version: '1',
    }),
  });
  return { status: resp.status, detail: (await resp.text()).slice(0, 200) };
})()`;

function buildExpression(template, args) {
  return template.replace('%ARGS%', JSON.stringify(args));
}

export async function sendChatCompletion(client, { conversationId, message, model, timeoutMs, waitForReply = true }) {
  const createNew = !conversationId;
  const expression = buildExpression(SEND_EXPRESSION, {
    url: `${CHAT_URL}?${CHAT_QS}`,
    botId: BOT_ID,
    conversationId: conversationId || null,
    message,
    model,
    timeoutMs: Math.max(10_000, timeoutMs || 120_000),
    waitForReply,
    ext: createNew
      ? conversationExt(model, '%LOCAL_MESSAGE_ID%',
        `/Users/bytedance/Doubao/chats/${new Date().toISOString().slice(0, 10)}/cli-${Date.now()}`)
      : null,
  });
  const result = await client.evaluate(expression);
  if (!result) throw new Error('Doubao chat completion returned no result');
  if (result.error) {
    throw new Error(`Doubao chat completion failed: ${result.error} ${result.detail || ''}`.trim());
  }
  if (!result.conversationId) throw new Error('Doubao did not assign a conversation id');
  return result;
}

export async function switchConversationModel(client, conversationId, modelKey) {
  const result = await client.evaluate(buildExpression(MODIFY_EXPRESSION, {
    url: `${MODIFY_URL}?${MODIFY_QS}`,
    conversationId,
    modelKey,
  }));
  if (!result || result.status !== 200) {
    throw new Error(`Doubao model switch failed: HTTP ${result?.status} ${result?.detail || ''}`.trim());
  }
  return result;
}
