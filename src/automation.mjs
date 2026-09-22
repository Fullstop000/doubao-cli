import { currentApp } from './app.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { uploadAttachmentsFromClient } from './attachments.mjs';
import { withChatClient } from './cdp.mjs';
import { resolveModelFromClient, resolveReasoningEffort, selectModelFromClient, setReasoningForConversation } from './models.mjs';
import { sendWithConnectors } from './mcp.mjs';
import { modelProtocol, sendChatCompletion, switchConversationModel } from './protocol.mjs';
import { refreshTurn, readTurn, waitTurn, stopTurn, receiptStore } from './turns.mjs';

const CHAT_INPUT = '[data-testid="chat_input_input"] [contenteditable="true"]';
const SEND_BUTTON = '[data-testid="chat_input_send_button"]';
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function remainingMilliseconds(deadline, timeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Doubao operation did not complete within ${timeoutMs} ms`);
  return remaining;
}

export function conversationDeepLink(id, app = currentApp()) {
  const webUrl = `https://www.doubao.com/chat/${id}`;
  return `${app.scheme}://${app.scheme}app/open-url?url=${encodeURIComponent(webUrl)}`;
}

export function openConversation(id) {
  const url = conversationDeepLink(id);
  // Doubao activates itself when handling the deep link (open -g does not
  // prevent it), so remember the frontmost app and restore focus in a
  // detached watcher once that activation happens.
  const before = spawnSync('/usr/bin/osascript', [
    '-e', 'tell application "System Events" to get name of first application process whose frontmost is true',
  ], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync('/usr/bin/open', ['-g', '-a', currentApp().appPath, url], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `failed to open ${url}`);
  if (before && before !== currentApp().name) {
    const restore = [
      'for i in $(seq 1 30); do',
      'cur=$(/usr/bin/osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\' 2>/dev/null);',
      `if [ "$cur" = "${currentApp().name}" ]; then`,
      `/usr/bin/osascript -e 'tell application "System Events" to set frontmost of process "${before.replace(/"/g, '\\"')}" to true' 2>/dev/null;`,
      'exit 0;',
      'fi;',
      'sleep 0.3;',
      'done',
    ].join(' ');
    spawn('bash', ['-c', restore], { detached: true, stdio: 'ignore' }).unref();
  }
  return url;
}

export function conversationIdFromUrl(url) {
  return /\/chat\/(\d{12,24})(?:[?#]|$)/u.exec(url || '')?.[1] || null;
}

async function waitForConversation(client, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await client.evaluate(`({ href: location.href, ready: Boolean(document.querySelector(${JSON.stringify(CHAT_INPUT)})) })`);
      if (state?.ready && new RegExp(`/chat/${id}(?:[?#]|$)`, 'u').test(state.href)) return state.href;
    } catch {
      // The renderer tears down its execution context during navigation;
      // keep polling until the new page is ready.
    }
    await delay(200);
  }
  throw new Error(`Doubao did not open conversation ${id} within ${timeoutMs} ms`);
}

// Navigating the chat renderer in place never raises the Doubao window,
// unlike the doubao:// deep link, which always activates the app.
// force reloads even when the renderer already shows the conversation, so
// callers read fresh state instead of a stale UI left by server-side changes.
async function navigateToConversation(client, target, id, timeoutMs, { force = false } = {}) {
  if (force || conversationIdFromUrl(target.url) !== id) {
    const base = target.url.replace(/\/chat(?:\/.*)?$/u, '');
    await client.send('Page.navigate', { url: `${base}/chat/${id}` });
  }
  await waitForConversation(client, id, timeoutMs);
}

// Use the existing renderer only. A missing chat page must not implicitly
// launch the app's deep link and interrupt the user's foreground application.
async function withConversationPage(id, timeoutMs, callback, { force = false } = {}) {
  return withChatClient(async (client, target) => {
    await navigateToConversation(client, target, id, timeoutMs, { force });
    return await callback(client);
  });
}

// The drop area mounts slightly after the composer input, especially after an
// in-page navigation. Wait for it before staging attachment uploads.
async function waitForDropTarget(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await client.evaluate('Boolean(document.querySelector(\'[data-testid="file_drop_area"]\'))');
    if (ready) return;
    await delay(200);
  }
  throw new Error('Doubao attachment drop target was not found');
}

async function waitForBlankConversation(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await client.evaluate(`({
        href: location.href,
        ready: Boolean(document.querySelector(${JSON.stringify(CHAT_INPUT)})),
      })`);
      if (state?.ready && /\/chat(?:[?#]|$)/u.test(state.href)) return state.href;
    } catch {
      // Keep polling while the renderer navigates.
    }
    await delay(100);
  }
  throw new Error(`Doubao did not open a blank conversation within ${timeoutMs} ms`);
}

async function waitForConversationId(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = conversationIdFromUrl(await client.evaluate('location.href'));
    if (id) return id;
    await delay(100);
  }
  throw new Error(`Doubao did not assign a conversation id within ${timeoutMs} ms`);
}

const READ_MESSAGES_EXPRESSION = `(() => [...document.querySelectorAll('[data-testid="union_message"]')]
  .map((element) => {
    const role = element.querySelector('[data-testid="send_message"]')
      ? 'user'
      : element.querySelector('[data-testid="receive_message"]') ? 'assistant' : null;
    const parts = [...element.querySelectorAll('[data-testid="message_text_content"]')]
      .map((part) => (part.innerText || '').trim())
      .filter(Boolean);
    const attachments = [...element.querySelectorAll('[data-testid="message_nested_content_file_name"]')]
      .map((part) => (part.innerText || '').trim())
      .filter(Boolean);
    const images = element.querySelectorAll('[data-plugin-identifier="block_type:10052"] img').length;
    return role && (parts.length || attachments.length || images)
      ? {
        role,
        text: parts.join('\\n'),
        ...(attachments.length ? { attachments } : {}),
        ...(images ? { images } : {}),
      }
      : null;
  })
  .filter(Boolean))()`;

async function readFromClient(client) {
  return await client.evaluate(READ_MESSAGES_EXPRESSION) || [];
}

// The composer auto-inserts spaces at CJK/latin/digit boundaries, so the
// rendered text can differ from the submitted message. Compare with all
// whitespace stripped.
export function normalizeMessageText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

export function replyAfterLastUserMessage(messages, message) {
  const expected = normalizeMessageText(message);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user' || normalizeMessageText(messages[index].text) !== expected) continue;
    return messages.slice(index + 1).findLast((item) => item.role === 'assistant' && item.text) || null;
  }
  return null;
}

function attachmentCounts(messages) {
  const counts = new Map();
  for (const item of messages) {
    if (item.role !== 'user') continue;
    for (const name of item.attachments || []) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

export function attachmentsConfirmed(before, after, attachments) {
  const beforeCounts = attachmentCounts(before);
  const afterCounts = attachmentCounts(after);
  const expectedCounts = new Map();
  for (const attachment of attachments.filter((item) => !item.type?.startsWith('image/'))) {
    expectedCounts.set(attachment.name, (expectedCounts.get(attachment.name) || 0) + 1);
  }
  const filesConfirmed = [...expectedCounts].every(([name, expected]) => (
    (afterCounts.get(name) || 0) - (beforeCounts.get(name) || 0) >= expected
  ));
  const expectedImages = attachments.filter((item) => item.type?.startsWith('image/')).length;
  const beforeImages = before.reduce((total, item) => total + (item.role === 'user' ? item.images || 0 : 0), 0);
  const afterImages = after.reduce((total, item) => total + (item.role === 'user' ? item.images || 0 : 0), 0);
  return filesConfirmed && afterImages - beforeImages >= expectedImages;
}

export async function readConversation(id, options = {}) {
  const timeoutMs = options.timeoutMs || 10_000;
  return withConversationPage(id, timeoutMs, async (client) => {
    // File/image blocks mount after text. Wait for the whole message snapshot
    // to settle so a reload cannot silently omit an uploaded attachment.
    const deadline = Date.now() + Math.min(5000, timeoutMs);
    let messages = [];
    let previous = '';
    let stableSince = Date.now();
    do {
      messages = await readFromClient(client);
      const snapshot = JSON.stringify(messages);
      if (snapshot !== previous) stableSince = Date.now();
      if (messages.length && Date.now() - stableSince >= 1000) break;
      previous = snapshot;
      await delay(200);
    } while (Date.now() < deadline);
    return options.limit ? messages.slice(-options.limit) : messages;
  }, { force: true });
}

function validateMessage(message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('message cannot be empty');
  if (message.length > 100_000) throw new Error('message exceeds the 100000 character limit');
}

function publicAttachments(attachments) {
  return attachments.map(({ name, size, type }) => ({ name, size, type }));
}

async function prepareComposer(client, options, timeoutMs) {
  const selectedModel = options.model ? await selectModelFromClient(client, options.model) : null;
  const attachments = options.attachments?.length
    ? await uploadAttachmentsFromClient(client, options.attachments, { timeoutMs: Math.min(timeoutMs, 60_000) })
    : [];
  return { selectedModel, attachments };
}

// Capture the app-generated local id before the composer sends. Matching the
// exact request avoids attaching an upload wait to a concurrent/newer turn.
async function clickAndIdentifyTurn(client, message) {
  let localMessageId;
  await client.send('Network.enable');
  const unsubscribe = client.subscribe('Network.requestWillBeSent', ({ request }) => {
    try {
      if (new URL(request.url).pathname !== '/chat/completion' || !request.postData) return;
      const body = JSON.parse(request.postData);
      const sent = body.messages?.find(item => normalizeMessageText(
        (item.content_block || []).map(block => block.content?.text_block?.text || '').join('\n'),
      ) === normalizeMessageText(message));
      if (sent?.local_message_id) localMessageId = sent.local_message_id;
    } catch { /* Other app requests are not this send. */ }
  });
  try {
    await client.click(SEND_BUTTON);
    const deadline = Date.now() + 5000;
    while (!localMessageId && Date.now() < deadline) await delay(50);
    if (!localMessageId) throw new Error('The composer send could not be identified; inspect the session before retrying');
    return localMessageId;
  } finally { unsubscribe(); }
}

async function sendFromClient(client, requestedId, message, options, prepared) {
  const { selectedModel, attachments } = prepared;
  const timeoutMs = options.timeoutMs || 120_000;
  const waitForReply = options.waitForReply || false;
  const before = await readFromClient(client);
  const expectedMessage = normalizeMessageText(message);
  const isSentUserMessage = (item) => item.role === 'user' && normalizeMessageText(item.text) === expectedMessage;
  const matchingUserCountBefore = before.filter(isSentUserMessage).length;
  const encodedMessage = JSON.stringify(message);

  const draft = await client.evaluate(`(async () => {
    const editor = document.querySelector(${JSON.stringify(CHAT_INPUT)});
    if (!editor) throw new Error('Doubao message editor was not found');
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, ${encodedMessage});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return (editor.innerText || '').replace(/\\n$/, '');
  })()`);
  if (normalizeMessageText(draft) !== expectedMessage) throw new Error('Doubao editor did not accept the complete message');

  const readyDeadline = Date.now() + Math.min(5000, timeoutMs);
  let ready = false;
  while (Date.now() < readyDeadline) {
    ready = await client.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(SEND_BUTTON)});
      return Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
        && button.getAttribute('data-disabled') !== 'true' && button.getAttribute('data-loading') !== 'true');
    })()`);
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error('Doubao send button is unavailable');
  // Dispatch a native CDP click after the editor has committed its state.
  const localMessageId = await clickAndIdentifyTurn(client, message);

  const deadline = Date.now() + timeoutMs;
  let messages = before;
  while (Date.now() < deadline) {
    messages = await readFromClient(client);
    const matchingUserCount = messages.filter(isSentUserMessage).length;
    if (matchingUserCount > matchingUserCountBefore) break;
    await delay(250);
  }
  const matchingUserMessages = messages.filter(isSentUserMessage);
  const matched = matchingUserMessages.length > matchingUserCountBefore ? matchingUserMessages.at(-1) : null;
  const sent = matched ? { ...matched, text: message } : null;
  if (!sent) throw new Error(`Doubao did not confirm a new sent message within ${timeoutMs} ms`);

  if (attachments.length) {
    while (Date.now() < deadline && !attachmentsConfirmed(before, messages, attachments)) {
      await delay(250);
      messages = await readFromClient(client);
    }
    if (!attachmentsConfirmed(before, messages, attachments)) {
      throw new Error(`Doubao did not confirm the sent attachments within ${timeoutMs} ms`);
    }
  }

  let conversationId = requestedId;
  if (!conversationId) {
    try { conversationId = await waitForConversationId(client, Math.max(1, deadline - Date.now())); }
    catch (error) {
      error.result = { localMessageId, status: 'unknown', reply: null, sent };
      error.message += '; acceptance could not be confirmed. Inspect the session before retrying';
      throw error;
    }
  }
  const baseResult = {
    conversationId,
    ...(selectedModel ? { model: selectedModel.name } : {}),
    ...(attachments.length ? { attachments: publicAttachments(attachments) } : {}),
    sent,
  };
  const store = await receiptStore(client);
  const receipt = { conversationId, localMessageId };
  let snapshot;
  do {
    try { snapshot = await readTurn(client, conversationId, { localMessageId, deadline }); break; }
    catch (error) {
      if (error.code !== 'turn_unavailable' || Date.now() >= deadline) {
        error.result = { ...baseResult, localMessageId, status: 'unknown', reply: null };
        throw error;
      }
      await delay(200);
    }
  } while (true);
  receipt.runId = snapshot.result.runId;
  store.save(receipt);
  if (!waitForReply) return { ...baseResult, ...receipt, status: snapshot.result.status, reply: null };
  const result = await waitTurn(client, conversationId, { receipt, deadline, onReceipt: r => store.save(r), loadReceipt: run => store.read(conversationId, run) });
  return { ...baseResult, ...result };
}

// Explicitly stop one accepted turn and confirm all its known tasks are terminal.
export async function stopConversation(id, options = {}) {
  const timeoutMs = options.timeoutMs || 15_000;
  try {
    return await withChatClient(async client => {
      const store = await receiptStore(client);
      const runId = options.runId || (await readTurn(client, id)).result.runId;
      return stopTurn(client, id, { timeoutMs, runId, receipt: store.read(id, runId), onReceipt: r => store.save(r) });
    });
  } catch (error) {
    return { ...error.result, conversationId: id, ...(options.runId ? { runId: options.runId } : {}), stopped: false, reason: error.message };
  }
}

// A receipt identifies the accepted turn even if the streaming connection is lost.
async function sendTracked(client, request, options) {
  const deadline = Date.now() + request.timeoutMs;
  const store = await receiptStore(client);
  let receipt = {};
  const onReceipt = next => {
    receipt = { ...receipt, conversationId: next.conversationId, runId: next.runId,
      localMessageId: next.localMessageId, handoffs: next.handoffs || receipt.handoffs || [],
      liveMessages: next.liveMessages || receipt.liveMessages || [], requestBody: next.requestBody || receipt.requestBody };
    store.save(receipt);
  };
  let stream;
  try {
    stream = options.mcps?.length ? await sendWithConnectors(client, { ...request, onReceipt }, options.mcps)
      : await sendChatCompletion(client, { ...request, onReceipt });
    onReceipt(stream);
  } catch (error) {
    if (error.receipt?.runId) onReceipt(error.receipt);
    if (!receipt.runId || !['timeout', 'incomplete_stream', 'exception'].includes(error.code)) {
      error.result ||= { conversationId: receipt.conversationId, runId: receipt.runId, localMessageId: receipt.localMessageId || error.receipt?.localMessageId, status: 'unknown', reply: null };
      throw error;
    }
  }
  if (!receipt.conversationId || !receipt.runId) throw new Error('Doubao did not identify the accepted turn');
  if (!request.waitForReply) return { conversationId: receipt.conversationId, runId: receipt.runId, localMessageId: receipt.localMessageId, status: 'running', reply: null };
  return waitTurn(client, receipt.conversationId, { receipt, deadline, onReceipt, loadReceipt: runId => store.read(receipt.conversationId, runId) });
}

export async function taskStatus(id, options = {}) {
  return withChatClient(async client => {
    const store = await receiptStore(client);
    const runId = options.runId || (await readTurn(client, id)).result.runId;
    const receipt = store.read(id, runId);
    return (await refreshTurn(client, id, { ...options, runId, receipt, onReceipt: r => store.save(r) })).result;
  });
}
export async function waitConversation(id, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 120000);
  return withChatClient(async client => {
    const store = await receiptStore(client);
    const runId = options.runId || (await readTurn(client, id)).result.runId;
    const receipt = store.read(id, runId);
    return waitTurn(client, id, { ...options, runId, receipt, deadline, onReceipt: r => store.save(r), loadReceipt: run => store.read(id, run) });
  });
}

// Protocol-direct send: no conversation navigation, no composer DOM, reply
// completion is verified against the server's turn/task states. Attachments require
// the legacy UI path (upload flow has not been ported).
async function sendMessageViaProtocol(id, message, options, timeoutMs) {
  const waitForReply = options.waitForReply || false;
  const effort = options.reasoning ? resolveReasoningEffort(options.reasoning) : null;
  // Changing the effort of an existing conversation goes through the modify
  // API, which requires the model key; without --model the conversation's
  // current key is unknowable without navigating the UI.
  if (effort && !options.model) throw new Error('--reasoning requires --model when sending to an existing conversation');
  try {
    return await withChatClient(async (client) => {
      let modelName = null;
      let model = modelProtocol('auto');
      if (options.model) {
        const resolved = await resolveModelFromClient(client, options.model);
        model = resolved.protocol;
        modelName = resolved.name;
        await switchConversationModel(client, id, model.key, effort?.effort);
      }
      const request = {
        conversationId: id, message, model, reasoningEffort: effort?.effort, timeoutMs, waitForReply,
        workspace: options.workspace, skillPaths: options.skillPaths, permission: options.permission,
      };
      const result = await sendTracked(client, request, options);
      return {
        ...result,
        conversationId: result.conversationId,
        ...(modelName ? { model: modelName } : {}),
        ...(effort ? { reasoning: effort.name } : {}),
        sent: { role: 'user', text: message },
        reply: result.reply,
      };
    });
  } catch (error) {
    throw error;
  }
}

// Change the reasoning effort of an existing conversation, keeping its model.
// Forces a renderer reload so the model key comes from fresh state rather
// than a UI stale from earlier server-side changes.
export async function setConversationReasoning(id, value) {
  return withConversationPage(id, 15_000, (client) => setReasoningForConversation(client, id, value), { force: true });
}

export async function sendMessage(id, message, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const deadline = Date.now() + timeoutMs;
  validateMessage(message);

  if (options.mcps?.length && options.attachments?.length) {
    throw new Error('--mcp is not supported with attachments');
  }
  if (!options.attachments?.length) {
    return sendMessageViaProtocol(id, message, options, timeoutMs);
  }
  if (options.reasoning) throw new Error('--reasoning is not supported with attachments');

  return withConversationPage(id, Math.min(remainingMilliseconds(deadline, timeoutMs), 15_000), async (client) => {
    await waitForDropTarget(client, Math.min(remainingMilliseconds(deadline, timeoutMs), 10_000));
    const prepared = await prepareComposer(client, options, remainingMilliseconds(deadline, timeoutMs));
    return sendFromClient(client, id, message, {
      ...options,
      timeoutMs: remainingMilliseconds(deadline, timeoutMs),
    }, prepared);
  });
}

export async function createConversation(message, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const deadline = Date.now() + timeoutMs;
  const hasMessage = typeof message === 'string' && message.length > 0;
  if (hasMessage) validateMessage(message);
  if (options.mcps?.length && options.attachments?.length) {
    throw new Error('--mcp is not supported with attachments');
  }

  // Protocol-direct create: the conversation id comes back in SSE_ACK,
  // no new-chat button click and no location.href polling.
  if (hasMessage && !options.attachments?.length) {
    const waitForReply = options.waitForReply || false;
    const effort = options.reasoning ? resolveReasoningEffort(options.reasoning) : null;
    try {
      return await withChatClient(async (client) => {
        let modelName = null;
        let model = modelProtocol('auto');
        if (options.model) {
          const resolved = await resolveModelFromClient(client, options.model);
          model = resolved.protocol;
          modelName = resolved.name;
        }
        const request = {
          conversationId: null, message, model, reasoningEffort: effort?.effort, timeoutMs, waitForReply,
          workspace: options.workspace, skillPaths: options.skillPaths, permission: options.permission,
        };
        const result = await sendTracked(client, request, options);
        return {
          ...result,
          conversationId: result.conversationId,
          created: true,
          persisted: true,
          ...(modelName ? { model: modelName } : {}),
          ...(effort ? { reasoning: effort.name } : {}),
          sent: { role: 'user', text: message },
          reply: result.reply,
        };
      });
    } catch (error) {
      throw error;
    }
  }

  if (options.reasoning) throw new Error('--reasoning requires sending a message without attachments');

  return withChatClient(async (client, target) => {
    // Navigating to the bare chat route yields a blank conversation without
    // clicking the new-conversation button, whose app handler raises the
    // Doubao window.
    const base = target.url.replace(/\/chat(?:\/.*)?$/u, '');
    await client.send('Page.navigate', { url: `${base}/chat` });
    const route = await waitForBlankConversation(client, Math.min(remainingMilliseconds(deadline, timeoutMs), 15_000));
    if (options.attachments?.length) {
      await waitForDropTarget(client, Math.min(remainingMilliseconds(deadline, timeoutMs), 10_000));
    }
    const prepared = await prepareComposer(client, options, remainingMilliseconds(deadline, timeoutMs));
    if (!hasMessage) {
      return {
        conversationId: null,
        created: true,
        persisted: false,
        route,
        ...(prepared.selectedModel ? { model: prepared.selectedModel.name } : {}),
        ...(prepared.attachments.length ? { attachments: publicAttachments(prepared.attachments) } : {}),
      };
    }
    const result = await sendFromClient(client, null, message, {
      ...options,
      timeoutMs: remainingMilliseconds(deadline, timeoutMs),
    }, prepared);
    return { ...result, created: true, persisted: true };
  });
}
