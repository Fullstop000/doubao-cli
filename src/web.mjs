import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentApp, isAppTarget } from './app.mjs';
import { CdpClient, cdpStatus, findChatTarget, withChatClient } from './cdp.mjs';
import { observeWebSend } from './web-stream.mjs';
import { imRequest, readTurn, waitTurn, stopTurn, receiptStore, messageText } from './turns.mjs';

const INPUT = 'textarea[data-testid="chat_input_input"], [data-testid="chat_input_input"] [contenteditable="true"]';
const INPUT_AREA = '[data-testid="chat_input_input"]';
const SEND = '[data-testid="chat_input_send_button"]';
const ID = /^\d{12,24}$/u;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateWebOptions(options) {
  const [command, subcommand] = options.args;
  if (!command || ['help', '--help', '-h', 'version', '--version', '-v', 'update'].includes(command)) return;
  const unsupported = [
    ['--profile', options.profile !== undefined],
    ['--attach', options.attachments.length], ['--model', options.model !== undefined],
    ['--reasoning', options.reasoning !== undefined], ['--runtime local', options.runtime === 'local'],
    ['--project', options.project !== undefined], ['--enterprise-knowledge', options.enterpriseKnowledge],
    ['--workspace', options.workspace !== undefined], ['--no-skills', options.noSkills],
    ['--permission', options.permission !== undefined], ['--mcp', options.mcps.length],
    ['--command', options.commandPath !== undefined], ['--arg', options.commandArgs.length],
    ['--env', options.envPairs.length],
  ].find(([, supplied]) => supplied);
  if (unsupported) throw new Error(`${unsupported[0]} is not supported on doubao web; use a desktop platform for task features`);
  const supported = ['login', 'status', 'capabilities'].includes(command)
    || command === 'cdp' && ['status', 'launch'].includes(subcommand)
    || command === 'sessions' && ['list', 'current', 'open', 'read', 'create', 'send', 'status', 'wait', 'stop'].includes(subcommand);
  if (!supported) throw new Error(`${options.args.slice(0, 2).join(' ')} is not supported on doubao web`);
  if (command === 'login' && options.args.length !== 1) throw new Error('doubao web login accepts no positional arguments');
  if (options.wait && (command !== 'sessions' || !['create', 'send'].includes(subcommand))) {
    throw new Error('Web --wait requires sessions create/send with a message');
  }
  if (options.wait && !options.args.slice(subcommand === 'create' ? 2 : 3).join(' ').trim()) {
    throw new Error('Web --wait requires a message');
  }
}

export const WEB_STATE = `(() => {
  const visible = e => Boolean(e && e.getBoundingClientRect().width && e.getBoundingClientRect().height && getComputedStyle(e).visibility !== 'hidden');
  const input = [...document.querySelectorAll(${JSON.stringify(INPUT)})]
    .find(e => visible(e) && visible(e.closest(${JSON.stringify(INPUT_AREA)})));
  const send = [...document.querySelectorAll(${JSON.stringify(SEND)})].find(visible);
  const loginRequired = visible(document.querySelector('[data-testid="to_login_button"]'));
  const modeLabel = document.querySelector('[data-testid="chat_input_action_mode"]')?.innerText?.trim() || null;
  const mode = modeLabel === '对话' ? 'chat' : modeLabel?.includes('云电脑') ? 'work' : null;
  let accountId = null;
  try { accountId = localStorage.getItem('flow_tea_user_id'); } catch {}
  return { href: location.href, loginRequired, ready: Boolean(input) && !loginRequired,
    mode, modeLabel, accountId, draft: (input?.value ?? input?.innerText ?? '').trim(),
    sendEnabled: Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'),
    attachments: document.querySelectorAll('[data-testid="attachment_area"] [data-testid="attachment_file_item"], [data-testid="attachment_area"] [data-testid="mdbox_image"]').length,
    generating: visible(document.querySelector('[data-testid="chat_input_local_break_button"]')) };
})()`;

function conversationId(url) {
  if (!isAppTarget(url)) throw new Error('Selected web target left the Doubao chat origin');
  return /\/chat\/(\d{12,24})(?:\/)?(?:[?#]|$)/u.exec(url)?.[1] || null;
}

function validateId(value) {
  if (!ID.test(value || '')) throw new Error('conversation id must contain 12 to 24 digits');
  return value;
}

export function assertWebReady(state, { ordinary = false, idle = false } = {}) {
  if (!isAppTarget(state?.href)) throw new Error('Selected web target left the Doubao chat origin');
  if (state.loginRequired) throw new Error('Doubao Web requires login in the selected browser; sign in there, then retry');
  if (!state.ready) throw new Error('Doubao Web composer is not ready; open a signed-in chat page and retry');
  if (ordinary && state.mode !== 'chat') throw new Error('Select an ordinary 对话 before retrying');
  if (idle && (state.draft || state.attachments)) throw new Error('Doubao Web has an unsent draft or attachments; clear or send it in the browser before retrying');
  if (idle && state.generating) throw new Error('Doubao Web is generating; wait for it to finish before retrying');
}

async function pageState(client) {
  const state = await client.evaluate(WEB_STATE);
  assertPinnedAccount(state);
  return state;
}

function assertPinnedAccount(state) {
  const pinned = currentApp().accountId;
  if (pinned !== undefined && state?.accountId !== pinned) {
    throw new Error('Doubao Web account changed; select the originally authenticated account');
  }
}

function sidebarSessionsExpression(accountId) {
  return `(() => {
    const assertIdentity = () => {
      let url, uid = null;
      try { url = new URL(location.href); uid = localStorage.getItem('flow_tea_user_id'); } catch {}
      if (!url || url.protocol !== 'https:' || !['www.doubao.com', 'doubao.com'].includes(url.hostname)
        || url.username || url.password || url.port || !/^\\/chat(?:\\/|$)/.test(url.pathname)) {
        throw new Error('Selected web target left the Doubao chat origin');
      }
      if (uid !== ${JSON.stringify(accountId)}) {
        throw new Error('Doubao Web account changed; select the originally authenticated account');
      }
    };
    assertIdentity();
    const sessions = [...new Map([...document.querySelectorAll('[data-testid="chat_list_item"][data-conversation-id], [data-testid="conversation-list-v2-item"][data-conversation-id]')]
      .map(e => ({ id: e.getAttribute('data-conversation-id'), title: e.querySelector('[data-testid="chat_list_item_title"]')?.innerText?.trim() || e.innerText?.trim() || null }))
      .filter(e => /^\\d{12,24}$/.test(e.id)).map(e => [e.id, e])).values()];
    assertIdentity();
    return sessions;
  })()`;
}

async function withWebFocus(client, operation) {
  let result;
  let operationError;
  try {
    // Background tabs can defer native input handlers even when the composer is visible.
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    result = await operation();
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch (error) {
      if (operationError) operationError.focusRestoreError = error.message;
      else {
        error.result = result;
        throw error;
      }
    }
  }
}

function isLocalDraftRoute(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['www.doubao.com', 'doubao.com'].includes(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.port
      && /^\/chat\/local_\d{12,24}$/u.test(parsed.pathname);
  } catch { return false; }
}

async function waitReady(client, id, timeoutMs, { allowLocalDraft = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const state = await pageState(client);
      // Navigation can temporarily preserve the old renderer. Check both route and composer.
      let routeMatches = false;
      try { routeMatches = conversationId(state.href) === id; }
      catch (error) {
        if (!allowLocalDraft || !isLocalDraftRoute(state.href)) throw error;
      }
      if (routeMatches && state.ready && ['chat', 'work'].includes(state.mode)) return state;
      if (state.loginRequired) assertWebReady(state);
    } catch (error) {
      if (!/execution context|context was destroyed|Cannot find context/iu.test(error.message)) throw error;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Doubao Web navigation did not become ready in time');
}

export async function navigateWeb(client, id, timeoutMs) {
  const before = await pageState(client);
  assertWebReady(before);
  if (conversationId(before.href) !== id) {
    assertWebReady(before, { idle: true });
    const url = new URL(id ? `/chat/${id}` : '/chat/', before.href).href;
    const navigation = await client.send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(`Doubao Web navigation failed: ${navigation.errorText}`);
  }
  return waitReady(client, id, timeoutMs);
}

async function newWebConversation(client, mode, timeoutMs) {
  if (!['chat', 'work'].includes(mode)) throw new Error('Select a ready 对话 or 云电脑 composer, or pass --mode chat|work');
  const before = await pageState(client);
  assertWebReady(before, { idle: true });
  if (currentApp().accountId === undefined) currentApp().accountId = before.accountId;
  const selector = mode === 'work' ? '[data-testid="create_office_task_button"]' : '[data-testid="create_conversation_button"]';
  await client.click(selector);
  const state = await waitReady(client, null, timeoutMs);
  if (state.mode !== mode) throw new Error(`The selected web account does not expose a ready ${mode} composer; choose its account or runtime in the browser`);
  return state;
}

function canonicalPath(value) {
  let directory = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) break;
    suffix.unshift(path.basename(directory));
    directory = parent;
  }
  return path.join(fs.realpathSync(directory), ...suffix);
}

export function webLaunchSpec(env = process.env) {
  const endpoint = new URL(currentApp().endpoint);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:'
      || endpoint.username || endpoint.password || endpoint.pathname !== '/') {
    throw new Error('Web cdp launch requires a localhost HTTP CDP endpoint');
  }
  const settings = env.DOUBAO_CLI_CONFIG_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'doubao-cli');
  const profileDir = canonicalPath(env.DOUBAO_WEB_PROFILE_DIR || path.join(settings, 'web-browser'));
  const defaultChromeDir = canonicalPath(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'));
  if (profileDir === defaultChromeDir || profileDir.startsWith(defaultChromeDir + path.sep)) {
    throw new Error('Web CDP requires a dedicated browser data directory, outside the default Chrome profile');
  }
  const appPath = env.DOUBAO_BROWSER_APP || '/Applications/Google Chrome.app';
  return { appPath, profileDir, command: '/usr/bin/open', args: ['-na', appPath, '--args',
    `--remote-debugging-port=${endpoint.port || currentApp().port}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', 'https://www.doubao.com/chat/'] };
}

async function launchWeb({ deadline = Date.now() + 30_000, inspect = true, onLaunched } = {}) {
  const checkDeadline = () => { if (Date.now() >= deadline) throw new Error('Web browser startup timed out'); };
  checkDeadline();
  const existing = await cdpStatus(currentApp().endpoint, deadline - Date.now());
  checkDeadline();
  if (existing.available) return { ...(inspect ? await webStatus(existing) : { cdp: existing }), launched: false, restarted: false };
  if (existing.identityMismatch) throw new Error(existing.error);
  if (process.platform !== 'darwin') throw new Error('Automatic Web browser launch currently requires macOS; set DOUBAO_CDP_ENDPOINT to a browser CDP endpoint');
  const spec = webLaunchSpec();
  if (!fs.existsSync(spec.appPath)) throw new Error(`browser app not found: ${spec.appPath}; set DOUBAO_BROWSER_APP`);
  checkDeadline();
  fs.mkdirSync(spec.profileDir, { recursive: true, mode: 0o700 });
  checkDeadline();
  const result = spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()) });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'failed to launch the dedicated Web browser');
  onLaunched?.({ launched: true, restarted: false, browserProfileDir: spec.profileDir });
  do {
    checkDeadline();
    await delay(Math.min(250, deadline - Date.now()));
    checkDeadline();
    const cdp = await cdpStatus(currentApp().endpoint, deadline - Date.now());
    checkDeadline();
    if (cdp.available) return { ...(inspect ? await webStatus(cdp) : { cdp }), launched: true, restarted: false, browserProfileDir: spec.profileDir };
    if (cdp.identityMismatch && currentApp().targetId) throw new Error(cdp.error);
  } while (Date.now() < deadline);
  throw new Error(`Web browser did not become ready at ${currentApp().endpoint}; close only the dedicated automation browser and retry doubao web login`);
}

export async function webLogin({ timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let client;
  let last = { platform: 'web', app: 'web', cdpEndpoint: currentApp().endpoint,
    targetId: currentApp().targetId || null, ready: false, loginRequired: null,
    loggedIn: false, launched: false, restarted: false };
  const timeoutError = () => Object.assign(new Error('Login timed out; complete sign-in in the browser, then run doubao web login again'), { code: 'login_timeout' });
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw timeoutError();
    return ms;
  };
  const observe = async operation => {
    const ms = remaining();
    let timer;
    try {
      const value = await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), ms); })]);
      remaining();
      return value;
    } finally { clearTimeout(timer); }
  };
  try {
    let cdp = await observe(() => cdpStatus(currentApp().endpoint, remaining()));
    last.cdp = cdp;
    if (cdp.identityMismatch) {
      if (currentApp().targetId || cdp.targetIds?.length) throw new Error(cdp.error);
      // Reuse this browser when its Doubao tab was closed. Never choose another account's tab.
      const response = await observe(() => fetch(`${currentApp().endpoint}/json/version`, { signal: AbortSignal.timeout(remaining()) }));
      if (!response.ok) throw new Error(`Browser discovery failed: HTTP ${response.status}`);
      const version = await observe(() => response.json());
      if (!version.webSocketDebuggerUrl) throw new Error('Browser discovery did not provide a browser connection');
      const browser = new CdpClient(version.webSocketDebuggerUrl);
      try {
        await observe(() => browser.connect());
        last.openAttempted = true;
        const created = await observe(() => browser.send('Target.createTarget', { url: 'https://www.doubao.com/chat/' }));
        if (!created.targetId) throw new Error('The browser did not return a login page target');
        currentApp().targetId = created.targetId;
        last.opened = true;
      } finally { browser.close(); }
      do {
        cdp = await observe(() => cdpStatus(currentApp().endpoint, remaining()));
        last.cdp = cdp;
        if (!cdp.available) await observe(() => delay(Math.min(250, remaining())));
      } while (!cdp.available);
    } else if (!cdp.available) {
      if (currentApp().targetId) throw new Error(`Selected Web target ${currentApp().targetId} is unavailable; reconnect its browser or run doubao web login without --target to start the dedicated browser`);
      const launched = await observe(() => launchWeb({ deadline, inspect: false,
        onLaunched: state => { last = { ...last, ...state }; } }));
      last = { ...last, ...launched };
      cdp = launched.cdp;
    }
    if (!cdp.available) throw new Error(cdp.error || 'The Doubao login page is unavailable');
    if (cdp.targetIds?.length > 1 && !currentApp().targetId) {
      throw new Error(`multiple Doubao Web chat pages found; select --target <id>. Matching target IDs: ${cdp.targetIds.join(', ')}`);
    }
    const target = await observe(() => findChatTarget(currentApp().endpoint, remaining()));
    last.targetId = target.id;
    client = new CdpClient(target.webSocketDebuggerUrl);
    await observe(() => client.connect());
    let prompted = false;
    let observedChat = false;
    for (;;) {
      let state;
      try { state = await observe(() => client.evaluate(WEB_STATE)); }
      catch (error) {
        if (!/execution context|context was destroyed|Cannot find context/iu.test(error.message)) throw error;
        await observe(() => delay(Math.min(500, remaining())));
        continue;
      }
      if (!isAppTarget(state.href)) {
        // Discovery can report the requested chat URL before Chrome commits its first document.
        if (state.href === 'about:blank' && !observedChat) {
          await observe(() => delay(Math.min(250, remaining())));
          continue;
        }
        throw new Error('Selected web target left the Doubao chat origin');
      }
      observedChat = true;
      const signedIn = Boolean(state.accountId && state.accountId !== '0' && !state.loginRequired);
      last = { ...last, ready: Boolean(signedIn && state.ready && ['chat', 'work'].includes(state.mode)),
        loginRequired: state.loginRequired, accountId: state.accountId, mode: state.mode,
        modeLabel: state.modeLabel, conversationId: conversationId(state.href) };
      if (last.ready) return { ...last, loggedIn: true };
      if (!prompted) {
        await observe(() => client.send('Page.bringToFront'));
        console.error('Complete sign-in in the Doubao browser window. Waiting for the account and chat page to become ready.');
        prompted = true;
      }
      await observe(() => delay(Math.min(500, remaining())));
    }
  } catch (error) {
    if (Date.now() >= deadline) error = timeoutError();
    error.result = { ...last, loggedIn: false };
    throw error;
  } finally { client?.close(); }
}

export async function webStatus(cdp = undefined) {
  cdp ||= await cdpStatus();
  const status = { platform: 'web', app: 'web', cdpEndpoint: currentApp().endpoint, cdp,
    ready: false, loginRequired: null, conversationId: null, targetId: currentApp().targetId || null };
  if (!cdp.available) return status;
  if (cdp.targetIds?.length > 1 && !currentApp().targetId) return { ...status, requiresTarget: true };
  return withChatClient(async (client, target) => {
    const state = await pageState(client);
    return { ...status, ready: state.ready && Boolean(state.mode), loginRequired: state.loginRequired,
      conversationId: isAppTarget(state.href) ? conversationId(state.href) : null, targetId: target.id, mode: state.mode,
      modeLabel: state.modeLabel, accountId: state.accountId };
  });
}

export async function webCapabilities() {
  const status = await webStatus();
  const ready = status.ready;
  return { platform: 'web', experimental: true, login: true, status: true, listSessions: ready, detectCurrentSession: ready,
    openSession: ready, createSessions: ready, readMessages: ready, sendMessages: ready,
    waitForReply: ready, taskStatus: ready, waitForTurn: ready, stopGeneration: ready, cancelTaskTree: ready,
    mcpConnectors: false, uploadAttachments: false, selectModels: false, usage: false, profiles: false,
    projects: false, runtimes: false, enterpriseKnowledge: false, selfUpdate: true, automaticUpdates: true,
    cdp: status.cdp, loginRequired: status.loginRequired, requiresTarget: status.requiresTarget || false,
    limits: ['ordinary conversations and cloud web work; remote/local computers require a separate adapter', 'rendered sidebar only; recent 100 main messages and bounded task tree',
      'no local MCP, workspace, permission settings, attachment uploads or model switching'],
    note: ready ? 'Native requests identify accepted turns; server task-tree reads confirm completion and cancellation.'
      : 'Run doubao web login to open the browser and wait for sign-in; select --target if multiple Doubao tabs match.' };
}

export async function sendWebMessage(client, message, { id = null, create = false, mode, runtime, wait = false, timeoutMs = 120000 } = {}) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('message cannot be empty');
  if (message.length > 100000) throw new Error('message exceeds the 100000 character limit');
  if (id) validateId(id);
  const deadline = Date.now() + timeoutMs;
  const before = await pageState(client);
  assertWebReady(before, { idle: true });
  if (currentApp().accountId === undefined) currentApp().accountId = before.accountId;
  let accepted;
  let store;
  const submitted = await withWebFocus(client, async () => {
    const state = create ? await newWebConversation(client, mode || before.mode, timeoutMs)
      : await navigateWeb(client, id, timeoutMs);
    assertWebReady(state, { idle: true });
    if (!state.mode) throw new Error('Web sending supports 对话 or 云电脑 work; select the runtime in the browser first');
    if (runtime === 'cloud' && state.mode !== 'work') throw new Error('--runtime cloud requires a web work conversation');
    store = await receiptStore(client);
    const observer = await observeWebSend(client, { message, conversationId: id, mode: state.mode,
      waitForReply: false, timeoutMs: Math.max(1, deadline - Date.now()),
      onReceipt: receipt => { accepted = receipt; store.save(receipt); } });
    let sendAttempted = false;
    try {
      // Input.insertText invokes the editor's native input path. Refuse any existing draft.
      await client.click(INPUT);
      await client.send('Input.insertText', { text: message });
      const ownDraft = message.replace(/\s+/gu, ' ').trim();
      // The first-screen textarea can precede editor hydration and an enabled Send button.
      for (;;) {
        const prepared = await pageState(client);
        if (prepared.ready) assertWebReady(prepared);
        else {
          if (!isAppTarget(prepared.href)) throw new Error('Selected web target left the Doubao chat origin');
          if (prepared.loginRequired) assertWebReady(prepared);
        }
        if (prepared.accountId !== state.accountId || prepared.mode !== state.mode
          || conversationId(prepared.href) !== id || prepared.generating || prepared.attachments) {
          throw new Error('Doubao Web composer changed while preparing the message; nothing was clicked to send');
        }
        const visibleDraft = prepared.draft.replace(/\s+/gu, ' ').trim();
        if (visibleDraft && visibleDraft !== ownDraft) {
          throw new Error('Doubao Web composer changed while preparing the message; nothing was clicked to send');
        }
        if (prepared.ready && visibleDraft === ownDraft && prepared.sendEnabled && Date.now() < deadline) break;
        if (Date.now() >= deadline) throw new Error('Doubao Web Send button did not become ready in time; nothing was clicked to send');
        await delay(100);
      }
      observer.arm();
      sendAttempted = true;
      await client.click(SEND);
      accepted = await observer.result;
      store.save(accepted);
      const after = await waitReady(client, accepted.conversationId, Math.max(1, deadline - Date.now()), { allowLocalDraft: true });
      if (after.accountId !== state.accountId) throw new Error('The web account changed after submission; resume using the original account and run id');
      return { ...accepted, platform: 'web', mode: state.mode, accepted: true, sendAttempted,
        ...(create ? { created: true, persisted: true } : {}), sent: { role: 'user', text: message } };
    } catch (error) {
      error.result ||= accepted || observer.snapshot();
      error.result = { ...error.result, sendAttempted };
      throw error;
    } finally {
      // Closing CDP observation does not abort the native browser request.
      observer.close();
    }
  });
  if (!wait) return submitted;
  try {
    const result = await waitTurn(client, accepted.conversationId, { runId: accepted.runId, receipt: accepted,
      deadline, onReceipt: receipt => store.save(receipt), loadReceipt: runId => store.read(accepted.conversationId, runId) });
    return { ...submitted, ...result };
  } catch (error) {
    error.result ||= accepted;
    error.result = { ...error.result, sendAttempted: true };
    throw error;
  }
}

export async function executeWeb(options) {
  validateWebOptions(options);
  const [command, subcommand, operand] = options.args;
  if (command === 'login') return webLogin({ timeoutMs: options.timeoutMs });
  if (command === 'status') return webStatus();
  if (command === 'capabilities') return webCapabilities();
  if (command === 'cdp') return subcommand === 'launch' ? launchWeb() : cdpStatus();
  if (['send', 'read', 'open', 'status', 'wait', 'stop'].includes(subcommand)) validateId(operand);
  const identityDeadline = Date.now() + (options.timeoutMs || 120000);
  return withChatClient(async client => {
    const state = await pageState(client);
    assertWebReady(state);
    currentApp().accountId = state.accountId;
    if (['status', 'wait', 'stop'].includes(subcommand)) {
      const store = await receiptStore(client);
      const runId = options.runId || (await readTurn(client, operand)).result.runId;
      const receipt = store.read(operand, runId);
      const taskOptions = { runId, receipt, timeoutMs: options.timeoutMs,
        onReceipt: next => store.save(next), loadReceipt: run => store.read(operand, run) };
      const result = subcommand === 'status' ? (await readTurn(client, operand, taskOptions)).result
        : subcommand === 'wait' ? await waitTurn(client, operand, taskOptions) : await stopTurn(client, operand, taskOptions);
      const output = { ...result, platform: 'web' };
      // Server polling already checks the pinned renderer identity. Do not spend
      // an exhausted command deadline on a redundant CDP round trip.
      if (Date.now() >= identityDeadline) return output;
      try {
        assertPinnedAccount(await pageState(client));
      } catch (error) {
        error.result = { ...output, ...(error.result || {}), identityVerified: false };
        throw error;
      }
      return output;
    }
    if (subcommand === 'list') {
      const pinnedAccount = currentApp().accountId;
      const sessions = await client.evaluate(sidebarSessionsExpression(pinnedAccount));
      assertPinnedAccount(await pageState(client));
      return { platform: 'web', scope: 'rendered-sidebar', sessions };
    }
    if (subcommand === 'current') {
      assertPinnedAccount(await pageState(client));
      return { platform: 'web', id: conversationId(state.href), draft: !conversationId(state.href) };
    }
    if (subcommand === 'create' || subcommand === 'send') {
      const message = options.args.slice(subcommand === 'create' ? 2 : 3).join(' ');
      if (!message && subcommand === 'create') {
        assertWebReady(state, { idle: true });
        return withWebFocus(client, async () => {
          const draft = await newWebConversation(client, options.mode || state.mode, options.timeoutMs);
          return { platform: 'web', mode: draft.mode, conversationId: null, created: true, persisted: false };
        });
      }
      return sendWebMessage(client, message, { id: subcommand === 'send' ? operand : null,
        create: subcommand === 'create', mode: options.mode, runtime: options.runtime, wait: options.wait, timeoutMs: options.timeoutMs });
    }
    if (subcommand === 'open') {
      return withWebFocus(client, async () => {
        await navigateWeb(client, operand, options.timeoutMs);
        const opened = await pageState(client);
        assertPinnedAccount(opened);
        return { platform: 'web', id: operand, opened: true, url: opened.href };
      });
    }
    const data = await imRequest(client, 'conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', {
      conversation_id: [operand], option: { recent_message_count_per_conv: Math.min(options.limit, 100) }, ext: {},
    }, options.timeoutMs);
    const conversation = data?.batch_get_conv_info_downlink_body?.conversation_info_list?.find(item => item.conversation_id === operand);
    if (!conversation) throw new Error('Doubao Web conversation was not found in the selected account');
    assertPinnedAccount(await pageState(client));
    const messages = (conversation.messages || []).slice().sort((a, b) => BigInt(a.index_in_conv || 0) < BigInt(b.index_in_conv || 0) ? -1 : 1)
      .filter(item => [1, 2].includes(item.user_type)).map(item => ({ messageId: item.message_id,
        role: item.user_type === 1 ? 'user' : 'assistant', text: messageText(item) }));
    return { platform: 'web', conversationId: operand, scope: 'recent-main-messages', messages };
  });
}
