import { randomUUID } from 'node:crypto';

const STREAM = '/alice/office/tool_local/chunk_stream';
const RESULT = '/alice/office/tool_local/upload_tool_call_result';
const COMMON_PARAMS = new Set(['aid', 'real_aid', 'channel', 'chromium_version', 'client_platform',
  'device_id', 'device_platform', 'doubao_device_platform', 'doubao_pc_version', 'fp', 'language',
  'pc_version', 'pkg_type', 'region', 'runtime', 'runtime_version', 'samantha_web', 'sys_region',
  'tea_uuid', 'tz_name', 'use-olympus-account', 'version_code', 'web_id', 'web_platform', 'web_tab_id']);

// Runs only inside the authenticated app renderer. Never reads cookies or tokens.
async function rendererOperation(operation, args) {
  const key = args.key;
  const dispose = state => {
    if (!state) return;
    state.controller.abort();
    clearInterval(state.watchdog);
    clearTimeout(state.deadline);
    state.wake?.();
    delete window[key];
  };
  if (operation === 'close') { dispose(window[key]); return; }
  const existing = window[key];
  if (operation !== 'drain' && existing) throw Error('Desktop MCP operation already exists');
  const state = operation === 'drain' ? existing : (window[key] = { controller: new AbortController(), chunks: [], bytes: 0, done: false, touched: Date.now(), wake: null });
  if (operation !== 'drain') {
    state.watchdog = setInterval(() => {
      if (Date.now() - state.touched > 15_000) dispose(state);
    }, 1000);
    state.deadline = setTimeout(() => dispose(state), args.timeoutMs || 120_000);
  }
  const identity = async () => {
    const user = await window.neotix.account.getLoginUser();
    if (!user?.isLogin || String(user.userId) !== args.accountId) throw Error('Desktop MCP account changed');
    const entry = performance.getEntriesByType('resource').slice().reverse().find(entry => {
      try { const u = new URL(entry.name); return u.origin === 'https://www.doubao.com'
        && u.pathname.startsWith('/im/') && u.searchParams.has('device_id') && u.searchParams.has('aid'); }
      catch { return false; }
    });
    const query = entry && new URL(entry.name).searchParams;
    if (!query || query.get('aid') !== args.params.aid || query.get('device_id') !== args.params.device_id) {
      throw Error('Desktop MCP runtime identity changed');
    }
  };
  try { await identity(); } catch (error) { dispose(window[key]); throw error; }
  if (!state || window[key] !== state || state.controller.signal.aborted) throw Error('Desktop MCP operation was cancelled');
  if (operation === 'drain') {
    if (!state) throw Error('Desktop MCP stream is no longer available');
    state.touched = Date.now();
    const chunks = state.chunks.splice(0);
    state.bytes = 0;
    state.wake?.(); state.wake = null;
    return { chunks, done: state.done, error: state.error };
  }
  if (operation === 'call') {
    let result;
    try { result = await window.neotix.mcp.callTool(args.call); } finally { dispose(state); }
    if (result?.nativeError) throw Error('Desktop MCP native tool call failed');
    if (typeof result?.mcpResponseJson !== 'string') throw Error('Desktop MCP native response is invalid');
    return { mcpResponseJson: result.mcpResponseJson };
  }
  const url = new URL(args.path, 'https://www.doubao.com');
  for (const [name, value] of Object.entries({ ...args.params, ...args.query })) url.searchParams.set(name, value);
  let response;
  try {
    response = await fetch(url.href, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'Agw-Js-Conv': 'str', ...args.headers },
      body: args.body, signal: state.controller.signal });
    if (operation === 'json') {
      const text = await response.text();
      if (text.length > 1024 * 1024) throw Error('Desktop MCP result response exceeds limit');
      if (!response.ok) throw Error(`Desktop MCP result upload HTTP ${response.status}`);
      return JSON.parse(text);
    }
    if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
      dispose(state);
      throw Error(`Desktop MCP stream rejected HTTP ${response.status}`);
    }
    clearTimeout(state.deadline);
    state.deadline = setTimeout(() => dispose(state), args.timeoutMs);
    const reader = response.body.getReader();
    // Backpressure at 1 MiB, plus at most one 1 MiB in-flight chunk.
    void (async () => {
      try {
        while (!state.controller.signal.aborted) {
          if (state.bytes >= 1024 * 1024) await new Promise(resolve => { state.wake = resolve; });
          if (state.controller.signal.aborted) break;
          const part = await reader.read();
          if (part.done) break;
          if (part.value.byteLength > 1024 * 1024) throw Error('Desktop MCP stream chunk exceeds limit');
          state.chunks.push(Array.from(part.value)); state.bytes += part.value.byteLength;
        }
      } catch { if (!state.controller.signal.aborted) state.error = 'Desktop MCP stream interrupted'; }
      finally { state.done = true; reader.releaseLock(); }
    })();
    return { status: response.status, contentType: response.headers.get('content-type') };
  } catch (error) { dispose(state); throw error; }
  finally { if (operation === 'json') dispose(state); }
}

/** Adapter for a scoped MCP relay; it never retries a tool call or result upload. */
export function createDesktopMcpTransport(client, { params, accountId } = {}) {
  if (typeof client?.evaluate !== 'function') throw new TypeError('A CDP evaluator is required');
  if (!params || typeof params.aid !== 'string' || !/^\d+$/.test(params.device_id || '') || !accountId) {
    throw new TypeError('Desktop MCP requires an account and native device identity');
  }
  const common = Object.fromEntries(Object.entries(params).filter(([name]) => COMMON_PARAMS.has(name)));
  const active = new Set(), lifetime = new AbortController(); let closed = false;
  const evaluate = (operation, args) => client.evaluate(`(${rendererOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args, params: common, accountId: String(accountId) })})`);
  const dispose = async key => {
    active.delete(key); let timer;
    try { await Promise.race([evaluate('close', { key }).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  };
  async function invoke(operation, args, { signal, timeoutMs = 10_000 } = {}) {
    if (closed) throw Error('Desktop MCP transport is closed');
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    let timer, abort;
    try {
      return await Promise.race([evaluate(operation, args), new Promise((_, reject) => {
        abort = () => reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(Error('Desktop MCP operation timed out')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function prepare(path, options, expected) {
    if (path !== expected || options.method && options.method !== 'POST') throw Error('Unsupported Desktop MCP request');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (!body || body.device_id !== common.device_id || typeof body.sandbox_id !== 'string' && typeof body.client_attrs?.sandbox_id !== 'string') {
      throw Error('Desktop MCP request does not match the local device and sandbox');
    }
    const query = {};
    if (path === STREAM) {
      if (typeof options.params?.sand_box_id !== 'string' || options.params.sand_box_id !== body.client_attrs.sandbox_id) throw Error('Desktop MCP stream sandbox mismatch');
      query.sand_box_id = options.params.sand_box_id; query.client_version = 'unspecified';
    }
    const headers = {};
    const lastId = options.headers?.['last-event-id'];
    if (lastId !== undefined) {
      if (typeof lastId !== 'string' || lastId.length > 1024 || /[\r\n]/.test(lastId)) throw Error('Invalid Desktop MCP event cursor');
      headers['last-event-id'] = lastId;
    }
    return { key: '__doubaoMcpTransport_' + randomUUID().replaceAll('-', ''), path,
      body: options.body, query, headers, timeoutMs: Math.max(1000, Math.min(300_000, options.timeoutMs || 300_000)) };
  }
  return {
    async request(path, options = {}) {
      const args = prepare(path, options, STREAM); active.add(args.key);
      let response;
      try { response = await invoke('start', args, { signal: options.signal }); }
      catch (error) { await dispose(args.key); throw error; }
      let aborted;
      const stream = new ReadableStream({
        start(controller) {
          aborted = () => { controller.error(options.signal.reason || new DOMException('Aborted', 'AbortError')); void dispose(args.key); };
          options.signal?.addEventListener('abort', aborted, { once: true });
          if (options.signal?.aborted) aborted();
        },
        async pull(controller) {
          try {
            while (true) {
              const state = await invoke('drain', { key: args.key }, { signal: options.signal });
              if (state.error) throw Error(state.error);
              for (const bytes of state.chunks) controller.enqueue(Uint8Array.from(bytes));
              if (state.done) { controller.close(); options.signal?.removeEventListener('abort', aborted); await dispose(args.key); }
              if (state.done || state.chunks.length) return;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (error) { options.signal?.removeEventListener('abort', aborted); controller.error(error); await dispose(args.key); }
        },
        async cancel() { options.signal?.removeEventListener('abort', aborted); await dispose(args.key); },
      });
      return { ok: true, status: response.status, headers: { get: name => name.toLowerCase() === 'content-type' ? response.contentType : null }, body: stream };
    },
    async json(path, options = {}) {
      const args = prepare(path, options, RESULT); active.add(args.key);
      try { return await invoke('json', args, { signal: options.signal }); }
      finally { await dispose(args.key); }
    },
    async callConnector({ connectorId, toolName, arguments: rawArguments, signal } = {}) {
      if (typeof connectorId !== 'string' || !connectorId || typeof toolName !== 'string' || !toolName || typeof rawArguments !== 'string') throw Error('Invalid Desktop MCP tool call');
      const key = '__doubaoMcpTransport_' + randomUUID().replaceAll('-', ''); active.add(key);
      try { return await invoke('call', { key, call: { connectorId, toolName, arguments: rawArguments } }, { signal, timeoutMs: 120_000 }); }
      finally { await dispose(key); }
    },
    async close() { closed = true; lifetime.abort(new Error('Desktop MCP transport is closed')); await Promise.all([...active].map(dispose)); },
  };
}
