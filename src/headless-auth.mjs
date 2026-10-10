const ORIGIN = 'https://www.doubao.com';
const NEXT = ORIGIN;
const QR_PATH = '/passport/web/get_qrcode/';
const CHECK_PATH = '/passport/web/check_qrconnect/';
const POLL_INTERVAL_MS = 1000;
const ALLOWED_REDIRECT_HOSTS = new Set(['www.doubao.com', 'doubao.com']);
const ACCOUNT_ID = /^[1-9]\d{5,24}$/u;

function loginError(code, message, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

function timeoutError() {
  return loginError('login_timeout', 'Doubao headless login timed out');
}

function remainingMs(deadline, now) {
  const remaining = deadline - now();
  if (remaining <= 0) throw timeoutError();
  return Math.max(1, Math.ceil(remaining));
}

async function withinDeadline(operation, deadline, now) {
  const remaining = remainingMs(deadline, now);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), remaining);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(operation), timeout]);
    if (now() >= deadline) throw timeoutError();
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function responseData(payload, operation) {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') {
    throw loginError('qr_login_protocol_error', `Doubao QR ${operation} returned an invalid response`);
  }
  const data = payload.data;
  const errorCode = Number(data.error_code ?? payload.error_code ?? 0);
  if (errorCode !== 0) {
    if (errorCode === 22 || Boolean(data.captcha)) {
      throw loginError('login_action_required', 'Doubao requires a security check; complete it in a supported browser and retry', {
        actionRequired: true,
        errorCode,
      });
    }
    throw loginError('qr_login_request_failed', `Doubao QR ${operation} failed`, { errorCode });
  }
  if (data.captcha) {
    throw loginError('login_action_required', 'Doubao requires a security check; complete it in a supported browser and retry', {
      actionRequired: true,
      errorCode,
    });
  }
  return data;
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 200;
}

async function consumeResponse(response, deadline, now) {
  if (typeof response?.arrayBuffer === 'function') {
    await withinDeadline(() => response.arrayBuffer(), deadline, now);
  } else if (typeof response?.text === 'function') {
    await withinDeadline(() => response.text(), deadline, now);
  }
  if (responseStatus(response) < 200 || responseStatus(response) >= 400) {
    throw loginError('qr_login_request_failed', 'Doubao headless login bootstrap request failed', {
      httpStatus: responseStatus(response),
    });
  }
}

async function bootstrap(client, deadline, now) {
  if (typeof client.request !== 'function') {
    throw new TypeError('headless login client must provide request()');
  }
  const response = await withinDeadline(
    () => client.request('/', { method: 'GET', timeoutMs: remainingMs(deadline, now) }),
    deadline,
    now,
  );
  // The page response establishes anonymous service cookies used by Passport.
  await consumeResponse(response, deadline, now);
}

function displayUrl(data) {
  if (typeof data.qrcode_index_url === 'string' && data.qrcode_index_url) return data.qrcode_index_url;
  if (typeof data.qrcode !== 'string') return undefined;
  try {
    const parsed = new URL(data.qrcode);
    return ['https:', 'http:'].includes(parsed.protocol) ? data.qrcode : undefined;
  } catch {
    return undefined;
  }
}

function redirectCandidate(data) {
  const keys = ['redirect_url', 'redirectUrl', 'redirect', 'url', 'next'];
  const candidates = [];
  for (const source of [data, data.extra]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (typeof source[key] === 'string' && source[key].trim()) candidates.push(source[key].trim());
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw loginError('qr_login_protocol_error', 'Doubao QR confirmation returned conflicting redirect targets');
  }
  return unique[0];
}

function validatedRedirect(value) {
  let url;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    throw loginError('unsafe_redirect', 'Doubao QR confirmation returned an invalid redirect target');
  }
  if (url.protocol !== 'https:' || !ALLOWED_REDIRECT_HOSTS.has(url.hostname)
      || url.username || url.password || url.port) {
    throw loginError('unsafe_redirect', 'Doubao QR confirmation returned a redirect outside the trusted Doubao HTTPS origins');
  }
  return url.href;
}

async function followRedirect(client, data, deadline, now) {
  const candidate = redirectCandidate(data);
  if (!candidate) return;
  let url = validatedRedirect(candidate);
  for (let hop = 0; hop < 5; hop++) {
    const response = await withinDeadline(
      () => client.request(url, { method: 'GET', timeoutMs: remainingMs(deadline, now) }), deadline, now);
    const location = response?.headers?.get('location');
    await consumeResponse(response, deadline, now);
    if (responseStatus(response) < 300 || responseStatus(response) >= 400) return;
    if (!location) throw loginError('qr_login_protocol_error', 'Doubao login redirect has no destination');
    url = validatedRedirect(new URL(location, url).href);
  }
  throw loginError('qr_login_protocol_error', 'Doubao login exceeded the redirect limit');
}

function notify(callback, value, deadline, now) {
  return withinDeadline(() => callback(value), deadline, now);
}

/**
 * Sign in by presenting an ordinary Doubao QR code and polling its read-only
 * Passport status endpoint. The QR token stays local to this function.
 */
export async function qrLogin(client, {
  timeoutMs = 120_000,
  onQr = () => {},
  onStatus = () => {},
  pollIntervalMs = POLL_INTERVAL_MS,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > POLL_INTERVAL_MS) {
    throw new TypeError('pollIntervalMs must be between 0 and 1000');
  }
  if (typeof client?.json !== 'function') throw new TypeError('headless login client must provide json()');
  if (typeof client?.account !== 'function') throw new TypeError('headless login client must provide account()');
  if (typeof onQr !== 'function' || typeof onStatus !== 'function' || typeof sleepImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('login callbacks and clock functions must be callable');
  }

  const deadline = now() + timeoutMs;
  await bootstrap(client, deadline, now);

  const issuedPayload = await withinDeadline(
    () => client.json(QR_PATH, {
      method: 'GET',
      params: { next: NEXT },
      timeoutMs: remainingMs(deadline, now),
    }),
    deadline,
    now,
  );
  const issued = responseData(issuedPayload, 'issuance');
  const token = issued.token;
  if (typeof token !== 'string' || !token) {
    throw loginError('qr_login_protocol_error', 'Doubao QR issuance did not return a login token');
  }
  if (typeof issued.qrcode !== 'string' || !issued.qrcode) {
    throw loginError('qr_login_protocol_error', 'Doubao QR issuance did not return a QR payload');
  }
  await notify(onQr, {
    url: displayUrl(issued),
    expiresIn: issued.expire_time,
  }, deadline, now);

  while (true) {
    const checkPayload = await withinDeadline(
      () => client.json(CHECK_PATH, {
        method: 'GET',
        params: { next: NEXT, token },
        timeoutMs: remainingMs(deadline, now),
      }),
      deadline,
      now,
    );
    const check = responseData(checkPayload, 'status check');
    const status = check.status;
    if (!['new', 'scanned', 'confirmed'].includes(status)) {
      if (status === 'expired') throw loginError('qr_expired', 'Doubao QR code expired; start login again');
      if (status === 'cancelled' || status === 'canceled' || status === 'rejected') {
        throw loginError('qr_login_cancelled', 'Doubao QR login was cancelled');
      }
      throw loginError('qr_login_protocol_error', 'Doubao QR status response contained an unsupported state');
    }
    await notify(onStatus, { status }, deadline, now);
    if (status === 'confirmed') {
      await followRedirect(client, check, deadline, now);
      const account = await withinDeadline(
        () => client.account({ timeoutMs: remainingMs(deadline, now) }),
        deadline,
        now,
      );
      if (!ACCOUNT_ID.test(account?.accountId || '')) {
        throw loginError('account_verification_failed', 'Doubao QR login completed, but the authenticated account could not be verified');
      }
      return { loggedIn: true, accountId: account.accountId };
    }
    const remaining = remainingMs(deadline, now);
    await withinDeadline(
      () => sleepImpl(Math.min(pollIntervalMs, remaining)),
      deadline,
      now,
    );
  }
}
