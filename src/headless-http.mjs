import { randomBytes, randomUUID } from 'node:crypto';

export const HEADLESS_ORIGIN = 'https://www.doubao.com';
const HOSTS = new Set(['www.doubao.com', 'doubao.com', 'passport.doubao.com']);

export function allowedHeadlessUrl(value) {
  const url = new URL(value, HEADLESS_ORIGIN);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw new Error('Headless requests must use an approved Doubao HTTPS endpoint');
  }
  return url;
}

export class CookieJar {
  constructor(cookies = []) { this.cookies = cookies.map(cookie => ({ ...cookie })); }
  set(line, source) {
    const url = allowedHeadlessUrl(source);
    const [pair, ...attributes] = line.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1) return;
    const cookie = { name: pair.slice(0, equal).trim(), value: pair.slice(equal + 1).trim(),
      domain: url.hostname, hostOnly: true, path: url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/', secure: false };
    if (!/^[\w!#$%&'*+.^`|~-]+$/u.test(cookie.name) || /[\r\n]/u.test(cookie.value)) throw new Error('Invalid cookie data');
    let maxAge;
    for (const attribute of attributes) {
      const [name, ...values] = attribute.trim().split('=');
      const value = values.join('=');
      if (name.toLowerCase() === 'domain') { cookie.domain = value.toLowerCase().replace(/^\./u, ''); cookie.hostOnly = false; }
      if (name.toLowerCase() === 'path') cookie.path = value || '/';
      if (name.toLowerCase() === 'secure') cookie.secure = true;
      if (name.toLowerCase() === 'expires') cookie.expires = Date.parse(value);
      if (name.toLowerCase() === 'max-age' && /^-?\d+$/u.test(value)) maxAge = Number(value);
    }
    if (maxAge !== undefined) cookie.expires = Date.now() + maxAge * 1000;
    if (cookie.domain !== 'doubao.com' && !HOSTS.has(cookie.domain)) return;
    if (!(url.hostname === cookie.domain || url.hostname.endsWith('.' + cookie.domain))) return;
    this.cookies = this.cookies.filter(old => old.name !== cookie.name || old.domain !== cookie.domain || old.path !== cookie.path);
    if (cookie.expires === undefined || !Number.isFinite(cookie.expires) || cookie.expires > Date.now()) this.cookies.push(cookie);
  }
  header(source) {
    const url = allowedHeadlessUrl(source);
    const matching = this.cookies.filter(cookie => (cookie.expires === undefined || cookie.expires === null || !Number.isFinite(cookie.expires) || cookie.expires > Date.now())
      && (cookie.hostOnly ? url.hostname === cookie.domain : url.hostname === cookie.domain || url.hostname.endsWith('.' + cookie.domain))
      && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/')))
      .sort((a, b) => b.path.length - a.path.length);
    if (matching.some(cookie => !/^[\w!#$%&'*+.^`|~-]+$/u.test(cookie.name) || /[\r\n]/u.test(cookie.value))) throw new Error('Invalid cookie data');
    return matching
      .map(cookie => cookie.name + '=' + cookie.value).join('; ');
  }
  static import(text) {
    const jar = new CookieJar();
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (Array.isArray(cookies)) {
      for (const cookie of cookies) {
        if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') throw new Error('Invalid cookie file');
        const domain = (cookie.domain || 'www.doubao.com').replace(/^\./u, '');
        if (domain !== 'doubao.com' && !HOSTS.has(domain)) continue;
        jar.set(`${cookie.name}=${cookie.value}; Domain=${domain}; Path=${cookie.path || '/'}${cookie.expires > 0 ? '; Expires=' + new Date(cookie.expires * 1000).toUTCString() : ''}`, HEADLESS_ORIGIN);
      }
    } else {
      const header = parsed?.cookie ?? text.trim();
      if (typeof header !== 'string' || !header || /[\r\n]/u.test(header) || header.length > 65536) throw new Error('Cookie file must contain a Cookie header or cookie JSON');
      for (const pair of header.split(';')) jar.set(pair.trim() + '; Domain=doubao.com; Path=/', HEADLESS_ORIGIN);
    }
    if (!jar.cookies.some(cookie => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(cookie.name) && cookie.value)) {
      throw new Error('Cookie file has no Doubao login session');
    }
    return jar;
  }
}

export function newDevice() {
  const id = () => BigInt('0x' + randomBytes(8).toString('hex')).toString();
  return { web_id: id(), device_id: id() };
}

export class HeadlessClient {
  constructor({ cookies = [], device = newDevice(), accountId, fetchImpl = fetch } = {}) {
    this.jar = cookies instanceof CookieJar ? cookies : new CookieJar(cookies);
    this.device = device;
    this.accountId = accountId;
    this.fetchImpl = fetchImpl;
  }
  async request(route, { method = 'GET', params = {}, body, headers = {}, timeoutMs = 10000 } = {}) {
    const url = allowedHeadlessUrl(route);
    // Work's protocol revision enables structured messages and its model catalog.
    // This is adapter compatibility metadata; no desktop executable is used.
    const passport = url.pathname.startsWith('/passport/') || url.pathname === '/';
    for (const [key, value] of Object.entries({ aid: passport ? '497858' : '1044603', device_platform: 'web', samantha_web: '1',
      ...(!passport ? { pc_version: '2.31.10', doubao_pc_version: '2.31.10' } : {}),
      version_code: '20800', language: 'zh', region: 'CN', sys_region: 'CN', ...this.device, ...params })) {
      url.searchParams.set(key, String(value));
    }
    const cookie = this.jar.header(url);
    const csrf = cookie.split('; ').find(item => item.startsWith('passport_csrf_token='))?.slice('passport_csrf_token='.length);
    const response = await this.fetchImpl(url.href, { method, redirect: 'manual',
      headers: { ...headers, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-tt-passport-csrf-token': csrf } : {}) },
      body, signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) });
    for (const value of response.headers.getSetCookie?.() || []) this.jar.set(value, url);
    if ([401, 403].includes(response.status)) throw Object.assign(new Error('Doubao login expired or access was denied; run "doubao headless login"'), { code: 'login_required' });
    return response;
  }
  async json(route, options = {}) {
    const response = await this.request(route, options);
    if (!response.ok) throw new Error(`Doubao HTTP request failed (${response.status})`);
    try { return await response.json(); }
    catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      throw new Error('Doubao returned an invalid JSON response');
    }
  }
  async account(options = {}) {
    const result = await this.json('/passport/account/info/v2/', options);
    const data = result.data;
    const accountId = String(data?.user_id_str || data?.user_id || '');
    if (data?.error_code || !/^[1-9]\d{5,24}$/u.test(accountId) || data?.is_visitor_account) {
      throw Object.assign(new Error('Doubao login is required; run "doubao headless login"'), { code: 'login_required' });
    }
    if (this.accountId && this.accountId !== accountId) throw Object.assign(new Error('Headless account changed; log in again before continuing'), { code: 'account_changed' });
    this.accountId = accountId;
    return { accountId };
  }
  async imRequest(route, cmd, key, body, timeoutMs = 10000) {
    const result = await this.json('/im/' + route, { method: 'POST', timeoutMs,
      headers: { 'content-type': 'application/json; encoding=utf-8' },
      body: JSON.stringify({ cmd, uplink_body: { [key]: body }, sequence_id: randomUUID(), channel: 2, version: '1' }) });
    if (result.status_code !== 0) throw Object.assign(new Error(`Doubao IM request was rejected (${result.status_code ?? 'unknown'})`), { code: 'request_rejected' });
    return result.downlink_body;
  }
  async terminateTask(threadId, timeoutMs) {
    if (!/^[1-9]\d{11,23}$/u.test(String(threadId))) throw new Error('Invalid task thread id');
    return this.json('/alice/generaltask/terminate', { method: 'POST', timeoutMs,
      headers: { 'content-type': 'application/json' }, body: `{"thread_id":${threadId}}` });
  }
}

// Works on arbitrary UTF-8/chunk/CRLF boundaries. An unterminated stream is not success.
export async function consumeSse(response, onEvent) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`Doubao completion did not return an event stream (${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Doubao event stream is missing');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Doubao event frame exceeds the size limit');
      let delimiter;
      while ((delimiter = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        let event = '', id = '', data = [];
        for (const line of frame.split(/\r?\n/u)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('id:')) id = line.slice(3).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!event || !data.length) continue;
        let payload;
        try { payload = JSON.parse(data.join('\n')); } catch { throw new Error('Doubao event stream contains invalid JSON'); }
        if (await onEvent(event, payload, id) === 'stop') return;
      }
      if (part.done) return;
    }
  } finally { await reader.cancel().catch(() => {}); }
}
