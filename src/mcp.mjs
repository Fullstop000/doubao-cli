// Local MCP connector support: registers stdio personal connectors through
// the app's own API client, waits for the native MCP runtime to spawn them,
// and prepares the sandbox route that lets model-issued connector.call tool
// calls execute locally. Reverse-engineered from Doubao.app 2.29.12; see
// docs in README. All page-side code runs inside the authenticated renderer
// (or background page) over CDP.

import { spawnSync } from 'node:child_process';
import { withBackgroundClient } from './cdp.mjs';
import { AGENT_WORKSPACE, defaultWorkspace, evaluateWithWatchdog, sendChatCompletion } from './protocol.mjs';

// Doubao versions whose background-page dispatch needs COMPAT_PATCH_EXPRESSION
// (2.29.12 mishandles connector.call argument and result field names). Later
// versions must NOT be patched — the workaround would corrupt the fixed path.
const COMPAT_PATCH_VERSIONS = new Set(['2.29.12']);

function doubaoAppVersion() {
  const appPath = process.env.DOUBAO_APP || '/Applications/Doubao.app';
  const result = spawnSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print CFBundleShortVersionString', `${appPath}/Contents/Info.plist`,
  ], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// webpack runtime bootstrap used by every page-side expression below. Module
// 359531 exports Sf, the app's own SkillsFacadeApiService proxy (carries the
// common query params, request signing and response unwrapping); module
// 987391 prepares sandbox execution contexts in the background page.
const RUNTIME_BOOTSTRAP = `
  const __req = await new Promise((resolve) => {
    window['@flow-web/desktop:stable'].push([['doubao_cli_' + Date.now()], {}, (r) => resolve(r)]);
  });
  const __mod = async (id, chunk) => {
    try { return __req(id); } catch {}
    await Promise.race([
      __req.e(String(chunk)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('chunk ' + chunk + ' load timeout')), 10000)),
    ]);
    return __req(id);
  };
`;

function buildExpression(template, args) {
  return template.replace('%ARGS%', JSON.stringify(args));
}

const REGISTER_EXPRESSION = `(async () => {
  ${RUNTIME_BOOTSTRAP}
  const args = %ARGS%;
  const api = (await __mod(359531, 1383)).Sf;
  const created = await api.AGWManageCreatePersonalConnector({
    name: args.name,
    mcp_config: {
      transport_type: 3, // STDIO
      stdio_config: { command: args.command, params: args.params, env: args.env },
    },
  });
  const connector = created?.data?.connector;
  if (!connector?.connector_id) return { error: 'create_failed', detail: JSON.stringify(created).slice(0, 300) };
  const connectorId = connector.connector_id;
  await window.neotix.taskMode.runtime.triggerUpdate();
  const deadline = Date.now() + args.timeoutMs;
  let lastStatus = 'absent';
  while (Date.now() < deadline) {
    const { connectors } = await window.neotix.taskMode.connector.queryLocalConnectors({});
    const current = connectors.find((item) => item.connectorId === connectorId);
    if (current) lastStatus = current.status + (current.enabled ? '' : '(disabled)');
    if (current?.enabled && current.status === 'READY') return { connectorId, status: current.status };
    if (current && ['INSTALL_FAILED', 'START_FAILED', 'AUTH_FAILED'].includes(current.status)) {
      return { error: 'status_failed', connectorId, status: current.status };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { error: 'ready_timeout', connectorId, status: lastStatus };
})()`;

const LIST_EXPRESSION = `(async () => {
  ${RUNTIME_BOOTSTRAP}
  const api = (await __mod(359531, 1383)).Sf;
  const result = await api.AGWManageListUserConnectors({ keyword: '', page_size: 100, page_token: '' });
  return (result?.data?.items || []).map((item) => ({
    connectorId: item.connector_id,
    name: item.name,
    enabled: item.enabled,
    type: item.type,
    vendor: item.vendor,
  }));
})()`;

const REMOVE_EXPRESSION = `(async () => {
  ${RUNTIME_BOOTSTRAP}
  const args = %ARGS%;
  const api = (await __mod(359531, 1383)).Sf;
  const result = { connectorId: args.connectorId };
  try { await api.AGWManageDisconnectConnector({ connector_id: args.connectorId, skill_type: 1 }); result.disconnected = true; }
  catch (error) { result.disconnected = false; result.disconnectError = String(error?.message || error).slice(0, 200); }
  try { await api.AGWManageSetConnectorEnabled({ connector_id: args.connectorId, enabled: false, skill_type: 1 }); result.disabled = true; }
  catch (error) { result.disabled = false; result.disableError = String(error?.message || error).slice(0, 200); }
  try { await window.neotix.taskMode.runtime.triggerUpdate(); } catch {}
  return result;
})()`;

const SNAPSHOT_EXPRESSION = `(async () => {
  const args = %ARGS%;
  const { connectors } = await window.neotix.mcp.getAllTools();
  const missing = [];
  const snapshot = [];
  for (const connectorId of args.connectorIds) {
    const entry = connectors.find((item) => item.connectorId === connectorId);
    if (!entry) { missing.push(connectorId); continue; }
    const parsed = JSON.parse(entry.toolsJson);
    const tools = Array.isArray(parsed) ? parsed : parsed.tools || [];
    snapshot.push({
      connectorId,
      mcpToolsList: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: JSON.stringify(tool.inputSchema || {}),
        ...(tool.annotations ? { annotations: JSON.stringify(tool.annotations) } : {}),
        ...(tool._meta ? { meta: JSON.stringify(tool._meta) } : {}),
      })),
    });
  }
  return missing.length ? { error: 'connectors_not_ready', missing } : { snapshot };
})()`;

const PREPARE_SANDBOX_EXPRESSION = `(async () => {
  ${RUNTIME_BOOTSTRAP}
  const args = %ARGS%;
  const runtime = await window.neotix.taskMode.runtime.queryRuntimeInfo({ env: true });
  const envId = runtime?.env?.environmentId || '';
  const prepare = (await __mod(987391, 28037)).H;
  const out = await prepare({
    cwd: args.workspace,
    envId,
    from: 'main',
    globalSkillPath: args.agentWorkspace,
    projectFolders: [],
    sandboxAuthType: 2, // FullAccess: tool calls run without UI approval
    sendContext: args.sendContext,
  });
  if (!out?.sandboxId) return { error: 'sandbox_prepare_failed', detail: JSON.stringify(out).slice(0, 300) };
  return { sandboxId: out.sandboxId, resolvedSharedFolders: out.resolvedSharedFolders || [] };
})()`;

// Doubao 2.29.12 background-page dispatch bugs this works around:
// 1. connector.call forwards raw_arguments (string) to the native MCP bridge,
//    which requires an object — parse it when the wire carries a string.
// 2. the success path reads mcpResponseJson but the bridge returns
//    mcpResultJson — alias it.
// Both checks are no-ops once the app fixes the field handling.
const COMPAT_PATCH_EXPRESSION = `(() => {
  if (globalThis.__doubaoCliConnectorPatch) return { patched: false, already: true };
  const origParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const value = origParse(text, reviver);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.protocol_version === 1 && typeof value.raw_arguments === 'string') {
        try { value.raw_arguments = origParse(value.raw_arguments); } catch {}
      }
      if (value.mcpResponseJson === undefined && typeof value.mcpResultJson === 'string') {
        value.mcpResponseJson = value.mcpResultJson;
      }
    }
    return value;
  };
  globalThis.__doubaoCliConnectorPatch = true;
  return { patched: true };
})()`;

// Registers a stdio MCP server as a personal connector and waits for the
// native runtime to report READY (the app spawns the command itself).
export async function registerConnector(client, { name, command, params = [], env = {}, timeoutMs = 90_000 }) {
  const result = await evaluateWithWatchdog(client, buildExpression(REGISTER_EXPRESSION, {
    name, command, params, env, timeoutMs,
  }), timeoutMs + 30_000);
  if (result?.error) {
    throw new Error(`Doubao connector registration failed: ${result.error} ${result.status || ''} ${result.detail || ''}`.trim());
  }
  return result;
}

export async function listConnectors(client) {
  return await client.evaluate(LIST_EXPRESSION) || [];
}

// There is no delete API; removal disconnects the runtime and disables the
// connector so it leaves the tool catalog.
export async function removeConnector(client, connectorId) {
  return await client.evaluate(buildExpression(REMOVE_EXPRESSION, { connectorId }));
}

// Builds the localConnectors tool snapshot for a chat request. Throws unless
// every requested connector is READY with its tools discovered.
export async function connectorsSnapshot(client, connectorIds) {
  const result = await client.evaluate(buildExpression(SNAPSHOT_EXPRESSION, { connectorIds }));
  if (!result || result.error) {
    throw new Error(`Doubao connectors are not ready: ${(result?.missing || connectorIds).join(', ')}. Run "doubao mcp list" to check them.`);
  }
  return result.snapshot;
}

// Registers a sandbox execution context in the background page. Without this
// route the model's local tool calls fail with sandbox_not_provisioned.
export async function prepareToolSandbox(client, { workspace, sendContext }) {
  const result = await evaluateWithWatchdog(client, buildExpression(PREPARE_SANDBOX_EXPRESSION, {
    workspace,
    agentWorkspace: AGENT_WORKSPACE,
    sendContext,
  }), 30_000);
  if (!result?.sandboxId) {
    throw new Error(`Doubao sandbox preparation failed: ${result?.error || 'unknown'} ${result?.detail || ''}`.trim());
  }
  return result;
}

// Installs the background-page compatibility patch on app versions known to
// need it (idempotent, in-memory only; gone after an app restart).
export async function installConnectorCompatPatch() {
  if (!COMPAT_PATCH_VERSIONS.has(doubaoAppVersion())) return { patched: false, skipped: 'version_ok' };
  return withBackgroundClient(async (client) => client.evaluate(COMPAT_PATCH_EXPRESSION));
}

// Full tool-enabled send: patch the background dispatch, snapshot the
// connectors' tools, register a sandbox route bound to this conversation,
// then send with the localConnectors catalog attached.
export async function sendWithConnectors(client, request, connectorIds) {
  await installConnectorCompatPatch();
  const localConnectors = await connectorsSnapshot(client, connectorIds);
  const workspace = request.workspace || defaultWorkspace();
  const localConversationId = `local_${Date.now()}`;
  const localMessageId = crypto.randomUUID();
  const sendContext = request.conversationId
    ? { conversationId: request.conversationId, localMessageId }
    : { localConversationId, localMessageId };
  const sandbox = await prepareToolSandbox(client, { workspace, sendContext });
  return sendChatCompletion(client, {
    ...request,
    workspace,
    localConnectors,
    sandboxId: sandbox.sandboxId,
    sharedFolderPath: sandbox.resolvedSharedFolders.length ? sandbox.resolvedSharedFolders : undefined,
    localConversationId,
    localMessageId,
    withExt: Boolean(request.conversationId),
  });
}
