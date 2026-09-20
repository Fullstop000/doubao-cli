import { spawn, spawnSync } from 'node:child_process';
import { uploadAttachmentsFromClient } from './attachments.mjs';
import { withChatClient } from './cdp.mjs';
import { modelDisplayName, resolveModelId, resolveReasoningEffort, selectModelFromClient, setReasoningForConversation } from './models.mjs';
import { sendWithConnectors } from './mcp.mjs';
import { modelProtocol, sendChatCompletion, switchConversationModel } from './protocol.mjs';

const CHAT_INPUT = '[data-testid="chat_input_input"] [contenteditable="true"]';
const SEND_BUTTON = '[data-testid="chat_input_send_button"]';
const STOP_BUTTONS = '[data-testid="chat_input_local_break_button"], [data-testid="chat_input_end_button"]';

const VISIBILITY_TEST = `((element) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity) !== 0
    && rect.width > 0
    && rect.height > 0;
})`;

const GENERATING_EXPRESSION = `[...document.querySelectorAll(${JSON.stringify(STOP_BUTTONS)})].some(${VISIBILITY_TEST})`;

const CLICK_STOP_EXPRESSION = `(() => {
  const button = [...document.querySelectorAll(${JSON.stringify(STOP_BUTTONS)})].find(${VISIBILITY_TEST});
  if (!button) return false;
  button.click();
  return true;
})()`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function remainingMilliseconds(deadline, timeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Doubao operation did not complete within ${timeoutMs} ms`);
  return remaining;
}

export function conversationDeepLink(id) {
  const webUrl = `https://www.doubao.com/chat/${id}`;
  return `doubao://doubaoapp/open-url?url=${encodeURIComponent(webUrl)}`;
}

export function openConversation(id) {
  const url = conversationDeepLink(id);
  // Doubao activates itself when handling the deep link (open -g does not
  // prevent it), so remember the frontmost app and restore focus in a
  // detached watcher once that activation happens.
  const before = spawnSync('/usr/bin/osascript', [
    '-e', 'tell application "System Events" to get name of first application process whose frontmost is true',
  ], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync('/usr/bin/open', ['-g', url], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `failed to open ${url}`);
  if (before && before !== 'Doubao') {
    const restore = [
      'for i in $(seq 1 30); do',
      'cur=$(/usr/bin/osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\' 2>/dev/null);',
      'if [ "$cur" = "Doubao" ]; then',
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

// Runs callback against the chat page showing conversation id. Falls back to
// the deep link (a brief focus change) only when no chat renderer exists,
// e.g. the Doubao window was closed.
async function withConversationPage(id, timeoutMs, callback, { force = false } = {}) {
  try {
    return await withChatClient(async (client, target) => {
      await navigateToConversation(client, target, id, timeoutMs, { force });
      return await callback(client);
    });
  } catch (error) {
    if (!/no Doubao chat page found/u.test(error.message)) throw error;
  }
  openConversation(id);
  return withChatClient(async (client) => {
    await waitForConversation(client, id, timeoutMs);
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
    return messages.slice(index + 1).find((item) => item.role === 'assistant' && item.text) || null;
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
    // The composer is ready before the message list finishes rendering;
    // give the list a short grace period to populate.
    const deadline = Date.now() + Math.min(3000, timeoutMs);
    let messages = await readFromClient(client);
    while (!messages.length && Date.now() < deadline) {
      await delay(200);
      messages = await readFromClient(client);
    }
    return options.limit ? messages.slice(-options.limit) : messages;
  });
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
    const button = document.querySelector(${JSON.stringify(SEND_BUTTON)});
    if (!button || button.disabled) throw new Error('Doubao send button is unavailable');
    const text = (editor.innerText || '').replace(/\\n$/, '');
    button.click();
    return text;
  })()`);
  if (normalizeMessageText(draft) !== expectedMessage) throw new Error('Doubao editor did not accept the complete message');

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

  const conversationId = requestedId || await waitForConversationId(client, Math.min(5000, Math.max(1, deadline - Date.now())));
  const baseResult = {
    conversationId,
    ...(selectedModel ? { model: selectedModel.name } : {}),
    ...(attachments.length ? { attachments: publicAttachments(attachments) } : {}),
    sent,
  };
  if (!waitForReply) return { ...baseResult, reply: null };

  let stableText = '';
  let stablePolls = 0;
  while (Date.now() < deadline) {
    messages = await readFromClient(client);
    const reply = replyAfterLastUserMessage(messages, message);
    const generating = await client.evaluate(GENERATING_EXPRESSION);
    if (reply?.text && reply.text === stableText && !generating) stablePolls += 1;
    else stablePolls = 0;
    stableText = reply?.text || '';
    if (reply && stablePolls >= 2) return { ...baseResult, reply };
    await delay(500);
  }
  throw new Error(`Doubao reply did not complete within ${timeoutMs} ms`);
}

// Stops an in-flight generation by clicking the composer's break/end button
// and confirming it disappears. Best-effort cleanup: returns
// { conversationId, stopped } instead of throwing when the page cannot be
// reached or generation does not stop in time.
export async function stopConversation(id, options = {}) {
  const timeoutMs = options.timeoutMs || 15_000;
  try {
    return await withConversationPage(id, timeoutMs, async (client) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!await client.evaluate(GENERATING_EXPRESSION)) {
          return { conversationId: id, stopped: true };
        }
        await client.evaluate(CLICK_STOP_EXPRESSION);
        await delay(500);
      }
      return { conversationId: id, stopped: false, reason: 'generation did not stop in time' };
    });
  } catch (error) {
    return { conversationId: id, stopped: false, reason: error.message };
  }
}

// After a stream failure the model may still be generating server-side;
// cancel it through the UI and record the outcome on the error.
async function stopAfterStreamFailure(error, id) {
  if (error.code !== 'timeout' && error.code !== 'incomplete_stream') return;
  const target = error.conversationId || id;
  if (!target) return;
  const stop = await stopConversation(target, { timeoutMs: 10_000 });
  error.stopped = stop.stopped;
}

// Protocol-direct send: no conversation navigation, no composer DOM, reply
// completion is decided by the SSE stream itself. Attachments still require
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
        const modelIdValue = resolveModelId(options.model);
        model = modelProtocol(modelIdValue);
        modelName = modelDisplayName(modelIdValue);
        await switchConversationModel(client, id, model.key, effort?.effort);
      }
      const request = {
        conversationId: id, message, model, reasoningEffort: effort?.effort, timeoutMs, waitForReply,
        workspace: options.workspace, skillPaths: options.skillPaths,
      };
      const result = options.mcps?.length
        ? await sendWithConnectors(client, request, options.mcps)
        : await sendChatCompletion(client, request);
      return {
        conversationId: result.conversationId,
        ...(modelName ? { model: modelName } : {}),
        ...(effort ? { reasoning: effort.name } : {}),
        sent: { role: 'user', text: message },
        reply: waitForReply ? { role: 'assistant', text: result.answer } : null,
      };
    });
  } catch (error) {
    await stopAfterStreamFailure(error, id);
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
          const modelIdValue = resolveModelId(options.model);
          model = modelProtocol(modelIdValue);
          modelName = modelDisplayName(modelIdValue);
        }
        const request = {
          conversationId: null, message, model, reasoningEffort: effort?.effort, timeoutMs, waitForReply,
          workspace: options.workspace, skillPaths: options.skillPaths,
        };
        const result = options.mcps?.length
          ? await sendWithConnectors(client, request, options.mcps)
          : await sendChatCompletion(client, request);
        return {
          conversationId: result.conversationId,
          created: true,
          persisted: true,
          ...(modelName ? { model: modelName } : {}),
          ...(effort ? { reasoning: effort.name } : {}),
          sent: { role: 'user', text: message },
          reply: waitForReply ? { role: 'assistant', text: result.answer } : null,
        };
      });
    } catch (error) {
      await stopAfterStreamFailure(error, null);
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
