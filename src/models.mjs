import { withChatClient } from './cdp.mjs';
import { modelProtocol, switchConversationModel } from './protocol.mjs';

const MODEL_TRIGGER = '[data-valid-btn="model-select-action-btn"]';
const MODEL_OPTION = '[role="menuitem"][data-slot="dropdown-menu-item"]';

const MODEL_IDS = new Map([
  ['自动', 'auto'],
  ['豆包 2.1 Turbo', 'doubao-2.1-turbo'],
  ['豆包 2.1 Pro', 'doubao-2.1-pro'],
  ['Orange 5.0', 'orange-5.0'],
  ['Gemini 3.7 Flash', 'gemini-3.7-flash'],
  ['GPT-5.6 Sol', 'gpt-5.6-sol'],
]);

const ALIASES = new Map([
  ['auto', '自动'],
  ['自动', '自动'],
  ['turbo', '豆包 2.1 Turbo'],
  ['doubao turbo', '豆包 2.1 Turbo'],
  ['doubao 2.1 turbo', '豆包 2.1 Turbo'],
  ['pro', '豆包 2.1 Pro'],
  ['doubao pro', '豆包 2.1 Pro'],
  ['doubao 2.1 pro', '豆包 2.1 Pro'],
  ['orange', 'Orange 5.0'],
  ['orange 5.0', 'Orange 5.0'],
  ['gemini', 'Gemini 3.7 Flash'],
  ['gemini flash', 'Gemini 3.7 Flash'],
  ['gemini 3.7 flash', 'Gemini 3.7 Flash'],
  ['gpt', 'GPT-5.6 Sol'],
  ['sol', 'GPT-5.6 Sol'],
  ['gpt sol', 'GPT-5.6 Sol'],
  ['gpt 5.6 sol', 'GPT-5.6 Sol'],
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeModelName(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ');
}

export function modelId(name) {
  return MODEL_IDS.get(name) || normalizeModelName(name).replaceAll(' ', '-');
}

export function resolveModelName(value, availableNames) {
  const normalized = normalizeModelName(value);
  if (!normalized) throw new Error('model cannot be empty');
  const exact = availableNames.find((name) => normalizeModelName(name) === normalized);
  const alias = ALIASES.get(normalized);
  const resolved = exact || (alias && availableNames.includes(alias) ? alias : null);
  if (resolved) return resolved;
  throw new Error(`unknown model "${value}". Available models: ${availableNames.join(', ')}`);
}

// UI-free model resolution against the built-in model table. Used by the
// protocol-direct paths where opening the model menu is unnecessary.
export function resolveModelId(value) {
  const name = resolveModelName(value, [...MODEL_IDS.keys()]);
  return MODEL_IDS.get(name);
}

export function modelDisplayName(id) {
  for (const [name, candidate] of MODEL_IDS) if (candidate === id) return name;
  return id;
}

// Switch the model of an existing conversation through the
// im/conversation/modify API (cmd=1114) instead of the menu UI.
export async function selectModelForConversation(client, conversationId, value) {
  const id = resolveModelId(value);
  await switchConversationModel(client, conversationId, modelProtocol(id).key);
  return { id, name: modelDisplayName(id), changed: true };
}

async function waitFor(client, expression, timeoutMs = 3000, errorMessage = 'Doubao model menu did not respond') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await client.evaluate(expression);
    if (value) return value;
    await delay(50);
  }
  throw new Error(errorMessage);
}

async function closeModelMenu(client, menuId) {
  await client.pressEscape();
  await waitFor(client, `(() => {
    const trigger = document.querySelector(${JSON.stringify(MODEL_TRIGGER)});
    const controlledId = ${JSON.stringify(menuId || '')} || trigger?.getAttribute('aria-controls');
    const menu = controlledId ? document.getElementById(controlledId) : null;
    return trigger?.getAttribute('data-state') !== 'open'
      && (!menu || menu.getAttribute('data-state') !== 'open') ? true : null;
  })()`, 1500).catch(() => {});
  await delay(50);
}

export async function currentModelFromClient(client) {
  const state = await waitFor(client, `(() => {
    const trigger = document.querySelector(${JSON.stringify(MODEL_TRIGGER)});
    const button = trigger?.querySelector(':scope > button');
    if (!button) return null;
    const lines = (button.innerText || button.textContent || '')
      .split('\\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { name: lines[0] || null, reasoning: lines.slice(1).join(' ') || null };
  })()`, 5000, 'Doubao model selector was not found');
  if (!state?.name) throw new Error('Doubao current model could not be read');
  return { id: modelId(state.name), ...state };
}

async function openModelMenu(client) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await closeModelMenu(client);
    await client.click(MODEL_TRIGGER);
    try {
      return await waitFor(client, `(() => {
        const trigger = document.querySelector(${JSON.stringify(MODEL_TRIGGER)});
        const menuId = trigger?.getAttribute('aria-controls');
        const menu = menuId ? document.getElementById(menuId) : null;
        return menu?.getAttribute('data-state') === 'open' ? menuId : null;
      })()`, 1500);
    } catch (error) {
      await closeModelMenu(client);
      if (attempt === 1) throw error;
    }
  }
  throw new Error('Doubao model menu did not respond');
}

async function readOpenOptions(client, menuId) {
  const options = await client.evaluate(`(() => {
    const menu = document.getElementById(${JSON.stringify(menuId)});
    if (!menu) return [];
    return [...menu.querySelectorAll(${JSON.stringify(MODEL_OPTION)})]
      .map((item, index) => {
        const label = item.querySelector('span.shrink-0') || item.querySelector('span');
        const name = (label?.innerText || label?.textContent || '').trim();
        return name ? { index, name, selected: Boolean(item.querySelector(':scope > svg')) } : null;
      })
      .filter(Boolean);
  })()`);
  if (!options?.length) throw new Error('Doubao model menu contains no model options');
  return options;
}

export async function listModelsFromClient(client) {
  const current = await currentModelFromClient(client);
  let menuId;
  try {
    menuId = await openModelMenu(client);
    const options = await readOpenOptions(client, menuId);
    return {
      current: current.name,
      reasoning: current.reasoning,
      models: options.map(({ name, selected }) => ({ id: modelId(name), name, selected: selected || name === current.name })),
    };
  } finally {
    if (menuId) await closeModelMenu(client, menuId);
  }
}

export async function selectModelFromClient(client, value) {
  const before = await currentModelFromClient(client);
  let menuId;
  let marker;
  try {
    menuId = await openModelMenu(client);
    const options = await readOpenOptions(client, menuId);
    const name = resolveModelName(value, options.map((option) => option.name));
    if (name === before.name) return { ...before, changed: false };

    marker = `doubao-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const marked = await client.evaluate(`(() => {
      const menu = document.getElementById(${JSON.stringify(menuId)});
      const item = [...(menu?.querySelectorAll(${JSON.stringify(MODEL_OPTION)}) || [])]
        .find((candidate) => {
          const label = candidate.querySelector('span.shrink-0') || candidate.querySelector('span');
          return (label?.innerText || label?.textContent || '').trim() === ${JSON.stringify(name)};
        });
      if (!item) return false;
      item.setAttribute('data-doubao-cli-model-option', ${JSON.stringify(marker)});
      return true;
    })()`);
    if (!marked) throw new Error(`Doubao model option "${name}" disappeared`);
    await client.click(`[data-doubao-cli-model-option="${marker}"]`);
    const selected = await waitFor(client, `(() => {
      const trigger = document.querySelector(${JSON.stringify(MODEL_TRIGGER)});
      const button = trigger?.querySelector(':scope > button');
      const firstLine = (button?.innerText || button?.textContent || '').split('\\n')[0].trim();
      return firstLine === ${JSON.stringify(name)} ? true : null;
    })()`);
    if (!selected) throw new Error(`Doubao did not select model "${name}"`);
    return { ...(await currentModelFromClient(client)), changed: true };
  } finally {
    if (marker) {
      await client.evaluate(`document.querySelector('[data-doubao-cli-model-option=${JSON.stringify(marker)}]')
        ?.removeAttribute('data-doubao-cli-model-option')`).catch(() => {});
    }
    if (menuId) await closeModelMenu(client, menuId);
  }
}

export async function currentModel() {
  return withChatClient((client) => currentModelFromClient(client));
}

export async function listModels() {
  return withChatClient((client) => listModelsFromClient(client));
}

export async function selectModel(value, conversationId) {
  if (conversationId) {
    return withChatClient((client) => selectModelForConversation(client, conversationId, value));
  }
  return withChatClient((client) => selectModelFromClient(client, value));
}
