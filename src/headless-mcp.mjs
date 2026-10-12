import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configDirectory } from './config.mjs';
import { headlessProfilePaths, validateHeadlessProfileName } from './headless-state.mjs';

const MAX_NAME = 128;
const MAX_ARGS = 128;
const MAX_VALUE_BYTES = 16 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const validId = value => typeof value === 'string' && /^[1-9]\d{5,24}$/u.test(value);
const allowedToolName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/u.test(value);

function connectorError(message, code) {
  return Object.assign(new Error(message), { code });
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('connector configuration must be an object');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > MAX_NAME || /[\r\n\0]/u.test(input.name)) {
    throw new TypeError(`connector name must contain 1 to ${MAX_NAME} characters`);
  }
  if (typeof input.command !== 'string' || !path.isAbsolute(input.command) || /[\r\n\0]/u.test(input.command)) {
    throw new TypeError('stdio connector command must be an absolute executable path');
  }
  if (!Array.isArray(input.params) || input.params.length > MAX_ARGS || input.params.some(arg => typeof arg !== 'string' || /[\0]/u.test(arg))) {
    throw new TypeError(`stdio connector arguments must be an array of at most ${MAX_ARGS} strings`);
  }
  const env = input.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('stdio connector environment must be an object');
  const entries = Object.entries(env);
  if (entries.length > 128 || entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || /[\0]/u.test(value))) {
    throw new TypeError('stdio connector environment must contain valid string variables');
  }
  const size = Buffer.byteLength(JSON.stringify([input.name, input.command, input.params, env]));
  if (size > MAX_VALUE_BYTES) throw new TypeError('stdio connector configuration exceeds 16 KiB');
  return { name: input.name.trim(), command: input.command, params: [...input.params], env: Object.fromEntries(entries) };
}

function validTools(tools) {
  if (!Array.isArray(tools) || tools.length > 2048) throw connectorError('MCP server returned an invalid tool list', 'mcp_tools_invalid');
  let size = 0;
  return tools.map(tool => {
    if (!tool || !allowedToolName(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      throw connectorError('MCP server returned an invalid tool description', 'mcp_tools_invalid');
    }
    const inputSchema = JSON.stringify(tool.inputSchema);
    size += Buffer.byteLength(inputSchema);
    if (size > 2 * 1024 * 1024) throw connectorError('MCP tool catalog exceeds 2 MiB', 'mcp_tools_too_large');
    return { name: tool.name, description: typeof tool.description === 'string' ? tool.description.slice(0, 20_000) : '',
      inputSchema,
      ...(tool.annotations && typeof tool.annotations === 'object' ? { annotations: JSON.stringify(tool.annotations) } : {}),
      ...(tool._meta && typeof tool._meta === 'object' ? { meta: JSON.stringify(tool._meta) } : {}) };
  });
}

function raceTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(connectorError(message, 'mcp_timeout')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function noStderrOutput(transport) {
  // Always drain child stderr to avoid blocking a chat process. Never persist or
  // print it: MCP servers often include credentials in diagnostic output.
  const stream = transport.stderr;
  stream?.on('data', () => {});
}

export class HeadlessConnectors {
  constructor({ client, profile = 'default', accountId, configDir, makeMcpClient = defaultMcpClient,
    requestTimeoutMs = 10_000, deadlineMs } = {}) {
    if (typeof client?.json !== 'function') throw new TypeError('Headless connector service requires a JSON HTTP client');
    if (!validId(accountId)) throw new TypeError('Headless connector service requires a verified account id');
    this.client = client;
    this.profile = validateHeadlessProfileName(profile);
    this.accountId = accountId;
    this.configDir = configDir || configDirectory();
    this.makeMcpClient = makeMcpClient;
    this.requestTimeoutMs = Math.max(1, Math.min(30_000, requestTimeoutMs));
    if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
      throw new TypeError('connector deadlineMs must be a positive absolute timestamp');
    }
    this.deadlineMs = deadlineMs;
    this.clients = new Map();
    this.opening = new Map();
    this.closed = false;
  }

  operationTimeout(maximumMs) {
    if (this.deadlineMs === undefined) return maximumMs;
    const remaining = Math.floor(this.deadlineMs - Date.now());
    if (remaining <= 0) throw connectorError('Headless connector operation exceeded its request deadline', 'mcp_timeout');
    return Math.max(1, Math.min(maximumMs, remaining));
  }

  get storePath() {
    const profilePath = headlessProfilePaths({ configDir: this.configDir, profile: this.profile }).directory;
    const account = createHash('sha256').update(this.accountId).digest('hex');
    return path.join(profilePath, 'connectors', account, 'stdio.json');
  }

  async assertSafeStorePath(file) {
    const profilePath = headlessProfilePaths({ configDir: this.configDir, profile: this.profile }).directory;
    const account = createHash('sha256').update(this.accountId).digest('hex');
    for (const directory of [profilePath, path.dirname(profilePath), path.join(profilePath, 'connectors'), path.dirname(file)]) {
      try { if ((await fs.lstat(directory)).isSymbolicLink()) throw connectorError('Headless connector store path must not contain symlinks', 'connector_store_unsafe'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw connectorError('Headless connector store file must not be a symlink', 'connector_store_unsafe'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return account;
  }

  async readOwned() {
    const file = this.storePath;
    await this.assertSafeStorePath(file);
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed?.version !== 1 || parsed.accountId !== this.accountId || !parsed.connectors || typeof parsed.connectors !== 'object' || Array.isArray(parsed.connectors)) {
        throw new Error('Headless connector configuration is invalid; remove or repair the local connector store');
      }
      const owned = {};
      for (const [id, entry] of Object.entries(parsed.connectors)) {
        if (!validId(id) || entry?.connectorId !== id) throw new Error('invalid connector entry');
        const config = validateConfig(entry);
        owned[id] = { ...config, connectorId: id, ...(typeof entry.createdAt === 'string' ? { createdAt: entry.createdAt } : {}) };
      }
      return owned;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      if (error.message?.startsWith('Headless connector configuration')) throw error;
      throw new Error('Headless connector configuration is invalid; remove or repair the local connector store', { cause: error });
    }
  }

  async writeOwned(connectors) {
    const file = this.storePath;
    await this.assertSafeStorePath(file);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(file), 0o700);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, accountId: this.accountId, connectors })}\n`, { flag: 'wx', mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async post(route, body, { cleanup = false } = {}) {
    // A register rollback compensates for a connector already created by this invocation.
    const timeoutMs = cleanup ? this.requestTimeoutMs : this.operationTimeout(this.requestTimeoutMs);
    const result = await raceTimeout(this.client.json(route, { method: 'POST', timeoutMs,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), timeoutMs,
    'Doubao connector request timed out');
    if (result?.code || result?.status_code && result.status_code !== 0) {
      throw connectorError('Doubao connector service rejected the request', 'connector_request_rejected');
    }
    return result;
  }

  async remoteList() {
    const items = [];
    const tokens = new Set();
    let pageToken = '';
    for (let page = 0; page < 10; page += 1) {
      const result = await this.post('/alice/office/skills/manage/connector/list_by_user', { keyword: '', page_size: 100, page_token: pageToken });
      const data = result?.data;
      if (!Array.isArray(data?.items)) throw connectorError('Doubao connector list is invalid', 'connector_list_invalid');
      items.push(...data.items);
      if (!data.has_more) return items.filter(item => item && item.connector_id != null).map(item => ({
        connectorId: String(item.connector_id), name: String(item.name || ''), enabled: item.enabled === true || item.enabled === 1,
        type: item.type, vendor: item.vendor,
      }));
      const next = String(data.next_page_token ?? data.page_token ?? '');
      if (!next || next === pageToken || tokens.has(next)) throw connectorError('Doubao connector pagination did not advance', 'connector_pagination_invalid');
      tokens.add(next);
      pageToken = next;
    }
    throw connectorError('Doubao connector list exceeds the supported page limit', 'connector_list_incomplete');
  }

  async createRemote({ name, command, params, env }) {
    const result = await this.post('/alice/office/skills/manage/connector/create_personal', {
      name, mcp_config: { transport_type: 3, stdio_config: { command, params, env } },
    });
    const id = result?.data?.connector?.connector_id;
    if (id == null || !validId(String(id))) throw connectorError('Doubao did not confirm connector creation', 'connector_create_unconfirmed');
    return String(id);
  }

  async setEnabled(connectorId, enabled) {
    return this.post('/alice/office/skills/manage/connector/set_enabled', { connector_id: connectorId, enabled, skill_type: 1 });
  }

  async disconnect(connectorId, options) {
    return this.post('/alice/office/skills/manage/connector/disconnect', { connector_id: connectorId, skill_type: 1 }, options);
  }

  async open(config) {
    if (this.closed) throw connectorError('Headless connector service is closed', 'connector_service_closed');
    const key = `${config.command}\0${JSON.stringify(config.params)}\0${this.accountId}`;
    const cacheKey = config.connectorId || key;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;
    const pending = this.opening.get(cacheKey);
    if (pending) return pending;
    const opening = (async () => {
      this.operationTimeout(CONNECT_TIMEOUT_MS);
      const { client, transport } = await this.makeMcpClient(config);
      noStderrOutput(transport);
      const entry = { client, transport, tools: [] };
      try {
        const connectTimeout = this.operationTimeout(CONNECT_TIMEOUT_MS);
        await raceTimeout(client.connect(transport), connectTimeout, 'stdio MCP server did not initialize in time');
        const listTimeout = this.operationTimeout(CONNECT_TIMEOUT_MS);
        const listed = await raceTimeout(client.listTools(), listTimeout, 'stdio MCP tool listing timed out');
        entry.tools = validTools(listed?.tools);
        this.clients.set(cacheKey, entry);
        return entry;
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    })();
    this.opening.set(cacheKey, opening);
    try { return await opening; }
    finally { this.opening.delete(cacheKey); }
  }

  async verifyServer(config) {
    const entry = await this.open(config);
    return entry.tools;
  }

  async register(input) {
    const config = validateConfig(input);
    const stat = await fs.stat(config.command).catch(() => null);
    if (!stat?.isFile()) throw new TypeError('stdio connector command must be an existing file');
    await fs.access(config.command, fs.constants.X_OK).catch(() => { throw new TypeError('stdio connector command must be executable'); });
    // Initialize and enumerate tools before creating an account connector.
    const verified = await this.open(config);
    const connectorId = await this.createRemote(config);
    try {
      const remote = (await this.remoteList()).find(item => item.connectorId === connectorId);
      if (!remote || !remote.enabled) throw connectorError('Doubao did not confirm the connector is enabled', 'connector_create_unconfirmed');
      const owned = await this.readOwned();
      owned[connectorId] = { ...config, connectorId, createdAt: new Date().toISOString() };
      await this.writeOwned(owned);
      // Re-key the verified server under its remote id for subsequent call/snapshot.
      const tempKey = [...this.clients.keys()].find(key => key !== connectorId && this.clients.get(key) === verified);
      if (tempKey) { this.clients.delete(tempKey); this.clients.set(connectorId, verified); }
    } catch (error) {
      await this.disconnect(connectorId, { cleanup: true }).catch(() => {});
      throw error;
    }
    return { connectorId, status: 'READY', tools: verified.tools.map(tool => tool.name) };
  }

  async list() {
    const [remote, owned] = await Promise.all([this.remoteList(), this.readOwned()]);
    return Promise.all(remote.map(async item => {
      const local = owned[item.connectorId];
      if (!local) return item;
      let localAvailable = false;
      try {
        const stat = await fs.stat(local.command);
        if (stat.isFile()) { await fs.access(local.command, fs.constants.X_OK); localAvailable = true; }
      } catch {}
      return { ...item, localAvailable, transport: 'stdio' };
    }));
  }

  async snapshot(connectorIds) {
    if (!Array.isArray(connectorIds)) throw new TypeError('connector IDs must be an array');
    const ids = [...new Set(connectorIds.map(String))];
    const [remote, owned] = await Promise.all([this.remoteList(), this.readOwned()]);
    const output = [];
    for (const connectorId of ids) {
      const item = remote.find(connector => connector.connectorId === connectorId);
      const config = owned[connectorId];
      if (!item || !item.enabled || !config) throw connectorError(`Headless connector ${connectorId} is not available`, 'connector_not_ready');
      const tools = await this.verifyServer(config);
      output.push({ connectorId, mcpToolsList: tools });
    }
    return output;
  }

  async call({ connectorId, toolName, arguments: input = {}, signal } = {}) {
    if (!validId(String(connectorId)) || !allowedToolName(toolName)) throw new TypeError('connector call requires a valid connector ID and tool name');
    const [remote, owned] = await Promise.all([this.remoteList(), this.readOwned()]);
    const item = remote.find(connector => connector.connectorId === String(connectorId));
    const config = owned[String(connectorId)];
    if (!item || !item.enabled || !config) throw connectorError('Headless connector is not owned, enabled, or available', 'connector_not_ready');
    const entry = await this.open(config);
    if (!entry.tools.some(tool => tool.name === toolName)) throw connectorError('Requested tool is not offered by this connector', 'connector_tool_not_found');
    let parsed = input;
    if (typeof input === 'string') {
      try { parsed = JSON.parse(input); } catch { throw new TypeError('connector tool arguments must be a JSON object'); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('connector tool arguments must be an object');
    if (Buffer.byteLength(JSON.stringify(parsed)) > 1024 * 1024) throw new TypeError('connector tool arguments exceed 1 MiB');
    const callTimeout = this.operationTimeout(CALL_TIMEOUT_MS);
    const controller = new AbortController();
    if (signal?.aborted) throw signal.reason || connectorError('stdio MCP tool call was cancelled', 'mcp_cancelled');
    const cancelForCaller = () => controller.abort(signal.reason || new Error('Connector call was cancelled'));
    signal?.addEventListener('abort', cancelForCaller, { once: true });
    const callTimer = setTimeout(() => controller.abort(new Error('Connector call timed out')), callTimeout);
    callTimer.unref?.();
    let result;
    try {
      result = await raceTimeout(entry.client.callTool({ name: toolName, arguments: parsed }, undefined, { signal: controller.signal }), callTimeout,
        'stdio MCP tool call timed out');
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (controller.signal.aborted) throw connectorError('stdio MCP tool call timed out', 'mcp_timeout');
      throw error;
    } finally {
      clearTimeout(callTimer);
      signal?.removeEventListener('abort', cancelForCaller);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw connectorError('MCP tool response exceeds 2 MiB', 'mcp_response_too_large');
    return { mcpResponseJson: result };
  }

  async remove(connectorId) {
    const id = String(connectorId || '');
    if (!validId(id)) throw new TypeError('connector ID must contain 6 to 25 digits');
    const owned = await this.readOwned();
    const removedOwned = Boolean(owned[id]);
    let remote = await this.remoteList();
    let item = remote.find(connector => connector.connectorId === id);
    if (item) {
      await this.disconnect(id).catch(() => {});
      remote = await this.remoteList();
      item = remote.find(connector => connector.connectorId === id);
      if (item?.enabled) {
        await this.setEnabled(id, false).catch(() => {});
        remote = await this.remoteList();
        item = remote.find(connector => connector.connectorId === id);
      }
      if (item?.enabled) throw connectorError('Connector remains active; local configuration was preserved', 'connector_still_active');
    }
    // Server state is confirmed absent or disabled before any local secret is removed.
    if (owned[id]) {
      const entry = this.clients.get(id);
      if (entry) {
        this.clients.delete(id);
        await entry.client.close().catch(() => {});
      }
      delete owned[id];
      await this.writeOwned(owned);
    }
    return { connectorId: id, removed: !item || item.enabled === false, serverInactive: !item || item.enabled === false,
      ownedLocalConfigurationRemoved: removedOwned };
  }

  async close() {
    this.closed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(entry => entry.client.close().catch(() => {})));
  }
}

async function defaultMcpClient(config) {
  const transport = new StdioClientTransport({ command: config.command, args: config.params, env: config.env, stderr: 'pipe' });
  const client = new Client({ name: 'doubao-cli-headless', version: '1.0.0' }, { capabilities: {} });
  return { client, transport };
}
