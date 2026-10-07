import { updateLiveControls } from './protocol.mjs';

const HOST_RE = /^(?:[a-z0-9-]+\.)*doubao\.com$/i;
const ID_RE = /^\d{12,24}$/;

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isTargetRequest(params, message, conversationId, mode) {
  if (params.request?.method !== 'POST') return false;
  let url;
  try { url = new URL(params.request.url); } catch { return false; }
  if (url.protocol !== 'https:' || !HOST_RE.test(url.hostname) || url.pathname !== '/chat/completion') return false;
  let body;
  try { body = JSON.parse(params.request.postData || ''); } catch { return false; }
  const bodyConversationId = body?.client_meta?.conversation_id;
  if (conversationId === ''
    ? bodyConversationId !== '' && bodyConversationId !== undefined && bodyConversationId !== null
    : bodyConversationId !== conversationId) return false;
  const sentText = (body?.messages || []).flatMap(item => item.content_block || [])
    .map(block => block?.content?.text_block?.text || '').join(' ');
  if (normalizeText(sentText) !== normalizeText(message)) return false;
  const expectedAgentMode = mode === 'work' ? 1 : 2;
  if (body?.option?.agent_mode !== expectedAgentMode) return 'unsupported';
  return { localMessageId: body?.messages?.[0]?.local_message_id || null };
}

function progress(state) {
  return { conversationId: state.conversationId || null, runId: state.runId || null, answerLength: state.text.length };
}

function baseResult(state, status = 'unknown') {
  return {
    platform: 'web',
    mode: state.mode,
    conversationId: state.conversationId || null,
    runId: state.runId || null,
    localMessageId: state.localMessageId,
    status,
    accepted: state.accepted,
    requestDispatched: state.requestDispatched,
    reply: status === 'completed' ? { role: 'assistant', text: state.text } : null,
    ...(status === 'failed' && state.errorCode ? { errorCode: state.errorCode } : {}),
    ...(state.mode === 'work' ? {
      handoffs: state.handoffs,
      liveMessages: state.liveMessages,
      ...(state.taskTrackingIncomplete ? { taskTrackingIncomplete: true } : {}),
    } : {}),
  };
}

function failure(state, message, status = 'unknown') {
  const error = new Error(message);
  error.result = { ...baseResult(state, status), progress: progress(state) };
  error.progress = error.result.progress;
  return error;
}

function parseEventFrame(frame) {
  let event = '';
  const data = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (!event || !data.length) return null;
  try { return { event, data: JSON.parse(data.join('\n')) }; } catch { return null; }
}

/** Observe a native Doubao Web completion request without creating one. */
export async function observeWebSend(client, {
  message,
  conversationId = null,
  mode = 'chat',
  waitForReply = false,
  timeoutMs = 120_000,
  onReceipt = () => {},
} = {}) {
  if (mode !== 'chat' && mode !== 'work') throw new Error('mode must be chat or work');
  if (mode === 'work' && waitForReply) throw new Error('web work task completion must be verified through the task tree');
  const wantedConversationId = conversationId || '';
  const state = { mode, conversationId: wantedConversationId, runId: '', localMessageId: null,
    text: '', accepted: false, requestDispatched: false,
    handoffs: [], liveMessages: [], liveState: { liveMessages: [] } };
  const removers = [];
  let done = false;
  let armed = false;
  let timer;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // The native-send caller may encounter a preparation error before it awaits result.
  result.catch(() => {});

  const cleanup = () => {
    clearTimeout(timer);
    for (const remove of removers.splice(0)) remove();
  };
  const fail = (message, status = 'unknown') => {
    if (done) return;
    done = true;
    cleanup();
    rejectResult(failure(state, message, status));
  };
  const finish = status => {
    if (done) return;
    done = true;
    cleanup();
    resolveResult(baseResult(state, status));
  };
  const checkpoint = () => {
    const receipt = baseResult(state, state.accepted ? 'running' : 'unknown');
    if (mode === 'work') {
      receipt.handoffs = state.handoffs.map(task => ({ ...task }));
      receipt.liveMessages = state.liveMessages.map(message => ({
        ...message,
        content_block: (message.content_block || []).map(block => ({ ...block })),
      }));
    }
    try {
      const pending = onReceipt(receipt);
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch {}
  };
  const consume = ({ event, data }) => {
    if (done) return;
    if (event === 'SSE_ACK') {
      const ackConversationId = String(data?.ack_client_meta?.conversation_id ?? '');
      const runId = String(data?.query_list?.[0]?.question_id ?? '');
      if (!ID_RE.test(ackConversationId) || !ID_RE.test(runId)) return fail('web response acceptance is unknown');
      if (wantedConversationId && ackConversationId !== wantedConversationId) return fail('web response acceptance is unknown');
      state.conversationId = ackConversationId;
      state.runId = runId;
      state.accepted = true;
      checkpoint();
      if (mode === 'work') {
        if (state.handoffs.length) finish('running');
      } else if (!waitForReply) finish('running');
      return;
    }
    if (event === 'STREAM_ERROR') {
      const code = data?.error_code;
      if (typeof code === 'number' && Number.isFinite(code)) state.errorCode = code;
      else if (typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(code)) state.errorCode = code;
      return fail('web response failed', 'failed');
    }
    if (event === 'FETCH_STREAM') {
      if (mode !== 'work') return fail('web work task handoff is unsupported');
      if (data?.fetch_type !== 2 || !data.fetch_key) { state.taskTrackingIncomplete = true; return; }
      const taskId = String(data.fetch_key);
      if (!state.handoffs.some(task => task.taskId === taskId)) {
        const handoff = { taskId, appendScene: data.append_scene, threadId: data.thread_id ? String(data.thread_id) : '', seq: 0 };
        state.handoffs.push(handoff);
        if (!handoff.threadId) state.taskTrackingIncomplete = true;
      }
      state.liveMessages = state.liveState.liveMessages;
      checkpoint();
      if (state.accepted) finish('running');
      return;
    }
    if (mode === 'work' && ['STREAM_MSG_NOTIFY', 'STREAM_CHUNK'].includes(event)) {
      updateLiveControls(state.liveState, event, data);
      state.liveMessages = state.liveState.liveMessages;
      checkpoint();
    }
    if (event === 'STREAM_CHUNK') {
      for (const op of data?.patch_op || []) {
        for (const block of op?.patch_value?.content_block || []) {
          if (block?.block_type === 10000 && typeof block.content?.text_block?.text === 'string') {
            state.text += block.content.text_block.text;
          }
        }
      }
      return;
    }
    if (event === 'SSE_REPLY_END' && data?.end_type === 3) {
      if (mode === 'work' && state.accepted) { finish('running'); return; }
      if (state.accepted && state.text.trim()) finish('completed');
      else fail('web response ended without a verifiable answer');
    }
  };

  let activeRequestId = null;
  let responseReady = false;
  let streamReady = false;
  let finishedQueued = false;
  let queued = [];
  let parserBuffer = '';
  const decoder = new TextDecoder();
  const processText = chunk => {
    parserBuffer += chunk;
    let boundary;
    while ((boundary = parserBuffer.search(/\r?\n\r?\n|\r\r/)) >= 0) {
      const delimiter = parserBuffer.match(/\r?\n\r?\n|\r\r/)[0];
      const frame = parserBuffer.slice(0, boundary);
      parserBuffer = parserBuffer.slice(boundary + delimiter.length);
      const parsed = parseEventFrame(frame);
      if (parsed) consume(parsed);
    }
  };
  const finalizeStream = () => {
    processText(decoder.decode());
    if (parserBuffer) {
      const parsed = parseEventFrame(parserBuffer);
      parserBuffer = '';
      if (parsed) consume(parsed);
    }
    if (done) return;
    if (mode === 'work' && state.accepted) finish('running');
    else fail('web response stream ended before completion');
  };
  const handleStreamEvent = params => {
    if (!activeRequestId || params.requestId !== activeRequestId) return;
    if (!streamReady) { queued.push(params); return; }
    if (typeof params.data === 'string') processText(decoder.decode(Buffer.from(params.data, 'base64'), { stream: true }));
  };

  removers.push(client.subscribe('Network.requestWillBeSent', params => {
    if (!armed || activeRequestId) return;
    const match = isTargetRequest(params, message, wantedConversationId, mode);
    if (!match) return;
    if (match === 'unsupported') {
      state.requestDispatched = true;
      return fail('unsupported web work task');
    }
    activeRequestId = params.requestId;
    state.localMessageId = match.localMessageId;
    state.requestDispatched = true;
  }));
  removers.push(client.subscribe('Network.responseReceived', params => {
    if (params.requestId !== activeRequestId || responseReady) return;
    const response = params.response || {};
    const mime = String(response.mimeType || '').split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || mime !== 'text/event-stream') {
      fail('web response stream is unavailable');
      return;
    }
    responseReady = true;
    Promise.resolve(client.send('Network.streamResourceContent', { requestId: activeRequestId })).then(({ bufferedData = '' } = {}) => {
      if (done) return;
      if (bufferedData) processText(decoder.decode(Buffer.from(bufferedData, 'base64'), { stream: true }));
      streamReady = true;
      const pending = queued;
      queued = [];
      for (const params of pending) handleStreamEvent(params);
      if (!done && finishedQueued) finalizeStream();
    }, () => fail('web response stream is unavailable; completion is unknown'));
  }));
  removers.push(client.subscribe('Network.dataReceived', handleStreamEvent));
  removers.push(client.subscribe('Network.loadingFailed', params => {
    if (params.requestId !== activeRequestId) return;
    if (mode === 'work' && state.accepted) {
      state.taskTrackingIncomplete ||= state.handoffs.length === 0;
      finish('running');
    } else fail('web response stream ended before completion');
  }));
  removers.push(client.subscribe('Network.loadingFinished', params => {
    if (params.requestId !== activeRequestId || done) return;
    if (!streamReady) finishedQueued = true;
    else finalizeStream();
  }));

  try {
    await client.send('Network.enable');
  } catch (error) {
    cleanup();
    throw error;
  }
  timer = setTimeout(() => {
    if (mode === 'work' && state.accepted) {
      state.taskTrackingIncomplete ||= state.handoffs.length === 0;
      finish('running');
    } else fail(state.accepted ? 'web reply timed out; completion is unknown' : 'web send acceptance timed out; outcome is unknown');
  }, timeoutMs);
  return {
    result,
    arm() { if (!done) armed = true; },
    close() {
      if (done) return;
      fail('web response observation closed; outcome is unknown');
    },
    snapshot() { return { ...baseResult(state, state.accepted ? 'running' : 'unknown'), progress: { text: state.text } }; },
  };
}
