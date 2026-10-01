import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readUsage, normalizeUsage, formatUsage } from '../src/usage.mjs';

const response = { code: 0, data: { current_subscription: { display: { short_name: 'Pro' } },
  window_limit_section: { window_limit_groups: [{ feature_group: 'general', window_limits: [
    { window_type: 1, used_percent: 2, end_time: 1790850571376 },
    { window_type: 2, used_percent: 29 },
  ] }] } } };

test('usage exposes verified percentages and reset times', () => {
  const result = normalizeUsage(response);
  assert.equal(result.subscription, 'Pro');
  assert.equal(result.windows[0].remainingPercent, 98);
  assert.equal(result.windows[1].period, '7 days');
  assert.equal(result.windows[0].resetsAt, new Date(1790850571376).toISOString());
  assert.match(formatUsage(result), /used 29%, remaining 71%/);
});

test('unknown, fractional, unlimited and exhausted quota remain distinct', () => {
  const result = normalizeUsage({ data: { enterprise_window_limit_section: { usage_exhausted: true,
    window_limit_groups: [{ window_limits: [
      { window_type: 1, used_percent: 0, less_than_one_percent: true, exemption: { active: true } },
      { window_type: 4, used_amount: '100', total_amount: '100', used_percent: 100 },
      { window_type: 99 },
    ] }] } } });
  assert.equal(result.windows[0].remainingPercent, null);
  assert.equal(result.windows[0].unlimited, true);
  assert.equal(result.windows[0].exhausted, false);
  const fractional = normalizeUsage({ data: { quota_package_section: { window_limit_groups: [{ window_limits: [{ window_type: 3, used_percent: 0, less_than_one_percent: true }] }] } } });
  assert.match(formatUsage(fractional), /used <1%/);
  assert.equal(fractional.windows[0].remainingPercent, null);
  assert.equal(result.windows[1].remainingPercent, 0);
  assert.equal(result.windows[2].usedPercent, null);
  assert.equal(result.windows[2].resetsAt, null);
  assert.match(formatUsage(result), /unlimited/);
  assert.match(formatUsage(result), /100\/100/);
  assert.match(formatUsage(result), /unknown/);
  assert.match(formatUsage(normalizeUsage({ data: {} })), /no usage windows/);
});

test('quota query failures never become empty success', () => {
  for (const value of [null, {}, { code: 403, message: 'denied', data: {} }]) {
    assert.throws(() => normalizeUsage(value), /usage query failed/);
  }
});

test('reader discovers services across module ids and propagates errors', async () => {
  const service = { AGWGetSubscriptionQuotaSummary: async input => {
    assert.deepEqual(JSON.parse(JSON.stringify(input)), { product_line: 'membership' });
    return response;
  } };
  const req = () => ({ changedExport: service });
  req.m = { 42: () => 'initApiService "commerceSale"' };
  const client = { evaluate: expression => vm.runInNewContext(expression, {
    crypto, window: { '@flow-web/desktop:stable': { push: entry => entry[2](req) } },
  }) };
  assert.equal((await readUsage(client)).windows.length, 2);
  req.m = {};
  await assert.rejects(readUsage(client), /unavailable or ambiguous/);
});
