import { evaluateWithWatchdog } from './protocol.mjs';

export async function readUsage(client) {
  const response = await evaluateWithWatchdog(client, `(async () => {
    const req = await new Promise(resolve => {
      window['@flow-web/desktop:stable'].push([['doubao_usage_' + crypto.randomUUID()], {}, resolve]);
    });
    const matches = Object.entries(req.m).filter(([, factory]) => {
      const source = factory.toString();
      return source.includes('initApiService') && source.includes('"commerceSale"');
    });
    if (matches.length !== 1) throw new Error('Doubao usage service is unavailable or ambiguous; update the CLI');
    const services = Object.values(req(Number(matches[0][0])));
    const service = services.find(value => typeof value?.AGWGetSubscriptionQuotaSummary === 'function');
    if (!service) throw new Error('Doubao usage service is unavailable; update the CLI');
    return await service.AGWGetSubscriptionQuotaSummary({ product_line: 'membership' });
  })()`, 15000);
  return normalizeUsage(response);
}

export function normalizeUsage(response) {
  if (!response || (response.code !== undefined && response.code !== 0) || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new Error(`Doubao usage query failed: ${response?.message || response?.msg || response?.code || 'missing quota data'}`);
  }
  const data = response.data;
  const windows = [];
  for (const [key, source] of [['window_limit_section', 'personal'], ['enterprise_window_limit_section', 'enterprise'],
    ['quota_package_section', 'package'], ['incentive_quota_section', 'incentive']]) {
    for (const group of data[key]?.window_limit_groups || []) {
      for (const item of group.window_limits || []) {
        const usedPercent = typeof item.used_percent === 'number' && Number.isFinite(item.used_percent) && item.used_percent >= 0 && item.used_percent <= 100 ? item.used_percent : null;
        windows.push({ source, featureGroup: group.feature_group || null, name: group.feature_group_name || null,
          windowType: item.window_type, period: ({ 1: '5 hours', 2: '7 days', 3: 'subscription total', 4: 'month' })[item.window_type] || 'unknown',
          usedPercent, remainingPercent: usedPercent === null || item.less_than_one_percent ? null : Math.max(0, 100 - usedPercent),
          lessThanOnePercent: item.less_than_one_percent === true,
          unlimited: item.exemption?.active === true && item.window_type === 1,
          exhausted: !(item.exemption?.active === true && item.window_type === 1) && (data[key]?.usage_exhausted === true || usedPercent >= 100),
          usedAmount: item.used_amount ?? null, totalAmount: item.total_amount ?? null,
          resetsAt: timestamp(item.exemption?.active && item.window_type === 1 ? item.exemption.end_time : item.end_time) });
      }
    }
  }
  return { subscription: data.current_subscription?.display?.short_name || null,
    enterpriseSubscription: data.enterprise_subscription?.display?.short_name || null,
    windows };
}

function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 8640000000000000 ? new Date(number).toISOString() : null;
}

export function formatUsage(result) {
  const lines = [`subscription\t${result.subscription || 'none'}`];
  if (result.enterpriseSubscription) lines.push(`enterprise subscription\t${result.enterpriseSubscription}`);
  for (const window of result.windows) {
    const used = window.lessThanOnePercent ? '<1%' : window.usedPercent === null ? 'unknown' : `${window.usedPercent}%`;
    lines.push(`${window.source}\t${window.name || window.featureGroup || 'quota'}\t${window.period}\t${window.unlimited ? 'unlimited' : `used ${used}${window.remainingPercent === null ? '' : `, remaining ${window.remainingPercent}%`}${window.exhausted ? ', exhausted' : ''}`}${window.usedAmount !== null && window.totalAmount !== null ? `\t${window.usedAmount}/${window.totalAmount}` : ''}${window.resetsAt ? `\tresets ${window.resetsAt}` : ''}`);
  }
  if (!result.windows.length) lines.push('quota\tno usage windows returned');
  return lines.join('\n');
}
