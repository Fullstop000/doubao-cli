import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connectionBadgeSettingsPath, readConnectionBadgeSettings } from './connection-badge-settings.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const BADGE_ID = 'doubao-cli-connection';

// Runs in the selected desktop renderer. Keep dynamic values out of HTML.
function updateBadge(id, connection, connected) {
  if (window.__doubaoCliBadgeVisible === false) return;
  let host = document.getElementById(id);
  if (!host && !connected) return;
  if (!document.body) return;
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;z-index:2147483647;top:12px;right:12px;-webkit-app-region:no-drag;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
        button{font:inherit;cursor:pointer;color:inherit;border:0}
        .pill{display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 10px;border-radius:999px;
          box-sizing:border-box;width:164px;max-width:calc(100vw - 24px);height:28px;white-space:nowrap;
          font-size:12px;color:#fff;background:#232733;box-shadow:0 1px 5px #0003}
        .dot{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:#9098a5}
        .label{overflow:hidden;text-overflow:ellipsis}
        [data-health="connected"] .dot{background:#38d39f}
        [data-health="degraded"] .dot{background:#f5a623}
        .panel{position:absolute;top:100%;right:0;margin-top:6px;padding:12px;border-radius:10px;
          box-sizing:border-box;width:280px;max-width:calc(100vw - 16px);font-size:12px;line-height:1.7;color:#fff;
          background:#232733;box-shadow:0 2px 8px #0003;overflow-wrap:anywhere;overflow-y:auto}
        .panel[hidden]{display:none} .details{white-space:pre-wrap} .hint{color:#bbc1cc}
        .dismiss{margin-top:8px;padding:3px 8px;background:#ffffff20;border-radius:5px}
      </style>
      <button class="pill" aria-expanded="false" aria-controls="details" title="doubao-cli 连接状态">
        <span class="dot" aria-hidden="true"></span><span class="label"></span>
      </button>
      <div class="panel" id="details" hidden>
        <strong>doubao-cli → <span class="app"></span></strong>
        <div class="details"></div>
        <div class="hint">状态表示 CLI 当前连接；命令结束后断开。</div>
        <button class="dismiss">收起</button>
      </div>`;
    const pill = root.querySelector('.pill');
    const panel = root.querySelector('.panel');
    const close = () => { panel.hidden = true; pill.setAttribute('aria-expanded', 'false'); };
    pill.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      pill.setAttribute('aria-expanded', String(!panel.hidden));
      host.refresh();
    });
    root.querySelector('.dismiss').addEventListener('click', close);
    root.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    host.connections = new Map();
    host.reposition = () => {
      const anchor = document.querySelector('[data-testid="global-search-icon-entry"]');
      const rect = anchor?.getBoundingClientRect();
      const width = host.getBoundingClientRect().width;
      const height = host.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      // Ignore hidden/offscreen search entries. Fixed pill dimensions keep status
      // changes from moving the badge or switching between anchor and fallback.
      const visibleAnchor = rect?.width > 0 && rect.height > 0 && rect.top >= 0
        && rect.top + rect.height <= viewportHeight && rect.left >= 0
        && rect.left + rect.width <= viewportWidth;
      const anchored = visibleAnchor && rect.left >= width + 20;
      const top = anchored ? rect.top + (rect.height - height) / 2
        : visibleAnchor ? rect.top + rect.height + 8 : 12;
      host.style.top = `${Math.round(Math.max(8, Math.min(top, viewportHeight - height - 8)))}px`;
      host.style.right = `${anchored ? Math.round(viewportWidth - rect.left + 8) : 12}px`;
      if (!panel.hidden) {
        panel.style.transform = '';
        panel.style.top = '100%';
        panel.style.bottom = 'auto';
        panel.style.marginTop = '6px';
        panel.style.marginBottom = '0';
        panel.style.maxHeight = `${Math.max(0, viewportHeight - 16)}px`;
        const bounds = panel.getBoundingClientRect();
        const hostTop = Number.parseFloat(host.style.top);
        const below = Math.max(0, viewportHeight - hostTop - height - 14);
        const above = Math.max(0, hostTop - 14);
        const flip = bounds.height > below && above > below;
        if (flip) {
          panel.style.top = 'auto';
          panel.style.bottom = '100%';
          panel.style.marginTop = '0';
          panel.style.marginBottom = '6px';
        }
        panel.style.maxHeight = `${flip ? above : below}px`;
        const offset = Math.max(8 - bounds.left, Math.min(0, viewportWidth - 8 - bounds.right));
        panel.style.transform = `translateX(${offset}px)`;
      }
    };
    window.addEventListener('resize', host.reposition);
    window.addEventListener('scroll', host.reposition, true);
    host.dispose = () => {
      clearInterval(host.healthTimer);
      window.removeEventListener('resize', host.reposition);
      window.removeEventListener('scroll', host.reposition, true);
      host.remove();
    };
    host.refresh = () => {
      if (!host.isConnected) { host.dispose(); return; }
      const now = Date.now();
      for (const [key, item] of host.connections) {
        if (now - item.seen > 10000) host.connections.delete(key);
      }
      const active = [...host.connections.values()];
      const latest = active.sort((a, b) => b.seen - a.seen)[0] || host.lastConnection;
      const health = active.length ? (now - latest.seen <= 5000 ? 'connected' : 'degraded') : 'disconnected';
      const label = { connected: '已连接', degraded: '连接延迟', disconnected: '已断开' }[health];
      pill.dataset.health = health;
      root.querySelector('.label').textContent = `doubao-cli ${label}`;
      if (latest) {
        root.querySelector('.app').textContent = latest.app;
        root.querySelector('.details').textContent = [
          `状态：${label}（${active.length} 个连接）`,
          `配置：${latest.profile}`,
          `CDP：${latest.endpoint}`,
          `CLI：v${latest.version} · PID ${latest.pid}`,
          `最近连接：${new Date(latest.seen).toLocaleTimeString()}`,
        ].join('\n');
      }
      host.reposition();
      if (!active.length) { clearInterval(host.healthTimer); host.healthTimer = null; }
    };
    document.body.appendChild(host);
  }
  if (connected) {
    const item = { ...connection, seen: Date.now() };
    host.connections.set(connection.id, item);
    host.lastConnection = item;
    if (!host.healthTimer) host.healthTimer = setInterval(host.refresh, 1000);
  } else {
    host.connections.delete(connection.id);
  }
  host.refresh();
}

export function badgeVisibilityExpression(enabled) {
  return `(() => {
    window.__doubaoCliBadgeVisible = ${JSON.stringify(enabled)};
    const host = document.getElementById(${JSON.stringify(BADGE_ID)});
    if (!${JSON.stringify(enabled)} && host) {
      if (host.dispose) host.dispose();
      else { clearInterval(host.healthTimer); host.remove(); }
    }
    return true;
  })()`;
}

export function badgeExpression(connection, connected = true) {
  return `(${updateBadge.toString()})(${JSON.stringify(BADGE_ID)}, ${JSON.stringify(connection)}, ${connected})`;
}

// Cosmetic CDP calls have a separate, short deadline and never fail the command.
export async function startConnectionBadge(client, { app, profile, endpoint }, options = {}) {
  const env = options.env || process.env;
  const settingsPath = connectionBadgeSettingsPath(env);
  const readEnabled = options.readEnabled || (() => readConnectionBadgeSettings(settingsPath, env).enabled);
  let lastEnabled;
  const connection = { id: randomUUID(), app, profile, endpoint, version: VERSION, pid: process.pid };
  let stopped = false;
  let pending = false;
  const evaluate = async (connected, visibility) => {
    if (connected && pending) return false;
    if (connected) pending = true;
    let timer;
    try {
      const request = Promise.resolve().then(() => client.send('Runtime.evaluate', {
        expression: visibility === false ? badgeVisibilityExpression(false)
          : `${visibility === true ? badgeVisibilityExpression(true) + ';' : ''}${badgeExpression(connection, connected)}`,
        returnByValue: true,
      })).finally(() => { if (connected) pending = false; });
      return await Promise.race([
        request.then(result => !result?.exceptionDetails),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); }),
      ]);
    } catch { return false; /* Retry after navigation or a renderer error. */ }
    finally { clearTimeout(timer); }
  };
  const heartbeat = async () => {
    if (stopped) return;
    let enabled;
    try { enabled = readEnabled(); } catch { enabled = false; }
    if (enabled) {
      if (await evaluate(true, lastEnabled !== true ? true : undefined)) lastEnabled = true;
    } else if (lastEnabled !== false && await evaluate(true, false)) lastEnabled = false;
  };
  await heartbeat();
  const timer = setInterval(heartbeat, 2000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    let enabled;
    try { enabled = readEnabled(); } catch { enabled = false; }
    if (lastEnabled !== false) await evaluate(false, enabled ? undefined : false);
  };
}
