import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HeadlessConnectors } from '../src/headless-mcp.mjs';

const ACCOUNT = '12345678';
const CONNECTOR = '87654321';
const TOOL = { name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };

async function fixture(t, { tools = [TOOL], connectorOptions = {} } = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-headless-mcp-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const calls = [];
  let remote = [];
  const client = { async json(route, options) {
    const body = JSON.parse(options.body);
    calls.push({ route, body, timeoutMs: options.timeoutMs });
    if (route.endsWith('/create_personal')) {
      remote.push({ connector_id: CONNECTOR, name: body.name, enabled: true, type: 3 });
      return { data: { connector: { connector_id: CONNECTOR } } };
    }
    if (route.endsWith('/list_by_user')) return { data: { items: remote, has_more: false, next_page_token: '' } };
    if (route.endsWith('/disconnect')) { remote = remote.filter(item => item.connector_id !== body.connector_id); return { data: {} }; }
    if (route.endsWith('/set_enabled')) { remote = remote.map(item => item.connector_id === body.connector_id ? { ...item, enabled: body.enabled } : item); return { data: {} }; }
    throw new Error(`unexpected route ${route}`);
  } };
  let closeCount = 0;
  const makeMcpClient = config => {
    calls.push({ mcp: 'spawn', command: config.command, params: config.params, env: config.env });
    return {
      transport: { stderr: new EventEmitter() },
      client: {
        async connect() { calls.push({ mcp: 'initialize' }); },
        async listTools() { calls.push({ mcp: 'listTools' }); return { tools }; },
        async callTool(request) { calls.push({ mcp: 'callTool', request }); return { content: [{ type: 'text', text: 'ok' }], isError: false }; },
        async close() { closeCount += 1; },
      },
    };
  };
  const connectors = new HeadlessConnectors({ client, profile: 'work', accountId: ACCOUNT, configDir, makeMcpClient, ...connectorOptions });
  t.after(() => connectors.close());
  return { configDir, calls, connectors, client, get closeCount() { return closeCount; }, get remote() { return remote; } };
}

test('register verifies a real stdio MCP server before remote mutation and stores secrets privately', async t => {
  const fx = await fixture(t);
  const env = { API_TOKEN: 'secret-value', SAFE_LABEL: 'local-only', OPAQUE_CREDENTIAL_17: 'opaque-value' };
  const result = await fx.connectors.register({ name: 'Local Search', command: process.execPath, params: ['server.js'], env });
  assert.deepEqual(result, { connectorId: CONNECTOR, status: 'READY', tools: ['lookup'] });
  assert.deepEqual(fx.calls.slice(0, 3).map(call => call.mcp || call.route.split('/').at(-1)), ['spawn', 'initialize', 'listTools']);
  assert.equal(fx.calls[3].route.endsWith('/create_personal'), true);
  assert.deepEqual(fx.calls[0].env, env, 'the local stdio server receives the configured environment');
  assert.deepEqual(fx.calls[3].body.mcp_config.stdio_config.env, {}, 'environment values never leave the local machine');
  const store = fx.connectors.storePath;
  assert.equal((await fs.stat(store)).mode & 0o777, 0o600);
  const contents = await fs.readFile(store, 'utf8');
  assert.match(contents, /secret-value/u);
  assert.match(contents, /opaque-value/u);
  assert.doesNotMatch(JSON.stringify(await fx.connectors.list()), /secret-value/u);
  assert.deepEqual(await fx.connectors.snapshot([CONNECTOR]), [{ connectorId: CONNECTOR, mcpToolsList: [{
    name: 'lookup', description: 'Look up an item', inputSchema: JSON.stringify(TOOL.inputSchema),
  }] }]);
  const call = await fx.connectors.call({ connectorId: CONNECTOR, toolName: 'lookup', arguments: { id: '7' } });
  assert.equal(call.mcpResponseJson.isError, false);
  assert.deepEqual(fx.calls.find(item => item.mcp === 'callTool').request, { name: 'lookup', arguments: { id: '7' } });
});

test('does not create a remote connector when stdio initialization or tool discovery fails', async t => {
  const fx = await fixture(t, { tools: [{ name: '', inputSchema: {} }] });
  await assert.rejects(fx.connectors.register({ name: 'Bad server', command: process.execPath, params: [] }), /invalid tool description/u);
  assert.equal(fx.calls.some(call => call.route?.endsWith('/create_personal')), false);
  assert.equal(fx.closeCount, 1);
});

test('an expired command deadline rejects before spawning or dispatching a remote RPC', async t => {
  const originalNow = Date.now;
  Date.now = () => 50_000;
  const fx = await fixture(t, { connectorOptions: { deadlineMs: 49_999 } });
  try {
    await assert.rejects(fx.connectors.register({ name: 'Expired', command: process.execPath, params: [] }),
      error => error.code === 'mcp_timeout');
    assert.equal(fx.calls.some(call => call.mcp === 'spawn'), false);
    assert.equal(fx.calls.some(call => call.route), false);
  } finally {
    Date.now = originalNow;
  }
});

test('stdio initialization uses the remaining one-second command budget', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-headless-mcp-deadline-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  let closeCount = 0;
  const connectors = new HeadlessConnectors({
    client: { async json() { assert.fail('expired initialization must not dispatch a remote RPC'); } },
    profile: 'deadline', accountId: ACCOUNT, configDir, deadlineMs: Date.now() + 1000,
    makeMcpClient: () => ({ transport: { stderr: new EventEmitter() }, client: {
      connect() { return new Promise(() => {}); }, async listTools() { assert.fail('timed out before tool listing'); },
      async close() { closeCount += 1; },
    } }),
  });
  t.after(() => connectors.close());
  const started = Date.now();
  await assert.rejects(connectors.register({ name: 'Slow init', command: process.execPath, params: [] }),
    error => error.code === 'mcp_timeout');
  assert.ok(Date.now() - started < 3000, 'one-second deadline should beat the fixed ten-second connect timeout');
  assert.equal(closeCount, 1);
});

test('create and readback RPC timeouts consume one absolute deadline', async t => {
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const fx = await fixture(t, { connectorOptions: { deadlineMs: now + 10_000, requestTimeoutMs: 30_000 } });
  const connect = fx.connectors.makeMcpClient;
  fx.connectors.makeMcpClient = async config => {
    const result = await connect(config);
    const originalClient = result.client;
    result.client = {
      async connect(transport) { now += 1000; return originalClient.connect(transport); },
      async listTools() { now += 1000; return originalClient.listTools(); },
      async close() { return originalClient.close(); },
      async callTool(...args) { return originalClient.callTool(...args); },
    };
    return result;
  };
  const originalJson = fx.client.json.bind(fx.client);
  fx.client.json = async (route, options) => {
    const result = await originalJson(route, options);
    now += 1000;
    return result;
  };
  try {
    await fx.connectors.register({ name: 'Budgeted', command: process.execPath, params: [] });
    const remoteTimeouts = fx.calls.filter(call => call.route).map(call => call.timeoutMs);
    assert.deepEqual(remoteTimeouts.map(value => value > 0), [true, true]);
    assert.ok(remoteTimeouts[1] < remoteTimeouts[0], `readback should consume less time: ${remoteTimeouts}`);
  } finally {
    Date.now = originalNow;
  }
});

test('stdio tool invocation is capped by the remaining absolute deadline', async t => {
  const fx = await fixture(t);
  await fx.connectors.register({ name: 'Budgeted tool', command: process.execPath, params: [] });
  const entry = [...fx.connectors.clients.values()][0];
  let callStarted = false;
  entry.client.callTool = (_request, _progress, { signal }) => {
    callStarted = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  fx.connectors.deadlineMs = Date.now() + 750;
  const started = Date.now();
  await assert.rejects(fx.connectors.call({ connectorId: CONNECTOR, toolName: 'lookup', arguments: {} }),
    error => error.code === 'mcp_timeout');
  assert.equal(callStarted, true);
  assert.ok(Date.now() - started < 2500, 'tool invocation should use the remaining deadline, not its 30-second default');
});

test('expired readback sends no list RPC and attempts compensating disconnect', async t => {
  const originalNow = Date.now;
  let now = 200_000;
  const deadlineMs = now + 5000;
  Date.now = () => now;
  const fx = await fixture(t, { connectorOptions: { deadlineMs } });
  const originalJson = fx.client.json.bind(fx.client);
  fx.client.json = async (route, options) => {
    if (route.endsWith('/create_personal')) {
      now = deadlineMs;
      return { data: { connector: { connector_id: CONNECTOR } } };
    }
    return originalJson(route, options);
  };
  try {
    await assert.rejects(fx.connectors.register({ name: 'Rollback', command: process.execPath, params: [] }),
      error => error.code === 'mcp_timeout');
    assert.deepEqual(fx.calls.filter(call => call.route).map(call => call.route.split('/').at(-1)), ['disconnect']);
    assert.deepEqual(fx.remote, []);
  } finally {
    Date.now = originalNow;
  }
});

test('remove verifies remote inactivity before deleting owned local configuration', async t => {
  const fx = await fixture(t);
  await fx.connectors.register({ name: 'Local Search', command: process.execPath, params: [], env: { TOKEN: 'private' } });
  const result = await fx.connectors.remove(CONNECTOR);
  assert.deepEqual(result, { connectorId: CONNECTOR, removed: true, serverInactive: true, ownedLocalConfigurationRemoved: true });
  assert.equal((await fs.readFile(fx.connectors.storePath, 'utf8')).includes(CONNECTOR), false);
});

test('validates stdio command paths, argument limits, and connector identity', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.connectors.register({ name: 'Bad', command: 'node', params: [] }), /absolute executable/u);
  await assert.rejects(fx.connectors.register({ name: 'Bad', command: process.execPath, params: new Array(129).fill('x') }), /at most 128/u);
  await assert.rejects(fx.connectors.call({ connectorId: CONNECTOR, toolName: 'missing', arguments: {} }), /not owned, enabled, or available/u);
  assert.equal(fx.calls.some(call => call.route?.endsWith('/create_personal')), false);
});

test('official SDK client initializes a portable stdio server and invokes its advertised tool', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-headless-mcp-sdk-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const connectorId = '87654322';
  let remote = [];
  const calls = [];
  const client = { async json(route, options) {
    const body = JSON.parse(options.body);
    calls.push({ route, body });
    if (route.endsWith('/create_personal')) {
      remote = [{ connector_id: connectorId, name: body.name, enabled: true }];
      return { data: { connector: { connector_id: connectorId } } };
    }
    if (route.endsWith('/list_by_user')) return { data: { items: remote, has_more: false } };
    throw new Error(`unexpected route ${route}`);
  } };
  const server = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [${JSON.stringify(TOOL)}] }));
    server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: [request.params.arguments.id, process.env.SAFE_LABEL, process.env.OPAQUE_CREDENTIAL_17].join('|') }], isError: false }));
    await server.connect(new StdioServerTransport());
    process.stderr.write('private-server-diagnostic');
  `;
  const connectors = new HeadlessConnectors({ client, profile: 'sdk', accountId: ACCOUNT, configDir });
  t.after(() => connectors.close());
  const env = { SAFE_LABEL: 'stdio-local-value', OPAQUE_CREDENTIAL_17: 'stdio-token-value' };
  await connectors.register({ name: 'SDK fixture', command: process.execPath, params: ['-e', server], env });
  assert.deepEqual(calls.find(call => call.route.endsWith('/create_personal')).body.mcp_config.stdio_config.env, {});
  const stored = JSON.parse(await fs.readFile(connectors.storePath, 'utf8'));
  assert.deepEqual(stored.connectors[connectorId].env, env, 'local connector storage retains the configured stdio environment');
  const result = await connectors.call({ connectorId, toolName: 'lookup', arguments: { id: 'real-sdk' } });
  assert.equal(result.mcpResponseJson.content[0].text, 'real-sdk|stdio-local-value|stdio-token-value',
    'a real stdio child process receives the configured local environment');
  assert.doesNotMatch(JSON.stringify(result), /private-server-diagnostic/u);
});
