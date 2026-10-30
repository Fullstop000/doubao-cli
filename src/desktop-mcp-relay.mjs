import path from 'node:path';
import { createHash } from 'node:crypto';
import { HeadlessLocalRuntime } from './headless-local-runtime.mjs';
import { createHeadlessApproval } from './headless-approval.mjs';
import { createDesktopMcpTransport } from './desktop-mcp-transport.mjs';
import { nativeDeliveryProbe } from './desktop-mcp-delivery.mjs';
import { currentApp } from './app.mjs';
import { configDirectory } from './config.mjs';
import { runtimeParameters } from './protocol.mjs';
import { readTurn } from './turns.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

// Reuse durable execution receipts, result-only upload recovery and atomic leases.
// Never expose the parent's shell/filesystem/COMMAND execution to desktop traffic.
export class DesktopMcpRelay extends HeadlessLocalRuntime {
  constructor({ appId, connectors, isActive, deviceLeasePath, notBefore = 0, ...options }) {
    super({ ...options, callConnector: async args => {
      args.signal?.throwIfAborted();
      if (!await isActive()) throw new Error('Desktop MCP task ended while awaiting approval');
      args.signal?.throwIfAborted();
      return options.callConnector(args);
    } });
    this.appId = appId;
    this.notBefore = notBefore;
    this.allowed = new Map(connectors.map(c => [c.connectorId, new Set(c.mcpToolsList.map(t => t.name))]));
    this.isActive = isActive;
    if (deviceLeasePath) this.leasePath = deviceLeasePath;
  }
  leaseScope() { return { accountId: this.accountId, deviceId: this.deviceId, appId: this.appId }; }
  async handleFrame(frame) {
    if (Number(frame?.event_type) !== 1 || frame.sandbox_id !== this.sandboxId) return;
    const tool = frame.tool_call;
    if (tool?.name !== 'connector.call' || typeof tool.id !== 'string' || !tool.id) return;
    if (!frame.signature || frame.signature.user_id !== this.accountId || frame.signature.device_id !== this.deviceId) return;
    if (this.notBefore) {
      const generated = Number(frame.signature.timestamp_ms);
      if (!Number.isSafeInteger(generated) || generated < this.notBefore || generated > Date.now() + 30_000) return;
    }
    let input;
    try { input = parse(tool.input); } catch { return; }
    if (input?.protocol_version !== 1 || !this.allowed.get(input.connector_id)?.has(input.remote_tool_name)) return;
    if (typeof input.raw_arguments !== 'string') return;
    try { const args = JSON.parse(input.raw_arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) return; } catch { return; }
    if (this.controller.signal.aborted || !await this.isActive()) return;
    return super.handleFrame(frame);
  }
  async handleCommand() { /* Native dispatcher owns every command. */ }
  async executeBuiltin() { throw new Error('Desktop MCP relay does not execute builtin tools'); }
  async execute(call) {
    if (call.name !== 'connector.call' || !await this.isActive()) throw new Error('Desktop MCP task is no longer active');
    return super.execute(call);
  }
}

// This owner lives for the CLI wait, not just the completion SSE request. It
// never submits a model request; wait recovery only resumes the accepted receipt.
export function createDesktopMcpRelayOwner(client, { startedAt = Date.now(), deadline, onDiagnostic = () => {} } = {}) {
  const app = currentApp();
  const controller = new AbortController();
  let startup, relay, transport, failure;
  const diagnostic = message => { try { onDiagnostic(message); } catch {} };
  const active = async (receipt, readDeadline = deadline) => {
    if (controller.signal.aborted || Date.now() >= readDeadline) return false;
    const snap = await readTurn(client, receipt.conversationId, { runId: receipt.runId, deadline: readDeadline });
    if (controller.signal.aborted || Date.now() >= readDeadline) return false;
    return snap.result.runId === receipt.runId && snap.result.status === 'running' && !snap.result.pending?.length;
  };
  async function start(receipt) {
    const body = parse(receipt.requestBody);
    const task = body?.option?.general_task_param;
    const input = parse(task?.task_input_json || '{}');
    if (task?.runtime_type !== 2 || !task.client_option?.sandbox_id || !input.localConnectors?.length) return;
    const now = Date.now();
    const notBefore = receipt.mcpStartedAt === undefined ? startedAt : receipt.mcpStartedAt;
    if (!Number.isSafeInteger(notBefore) || notBefore <= 0 || notBefore > now) {
      throw new Error('Desktop MCP receipt has an invalid start timestamp');
    }
    // Polling gets a fresh bounded window, but routing still requires evidence
    // from this owner. An old receipt cannot prove the native worker survived a
    // restart and must not authorize opening a competing legacy SSE stream.
    const startupDeadline = Math.min(deadline, now + 30_000);
    const pause = () => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(250, startupDeadline - Date.now()))));
    const sandboxId = task.client_option.sandbox_id;
    const detect = nativeDeliveryProbe({ dataDir: app.dataDir, sandboxId, startedAt });
    let delivery;
    while (!controller.signal.aborted && Date.now() < startupDeadline) {
      delivery = await detect();
      if (delivery) break;
      await pause();
    }
    if (controller.signal.aborted || delivery === 'sse') return;
    if (delivery !== 'dispatcher') { diagnostic('Desktop MCP compatibility skipped: native delivery could not be verified.'); return; }
    let ready = false;
    while (!controller.signal.aborted && Date.now() < startupDeadline) {
      try { ready = await active(receipt, startupDeadline); break; }
      catch (error) {
        // The accepted ACK may precede IM history. Only that known transient
        // state is retryable; terminal, pending and foreign turns stay closed.
        if (error.code !== 'turn_unavailable') throw error;
        await pause();
      }
    }
    if (!ready) return;
    const identity = await runtimeParameters(client);
    const account = await client.evaluate('window.neotix.account.getLoginUser()');
    if (!account?.isLogin || !account.userId || identity.params.aid !== app.aid) throw new Error('Desktop MCP account/app identity is unavailable');
    const accountId = String(account.userId), deviceId = identity.params.device_id;
    if (String(task.agent_task_param?.local_app_id) !== app.aid || task.agent_task_param?.local_device_id !== deviceId) throw new Error('Desktop MCP receipt belongs to another app or device');
    const scope = hash([app.id, accountId, deviceId]);
    // Device-wide replay and stream ownership must remain shared even when two
    // CLI invocations choose different receipt/config directories.
    const directory = path.join(configDirectory({}), 'desktop-mcp', scope);
    transport = createDesktopMcpTransport(client, { params: identity.params, accountId });
    const permission = ['AlwaysAsk', 'AskOnRisk', 'FullAccess'][task.client_option.sandbox_auth_type];
    if (!permission) throw new Error('Desktop MCP receipt has an invalid permission policy');
    relay = new DesktopMcpRelay({ client: transport, sandboxId, deviceId, accountId, appId: app.aid,
      conversationId: receipt.conversationId, workspace: task.client_option.workspace,
      permission, notBefore, connectors: input.localConnectors, isActive: () => active(receipt),
      callConnector: args => transport.callConnector(args), approve: createHeadlessApproval({ workspace: task.client_option.workspace }),
      journalPath: path.join(directory, hash([receipt.conversationId, sandboxId]) + '.json'),
      deviceLeasePath: path.join(directory, 'device.lock'),
      onError: () => diagnostic('Desktop MCP compatibility transport interrupted; the original task was not resent.') });
    await relay.start({ signal: controller.signal });
  }
  return {
    accept(receipt) {
      if (startup || !receipt?.conversationId || !receipt.runId || !receipt.requestBody || controller.signal.aborted) return;
      // Capture immutable accepted identity. Later completion callbacks cannot rebind it.
      startup = start(structuredClone(receipt)).catch(error => { failure = error; diagnostic('Desktop MCP compatibility unavailable: ' + error.message); });
    },
    async close() {
      controller.abort();
      await startup;
      await relay?.close();
      await transport?.close();
    },
    get failure() { return failure; },
  };
}
