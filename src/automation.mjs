import { spawnSync } from 'node:child_process';
import { uploadAttachmentsFromClient } from './attachments.mjs';
import { withChatClient } from './cdp.mjs';
import { modelDisplayName, resolveModelId, selectModelFromClient } from './models.mjs';
import { modelProtocol, sendChatCompletion, switchConversationModel } from './protocol.mjs';

const CHAT_INPUT = '[data-testid="chat_input_input"] [contenteditable="true"]';
const SEND_BUTTON = '[data-testid="chat_input_send_button"]';
const CREATE_BUTTON = '[data-testid="create_conversation_button"]';
const CREATE_OFFICE_TASK = '[data-testid="create_office_task_button"]';

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
  const result = spawnSync('/usr/bin/open', [url], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `failed to open ${url}`);
  return url;
}

export function conversationIdFromUrl(url) {
  return /\/chat\/(\d{12,24})(?:[?#]|$)/u.exec(url || '')?.[1] || null;
}

async function waitForConversation(client, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`({ href: location.href, ready: Boolean(document.querySelector(${JSON.stringify(CHAT_INPUT)})) })`);
    if (state?.ready && new RegExp(`/chat/${id}(?:[?#]|$)`, 'u').test(state.href)) return state.href;
    await delay(200);
  }
  throw new Error(`Doubao did not open conversation ${id} within ${timeoutMs} ms`);
}

async function waitForBlankConversation(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`({
      href: location.href,
      ready: Boolean(document.querySelector(${JSON.stringify(CHAT_INPUT)})),
    })`);
    if (state?.ready && /\/chat(?:[?#]|$)/u.test(state.href)) return state.href;
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

export function replyAfterLastUserMessage(messages, message) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user' || messages[index].text !== message) continue;
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
  openConversation(id);
  return withChatClient(async (client) => {
    await waitForConversation(client, id, timeoutMs);
    const messages = await readFromClient(client);
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
  const matchingUserCountBefore = before.filter((item) => item.role === 'user' && item.text === message).length;
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
  if (draft !== message) throw new Error('Doubao editor did not accept the complete message');

  const deadline = Date.now() + timeoutMs;
  let messages = before;
  while (Date.now() < deadline) {
    messages = await readFromClient(client);
    const matchingUserCount = messages.filter((item) => item.role === 'user' && item.text === message).length;
    if (matchingUserCount > matchingUserCountBefore) break;
    await delay(250);
  }
  const matchingUserMessages = messages.filter((item) => item.role === 'user' && item.text === message);
  const sent = matchingUserMessages.length > matchingUserCountBefore ? matchingUserMessages.at(-1) : null;
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
    const generating = await client.evaluate(`[
      ...document.querySelectorAll('[data-testid="chat_input_local_break_button"], [data-testid="chat_input_end_button"]'),
    ].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    })`);
    if (reply?.text && reply.text === stableText && !generating) stablePolls += 1;
    else stablePolls = 0;
    stableText = reply?.text || '';
    if (reply && stablePolls >= 2) return { ...baseResult, reply };
    await delay(500);
  }
  throw new Error(`Doubao reply did not complete within ${timeoutMs} ms`);
}

// Protocol-direct send: no conversation navigation, no composer DOM, reply
// completion is decided by the SSE stream itself. Attachments still require
// the legacy UI path (upload flow has not been ported).
async function sendMessageViaProtocol(id, message, options, timeoutMs) {
  const waitForReply = options.waitForReply || false;
  return withChatClient(async (client) => {
    let modelName = null;
    let model = modelProtocol('auto');
    if (options.model) {
      const modelIdValue = resolveModelId(options.model);
      model = modelProtocol(modelIdValue);
      modelName = modelDisplayName(modelIdValue);
      await switchConversationModel(client, id, model.key);
    }
    const result = await sendChatCompletion(client, {
      conversationId: id, message, model, timeoutMs, waitForReply,
    });
    return {
      conversationId: result.conversationId,
      ...(modelName ? { model: modelName } : {}),
      sent: { role: 'user', text: message },
      reply: waitForReply ? { role: 'assistant', text: result.answer } : null,
    };
  });
}

export async function sendMessage(id, message, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const deadline = Date.now() + timeoutMs;
  validateMessage(message);

  if (!options.attachments?.length) {
    return sendMessageViaProtocol(id, message, options, timeoutMs);
  }

  openConversation(id);
  return withChatClient(async (client) => {
    await waitForConversation(client, id, Math.min(remainingMilliseconds(deadline, timeoutMs), 15_000));
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

  // Protocol-direct create: the conversation id comes back in SSE_ACK,
  // no new-chat button click and no location.href polling.
  if (hasMessage && !options.attachments?.length) {
    const waitForReply = options.waitForReply || false;
    return withChatClient(async (client) => {
      let modelName = null;
      let model = modelProtocol('auto');
      if (options.model) {
        const modelIdValue = resolveModelId(options.model);
        model = modelProtocol(modelIdValue);
        modelName = modelDisplayName(modelIdValue);
      }
      const result = await sendChatCompletion(client, {
        conversationId: null, message, model, timeoutMs, waitForReply,
      });
      return {
        conversationId: result.conversationId,
        created: true,
        persisted: true,
        ...(modelName ? { model: modelName } : {}),
        sent: { role: 'user', text: message },
        reply: waitForReply ? { role: 'assistant', text: result.answer } : null,
      };
    });
  }

  return withChatClient(async (client) => {
    const createSelector = await client.evaluate(`document.querySelector(${JSON.stringify(CREATE_BUTTON)})
      ? ${JSON.stringify(CREATE_BUTTON)}
      : document.querySelector(${JSON.stringify(CREATE_OFFICE_TASK)}) ? ${JSON.stringify(CREATE_OFFICE_TASK)} : null`);
    if (!createSelector) throw new Error('Doubao new conversation button was not found');
    await client.click(createSelector);
    const route = await waitForBlankConversation(client, Math.min(remainingMilliseconds(deadline, timeoutMs), 15_000));
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
