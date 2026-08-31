const DEFAULT_ENDPOINT = 'http://127.0.0.1:9225';

export function cdpEndpoint(env = process.env) {
  return (env.DOUBAO_CDP_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/u, '');
}

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function cdpStatus(endpoint = cdpEndpoint()) {
  try {
    const version = await fetchJson(`${endpoint}/json/version`);
    return { available: true, endpoint, browser: version.Browser, protocolVersion: version['Protocol-Version'] };
  } catch (error) {
    return { available: false, endpoint, error: error.message };
  }
}

export async function findChatTarget(endpoint = cdpEndpoint(), timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const targets = await fetchJson(`${endpoint}/json/list`);
    const target = targets.find(
      (item) => item.type === 'page' && /^(?:doubao|chrome):\/\/doubao-chat\/chat(?:\/|$)/u.test(item.url),
    );
    if (target?.webSocketDebuggerUrl) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`no Doubao chat page found at ${endpoint}`);
}

export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP WebSocket closed'));
      this.pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP client is not connected');
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript evaluation failed');
    }
    return result.result?.value;
  }

  async click(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('click target was not found');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('click target is not visible');
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async pressEscape() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 53,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 53,
    });
  }

  close() {
    this.socket?.close();
  }
}

export async function withChatClient(callback, endpoint = cdpEndpoint()) {
  const status = await cdpStatus(endpoint);
  if (!status.available) {
    throw new Error(`Doubao CDP is unavailable at ${endpoint}. Restart Doubao with --remote-debugging-port=9225.`);
  }
  const target = await findChatTarget(endpoint);
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    return await callback(client, target);
  } finally {
    client.close();
  }
}
