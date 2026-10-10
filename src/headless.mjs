import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import qrcode from 'qrcode-terminal';
import { configDirectory } from './config.mjs';
import { CookieJar, HeadlessClient, consumeSse } from './headless-http.mjs';
import { qrLogin } from './headless-auth.mjs';
import { reduceStreamEvent, updateLiveControls } from './protocol.mjs';
import { messageText, readTurn, refreshTurn, waitTurn, stopTurn, receiptStore } from './turns.mjs';

const ID = /^[1-9]\d{11,23}$/u;
const sessionPath = () => path.join(configDirectory(), 'headless', 'session.json');
const validateId = value => { if (!ID.test(value || '')) throw new Error('conversation id must contain 12 to 24 digits'); return value; };

export function validateHeadlessOptions(options) {
  const [command, subcommand] = options.args;
  if (!command || ['help', 'version', '--version', '-v', 'update'].includes(command)) return;
  const unsupported = [
    ['--target', options.targetId], ['--profile', options.profile], ['--attach', options.attachments?.length],
    ['--reasoning', options.reasoning], ['--runtime local', options.runtime === 'local'],
    ['--project', options.project], ['--enterprise-knowledge', options.enterpriseKnowledge],
    ['--workspace', options.workspace], ['--no-skills', options.noSkills], ['--permission', options.permission],
    ['--mcp', options.mcps?.length], ['--command', options.commandPath], ['--arg', options.commandArgs?.length], ['--env', options.envPairs?.length],
  ].find(([, supplied]) => supplied);
  if (unsupported) throw new Error(`${unsupported[0]} is not supported on doubao headless`);
  if (options.unknownFlags?.length) throw new Error(`Unknown Headless option: ${options.unknownFlags[0]}; use -- before literal option text`);
  if (options.cookieFile && command !== 'login') throw new Error('--cookie-file requires doubao headless login');
  const supported = ['login', 'logout', 'status', 'capabilities', 'models'].includes(command)
    || command === 'sessions' && ['list', 'read', 'create', 'send', 'status', 'wait', 'stop'].includes(subcommand);
  if (!supported) throw new Error(`${options.args.slice(0, 2).join(' ')} is not supported on doubao headless`);
  if (['login', 'logout', 'status', 'capabilities', 'models'].includes(command) && options.args.length !== 1) throw new Error(`${command} accepts no positional arguments`);
  if (options.wait && (command !== 'sessions' || !['create', 'send'].includes(subcommand)
    || !options.args.slice(subcommand === 'create' ? 2 : 3).join(' ').trim())) throw new Error('Headless --wait requires sessions create/send with a message');
  if (options.model && (command !== 'sessions' || !['create', 'send'].includes(subcommand))) throw new Error('--model requires headless sessions create/send');
}

async function saveSession(client) {
  const file = sessionPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({ accountId: client.accountId, device: client.device, cookies: client.jar.cookies }), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function signedInClient(timeoutMs) {
  let session;
  try { session = JSON.parse(await fs.readFile(sessionPath(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Headless session file is invalid; log in again'); }
  const cookie = process.env.DOUBAO_HEADLESS_COOKIE;
  if (!cookie && !session) throw Object.assign(new Error('Doubao login is required; run "doubao headless login"'), { code: 'login_required' });
  const client = new HeadlessClient({ ...(session || {}), ...(cookie ? { cookies: CookieJar.import(cookie), accountId: undefined } : {}) });
  await client.account({ timeoutMs });
  if (!cookie) await saveSession(client);
  attachLifecycle(client);
  return client;
}

export function completionBody({ conversationId = '', message, mode = 'work', model, localMessageId = randomUUID() }) {
  const work = mode === 'work';
  const generalTask = { action: 0, thread_local_message_id: [localMessageId], runtime_type: 1,
    agent_task_param: { runtime_type: 1 }, agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false, task_input_json: JSON.stringify({ schema_version: 1, project_context: {} }) };
  const init = { need_ack_conversation: true };
  return {
    client_meta: { local_conversation_id: 'local_' + Date.now() + '_' + randomUUID(), conversation_id: conversationId,
      bot_id: '7338286299411103781', last_section_id: '', last_message_index: null },
    messages: [{ local_message_id: localMessageId, content_block: [{ block_type: 10000,
      content: { text_block: { text: message } }, block_id: randomUUID() }], message_status: 0 }],
    option: { create_time_ms: Date.now(), agent_mode: work ? 1 : 2, need_deep_think: model?.needDeepThink ?? (work ? 9 : 0), unique_key: randomUUID(),
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      need_create_conversation: !conversationId, is_old_user: true, message_from: 0,
      sse_recv_event_options: { support_chunk_delta: true }, general_task_param: generalTask,
      ...(!conversationId ? { conversation_init_option: init, conversation_init_ext: { mode_id: work ? '3' : '1', ...(model ? { model_item_key: model.id } : {}) } } : {}),
      ...(model ? { model_config: { model_item_key: model.id }, aggregate_params: { provider_id: model.provider || '' } } : {}) },
    ext: { general_task_param: JSON.stringify(generalTask), use_deep_think: String(model?.needDeepThink ?? (work ? 9 : 0)), agent_mode: work ? '1' : '2',
      sub_conv_firstmet_type: '1', collection_id: '', is_finish: '1', conversation_init_option: JSON.stringify(init), commerce_credit_config_enable: '0' },
    user_context: [],
  };
}

export async function streamCompletion(client, body, { timeoutMs, waitForReply = false, onReceipt = () => {}, runId = '' } = {}) {
  const state = { conversationId: body.client_meta.conversation_id, runId, localMessageId: body.messages[0].local_message_id,
    answer: '', thinking: '', completed: false, handoffs: [], liveMessages: [], requestBody: body, accepted: false, requestDispatched: false };
  const checkpoint = () => onReceipt({ ...state });
  try {
    state.requestDispatched = true;
    const response = await client.request('/chat/completion', { method: 'POST', timeoutMs,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await consumeSse(response, async (event, data) => {
      if (event === 'SSE_ACK') {
        const id = String(data?.ack_client_meta?.conversation_id || '');
        const acceptedRun = String(data?.query_list?.[0]?.question_id || '');
        const acceptedLocalId = data?.query_list?.[0]?.local_message_id;
        if (!ID.test(id) || !ID.test(acceptedRun) || state.conversationId && id !== state.conversationId
          || acceptedLocalId && acceptedLocalId !== state.localMessageId
          || runId && runId !== acceptedRun) throw new Error('Doubao returned a mismatched acceptance receipt');
        state.accepted = true;
      }
      // A Work ACK can precede provisioning its asynchronous task. Keep the
      // initial stream until a handoff or terminal event even without --wait.
      const result = reduceStreamEvent(state, event, data, { waitForReply: waitForReply || body.option.agent_mode === 1 });
      const pending = updateLiveControls(state, event, data);
      if (event === 'SSE_ACK' || event === 'FETCH_STREAM' || pending) checkpoint();
      if (event === 'STREAM_ERROR' || event === 'gateway-error') throw Object.assign(new Error('Doubao completion failed'), { code: 'stream_error' });
      return result || (pending || state.accepted && state.handoffs.length ? 'stop' : undefined);
    });
    if (!state.accepted) throw new Error('Completion ended without a verified acceptance receipt');
    checkpoint();
    return state;
  } catch (error) {
    checkpoint();
    error.code ||= ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'request_failed';
    error.result = { platform: 'headless', conversationId: state.conversationId || null, runId: state.runId || null,
      localMessageId: state.localMessageId, accepted: state.accepted, requestDispatched: state.requestDispatched, status: state.failed ? 'failed' : 'unknown', reply: null,
      recovery: state.accepted ? 'Use sessions wait with the same conversationId and runId; do not resend' : 'Acceptance is unknown; inspect session history before retrying' };
    throw error;
  }
}

function attachLifecycle(client) {
  client.resumeCompletion = async options => {
    // Server recovery reopens this exact request; it is never a new user send.
    const body = structuredClone(options.resumeRequest);
    body.option.recovery_option.is_recovery = true;
    return streamCompletion(client, body, options);
  };
  client.followTaskStreams = async (receipt, timeoutMs, onReceipt = () => {}) => {
    const deadline = Date.now() + timeoutMs;
    const controls = { liveMessages: receipt.liveMessages || [] };
    for (let index = 0; index < receipt.handoffs.length && Date.now() < deadline; index++) {
      const task = receipt.handoffs[index];
      if (task.completed) continue;
      delete task.waitingInput;
      try {
        const response = await client.request('/chat/async/chunk_stream', { method: 'POST', timeoutMs: Math.max(1, deadline - Date.now()),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: task.taskId, seq_start: task.seq || 0, append_scene: task.appendScene, ext: {} }) });
        await consumeSse(response, (event, data, id) => {
          const seq = Number(id);
          if (Number.isFinite(seq) && seq > 0 && seq <= (task.seq || 0)) return;
          if (Number.isFinite(seq)) task.seq = Math.max(task.seq || 0, seq);
          if (event === 'ASYNC_CHUNK_SNAPSHOT') task.seq = Math.max(task.seq || 0, Number(data.next_seq) || 0);
          if (event === 'FETCH_STREAM' && data.fetch_type === 2 && data.fetch_key && !receipt.handoffs.some(item => item.taskId === String(data.fetch_key))) {
            if (receipt.handoffs.length >= 100) throw new Error('Async task stream limit exceeded');
            receipt.handoffs.push({ taskId: String(data.fetch_key), appendScene: data.append_scene, threadId: data.thread_id || '', seq: 0 });
          }
          if (updateLiveControls(controls, event, data)) { task.waitingInput = true; return 'stop'; }
          if (event === 'SSE_REPLY_END' && data.end_type === 3) { task.completed = true; return 'stop'; }
          if (event === 'STREAM_ERROR' || event === 'gateway-error') { task.error = 'stream_error'; task.completed = true; return 'stop'; }
          receipt.liveMessages = controls.liveMessages;
          onReceipt(receipt);
        });
        delete task.connectionError;
      } catch (error) { task.connectionError = error.code || error.name; }
      finally { receipt.liveMessages = controls.liveMessages; onReceipt(receipt); }
    }
  };
}

export async function executeHeadless(options) {
  const [command, subcommand, operand] = options.args;
  const started = Date.now(), deadline = started + options.timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw Object.assign(new Error('Headless request timed out'), { code: 'timeout' }); return ms; };
  if (command === 'capabilities') return { platform: 'headless', browserRequired: false, appRequired: false,
    login: ['terminal-qr', 'cookie-file'], sessions: ['list', 'read', 'create', 'send', 'status', 'wait', 'stop'],
    runtime: ['cloud'], models: true, attachments: false, localRuntime: false, mcp: false, projects: false, enterpriseKnowledgeSelection: false };
  if (command === 'logout') {
    await fs.rm(sessionPath(), { force: true });
    return { platform: 'headless', storedCredentialsRemoved: true, loggedIn: false,
      environmentCredentialActive: Boolean(process.env.DOUBAO_HEADLESS_COOKIE) };
  }
  if (command === 'login') {
    const cookie = options.cookieFile ? await fs.readFile(options.cookieFile, 'utf8') : process.env.DOUBAO_HEADLESS_COOKIE;
    const client = new HeadlessClient({ ...(cookie ? { cookies: CookieJar.import(cookie) } : {}) });
    if (cookie) await client.account({ timeoutMs: remaining() });
    else await qrLogin(client, { timeoutMs: remaining(), onQr: ({ url }) => {
      if (!url) throw new Error('Doubao QR response has no scannable login URL');
      console.error('Scan with the Doubao mobile app and approve sign-in:');
      qrcode.generate(url, { small: true }, value => console.error(value));
    } });
    await saveSession(client);
    return { platform: 'headless', loggedIn: true, accountId: client.accountId, browserRequired: false, appRequired: false };
  }
  let client;
  try { client = await signedInClient(remaining()); }
  catch (error) {
    if (command !== 'status' || error.code !== 'login_required') throw error;
    return { platform: 'headless', loggedIn: false, loginRequired: true, accountId: null, browserRequired: false, appRequired: false };
  }
  if (command === 'status') return { platform: 'headless', loggedIn: true, loginRequired: false, accountId: client.accountId, browserRequired: false, appRequired: false };
  if (command === 'models') return headlessModels(client, remaining());
  if (command !== 'sessions') throw new Error('Unknown headless command');
  if (subcommand === 'list') return listHeadlessSessions(client, options.limit, remaining());
  if (subcommand === 'read') {
    const body = await client.imRequest('conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', {
      conversation_id: [validateId(operand)], option: { recent_message_count_per_conv: Math.min(options.limit, 100) }, ext: {} }, remaining());
    const conversation = body?.batch_get_conv_info_downlink_body?.conversation_info_list?.find(item => item.conversation_id === operand);
    if (!conversation) throw new Error('Doubao conversation was not found');
    return { platform: 'headless', conversationId: operand, messages: (conversation.messages || []).map(message => ({
      role: message.user_type === 1 ? 'user' : 'assistant', text: messageText(message), messageId: message.message_id })) };
  }
  const store = await receiptStore(client);
  if (['create', 'send'].includes(subcommand)) {
    const message = options.args.slice(subcommand === 'create' ? 2 : 3).join(' ').trim();
    if (!message) throw new Error('Headless sessions create/send requires a message');
    const conversationId = subcommand === 'send' ? validateId(operand) : '';
    let mode = options.mode || 'work';
    if (conversationId) {
      const snapshot = await readTurn(client, conversationId, { deadline });
      let extra = {};
      try { extra = JSON.parse(snapshot.conversation.extra || '{}'); } catch {}
      mode = extra.mode_id === '1' ? 'chat' : 'work';
      // A desktop local session cannot be executed by this CLI runtime.
      let runtime;
      try { runtime = JSON.parse(extra.agent_task_param || '{}').runtime_type; } catch {}
      if (runtime === 2) throw new Error('This conversation uses a desktop local runtime; create a headless cloud conversation');
    }
    const model = options.model ? await resolveHeadlessModel(client, options.model, mode, remaining()) : undefined;
    const body = completionBody({ conversationId, message, mode, model });
    let receipt = { requestBody: body, mode };
    const checkpoint = next => { Object.assign(receipt, next); store.save(receipt); };
    const accepted = await streamCompletion(client, body, { timeoutMs: remaining(), waitForReply: options.wait, onReceipt: checkpoint });
    Object.assign(receipt, accepted);
    if (!options.wait) return { platform: 'headless', mode, conversationId: receipt.conversationId, runId: receipt.runId,
      localMessageId: receipt.localMessageId, status: 'running', accepted: true, reply: null };
    const result = await waitTurn(client, receipt.conversationId, { runId: receipt.runId, receipt, deadline,
      onReceipt: checkpoint, loadReceipt: run => store.read(receipt.conversationId, run) });
    return { platform: 'headless', mode, accepted: true, ...result };
  }
  const conversationId = validateId(operand);
  const pinned = await readTurn(client, conversationId, { runId: options.runId, deadline });
  const receipt = { ...store.read(conversationId, pinned.result.runId), conversationId, runId: pinned.result.runId };
  const operation = subcommand === 'wait' ? waitTurn : subcommand === 'stop' ? stopTurn : refreshTurn;
  const result = await operation(client, conversationId, { runId: receipt.runId, receipt, deadline, timeoutMs: remaining(),
    onReceipt: next => store.save(next), loadReceipt: run => store.read(conversationId, run) });
  return { platform: 'headless', ...(result.result || result) };
}

// Filled from the server's live catalog; no hard-coded model aliases or entitlements.
async function headlessModels(client, timeoutMs) {
  const result = await client.json('/alice/slot/action_bar_v3/brief_list', { method: 'POST', timeoutMs,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language_code: 'zh', bot_id: '7338286299411103781' }) });
  if (result.code !== 0) throw new Error('Doubao model catalog request was rejected');
  const config = result.data?.entry_list?.find(entry => entry.action_bar_key === 'coco_deep_thinking')?.active_switch_conf;
  if (!config) throw new Error('This account has no headless model catalog');
  const v2 = config.menu_conf_v2;
  const modes = v2?.mode_list?.item_list || [];
  const models = new Map();
  const add = (item, mode) => {
    const id = String(item.model_item_key || item.item_id || '');
    if (!id || !item.name) return;
    const previous = models.get(id);
    const enabled = !item.disabled && item.subscribe_config?.need_upgrade !== true;
    models.set(id, { id, name: item.name, provider: item.model_extra_params?.provider_id || '',
      needDeepThink: item.model_extra_params?.model_type === 'custom' ? 10001 : /^\d+$/u.test(id) ? Number(id) : Number(item.item_id),
      available: enabled, modes: [...new Set([...(previous?.modes || []), mode].filter(Boolean))] });
  };
  for (const mode of modes) {
    const label = mode.agent_mode === 1 ? 'work' : mode.agent_mode === 2 ? 'chat' : undefined;
    for (const item of mode.model_list?.item_list || []) add(item, label);
    for (const item of v2?.model_list?.item_list || []) {
      if (!mode.support_models?.length || mode.support_models.some(model => String(model.model_item_key || model.item_id || model) === String(item.model_item_key || item.item_id))) add(item, label);
    }
  }
  if (!models.size) for (const item of config.menu_conf?.item_list || []) add(item, item.agent_mode === 1 ? 'work' : 'chat');
  if (!models.size) throw new Error('Doubao model catalog is empty');
  return { platform: 'headless', models: [...models.values()] };
}
async function resolveHeadlessModel(client, selected, mode, timeoutMs) {
  const catalog = await headlessModels(client, timeoutMs);
  const matches = catalog.models.filter(model => (model.id === selected || model.name === selected) && model.available && model.modes.includes(mode));
  if (matches.length !== 1) throw new Error('Select an available headless model by ID or exact name');
  return matches[0];
}
async function listHeadlessSessions(client, limit, timeoutMs) {
  const result = await client.imRequest('chain/recent_conv', 3200, 'pull_recent_conv_chain_uplink_body', {
    limit: Math.min(limit, 100), api_version: 1, conv_version: 0, direction: 3,
    option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: true, need_coco_bot: true } }, timeoutMs);
  const data = result?.pull_recent_conv_chain_downlink_body;
  if (!Array.isArray(data?.cells)) throw new Error('Doubao session list is unavailable');
  return { platform: 'headless', sessions: data.cells.map(cell => cell.conversation).filter(conversation => ID.test(conversation?.conversation_id || ''))
    .slice(0, limit).map(conversation => ({ id: conversation.conversation_id, title: conversation.name, updatedAt: conversation.update_time })),
    hasMore: Boolean(data.has_more) };
}
