import { spawnSync } from 'node:child_process';
import { withChatClient } from './cdp.mjs';
import { selectModelFromClient } from './models.mjs';

const CHAT_INPUT = '[data-testid="chat_input_input"] [contenteditable="true"]';
const SEND_BUTTON = '[data-testid="chat_input_send_button"]';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function waitForConversation(client, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`({ href: location.href, ready: Boolean(document.querySelector(${JSON.stringify(CHAT_INPUT)})) })`);
    if (state?.ready && new RegExp(`/chat/${id}(?:[?#]|$)`, 'u').test(state.href)) return state.href;
    await delay(200);
  }
  throw new Error(`Doubao did not open conversation ${id} within ${timeoutMs} ms`);
}

const READ_MESSAGES_EXPRESSION = `(() => [...document.querySelectorAll('[data-testid="union_message"]')]
  .map((element) => {
    const role = element.querySelector('[data-testid="send_message"]')
      ? 'user'
      : element.querySelector('[data-testid="receive_message"]') ? 'assistant' : null;
    const parts = [...element.querySelectorAll('[data-testid="message_text_content"]')]
      .map((part) => (part.innerText || '').trim())
      .filter(Boolean);
    return role && parts.length ? { role, text: parts.join('\\n') } : null;
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

export async function readConversation(id, options = {}) {
  const timeoutMs = options.timeoutMs || 10_000;
  openConversation(id);
  return withChatClient(async (client) => {
    await waitForConversation(client, id, timeoutMs);
    const messages = await readFromClient(client);
    return options.limit ? messages.slice(-options.limit) : messages;
  });
}

export async function sendMessage(id, message, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const waitForReply = options.waitForReply || false;
  if (typeof message !== 'string' || !message.trim()) throw new Error('message cannot be empty');
  if (message.length > 100_000) throw new Error('message exceeds the 100000 character limit');

  openConversation(id);
  return withChatClient(async (client) => {
    await waitForConversation(client, id, Math.min(timeoutMs, 15_000));
    const selectedModel = options.model ? await selectModelFromClient(client, options.model) : null;
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

    if (!waitForReply) {
      return { conversationId: id, ...(selectedModel ? { model: selectedModel.name } : {}), sent, reply: null };
    }

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
      if (reply && stablePolls >= 2) {
        return { conversationId: id, ...(selectedModel ? { model: selectedModel.name } : {}), sent, reply };
      }
      await delay(500);
    }
    throw new Error(`Doubao reply did not complete within ${timeoutMs} ms`);
  });
}
