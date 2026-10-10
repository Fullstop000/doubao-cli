import assert from 'node:assert/strict';
import test from 'node:test';
import { qrLogin } from '../src/headless-auth.mjs';

const accountId = '123456789012345678';
const qrPayload = {
  error_code: 0,
  data: {
    error_code: 0,
    token: 'private-qr-token',
    qrcode: 'doubao://scan/private-qr-token',
    qrcode_index_url: 'https://www.doubao.com/scan',
    expire_time: 180,
  },
};

function clientHarness({ checks = [], account = { accountId }, issue = qrPayload, bootstrap = new Response('<html></html>') } = {}) {
  const calls = [];
  let checkIndex = 0;
  return {
    calls,
    client: {
      async request(route, options) {
        calls.push({ method: 'request', route, options });
        return typeof bootstrap?.clone === 'function' ? bootstrap.clone() : bootstrap;
      },
      async json(route, options) {
        calls.push({ method: 'json', route, options });
        if (route.endsWith('/get_qrcode/')) return issue;
        if (route.endsWith('/check_qrconnect/')) {
          const check = checks[checkIndex++];
          if (!check) assert.fail('unexpected QR status poll');
          return check;
        }
        assert.fail(`unexpected JSON route ${route}`);
      },
      async account(options) {
        calls.push({ method: 'account', options });
        return account;
      },
    },
  };
}

const status = value => ({ data: { error_code: 0, status: value } });

test('QR login presents the code, polls read-only statuses, follows trusted redirect, and verifies identity', async () => {
  const { client, calls } = clientHarness({ checks: [status('new'), status('scanned'), {
    data: { error_code: 0, status: 'confirmed', redirect_url: 'https://www.doubao.com/auth/login_success/' },
  }] });
  const presented = [];
  const updates = [];
  const sleeps = [];
  const result = await qrLogin(client, {
    timeoutMs: 1000,
    pollIntervalMs: 2,
    sleepImpl: async ms => sleeps.push(ms),
    onQr: value => presented.push(value),
    onStatus: value => updates.push(value),
  });

  assert.deepEqual(result, { loggedIn: true, accountId });
  assert.deepEqual(presented, [{
    url: 'https://www.doubao.com/scan',
    expiresIn: 180,
  }]);
  assert.deepEqual(updates, [{ status: 'new' }, { status: 'scanned' }, { status: 'confirmed' }]);
  assert.deepEqual(sleeps, [2, 2]);
  const polls = calls.filter(call => call.method === 'json' && call.route.endsWith('/check_qrconnect/'));
  assert.equal(polls.length, 3);
  assert.ok(polls.every(call => call.options.method === 'GET'));
  assert.ok(polls.every(call => call.options.params.next === 'https://www.doubao.com'));
  assert.ok(polls.every(call => call.options.params.token === 'private-qr-token'));
  assert.ok(calls.some(call => call.method === 'request' && call.route === 'https://www.doubao.com/auth/login_success/'));
  assert.ok(calls.every(call => call.method !== 'json' || !call.route.includes('scan_qrcode') && !call.route.includes('confirm_qrcode')));
});

test('timeout covers bootstrap response body reading', async () => {
  const { client } = clientHarness({ bootstrap: {
    status: 200,
    arrayBuffer: () => new Promise(() => {}),
  } });
  await assert.rejects(qrLogin(client, { timeoutMs: 20 }), error => {
    assert.equal(error.code, 'login_timeout');
    return true;
  });
});

test('one overall timeout bounds a stalled QR status request', async () => {
  const calls = [];
  const client = {
    async request(route, options) {
      calls.push({ route, options });
      return new Response('<html></html>');
    },
    async json(route, options) {
      calls.push({ route, options });
      if (route.endsWith('/get_qrcode/')) return qrPayload;
      return new Promise(() => {});
    },
    async account() { assert.fail('account verification must not run before confirmation'); },
  };
  await assert.rejects(qrLogin(client, { timeoutMs: 30 }), error => {
    assert.equal(error.code, 'login_timeout');
    return true;
  });
  const budgets = calls.map(call => call.options.timeoutMs);
  assert.ok(budgets.every(budget => budget > 0 && budget <= 30));
});

test('security challenge stops with a user-action error and never starts polling', async () => {
  const { client, calls } = clientHarness({ issue: {
    data: { error_code: 22, captcha: '', description: 'omitted' },
  } });
  await assert.rejects(qrLogin(client, { timeoutMs: 100 }), error => {
    assert.equal(error.code, 'login_action_required');
    assert.equal(error.actionRequired, true);
    return true;
  });
  assert.equal(calls.filter(call => call.method === 'json' && call.route.endsWith('/check_qrconnect/')).length, 0);
});

test('unauthorized QR issuance fails closed without exposing response text', async () => {
  const { client, calls } = clientHarness({ issue: {
    data: { error_code: 13, description: 'private response text' },
  } });
  await assert.rejects(qrLogin(client, { timeoutMs: 100 }), error => {
    assert.equal(error.code, 'qr_login_request_failed');
    assert.equal(error.errorCode, 13);
    assert.doesNotMatch(error.message, /private response text/u);
    return true;
  });
  assert.equal(calls.filter(call => call.method === 'json' && call.route.endsWith('/check_qrconnect/')).length, 0);
});

test('confirmed QR cannot follow a redirect outside Doubao HTTPS origins', async () => {
  const { client, calls } = clientHarness({ checks: [{
    data: { error_code: 0, status: 'confirmed', redirect_url: 'https://attacker.invalid/collect' },
  }] });
  await assert.rejects(qrLogin(client, {
    timeoutMs: 1000,
    pollIntervalMs: 0,
    sleepImpl: async () => {},
  }), error => {
    assert.equal(error.code, 'unsafe_redirect');
    return true;
  });
  assert.equal(calls.filter(call => call.method === 'request' && String(call.route).includes('attacker.invalid')).length, 0);
  assert.equal(calls.filter(call => call.method === 'account').length, 0);
});

test('confirmed login validates each HTTP redirect hop before following it', async () => {
  const { client, calls } = clientHarness({ checks: [{ data: {
    error_code: 0, status: 'confirmed', redirect_url: 'https://www.doubao.com/auth/login_success/',
  } }] });
  client.request = async route => {
    calls.push({ method: 'request', route });
    return route === '/' ? new Response('<html></html>') : new Response('', {
      status: 302, headers: { location: 'https://attacker.invalid/collect' },
    });
  };
  await assert.rejects(qrLogin(client, { timeoutMs: 1000 }), error => error.code === 'unsafe_redirect');
  assert.equal(calls.filter(call => String(call.route).includes('attacker.invalid')).length, 0);
  assert.equal(calls.filter(call => call.method === 'account').length, 0);
});

test('confirmed QR fails when the post-login account identity is missing', async () => {
  const { client } = clientHarness({ checks: [status('confirmed')], account: { accountId: null } });
  await assert.rejects(qrLogin(client, { timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'account_verification_failed');
    return true;
  });
});

test('unknown statuses fail closed instead of being treated as confirmation', async () => {
  const { client } = clientHarness({ checks: [status('complete')] });
  await assert.rejects(qrLogin(client, { timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'qr_login_protocol_error');
    return true;
  });
});
