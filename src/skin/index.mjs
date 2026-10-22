import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeProfile, resolvePlatform, withApp } from '../app.mjs';
import { readSkinSettings, setSkinEnabled } from './settings.mjs';

const isDesktop = app => ['doubao', 'work'].includes(app.id);
const unavailable = error => ({ state: 'unavailable', error: error.message });
function isLocalDesktop(app) {
  if (!isDesktop(app)) return false;
  try {
    const endpoint = new URL(app.endpoint);
    return endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  } catch { return false; }
}

export function findSkinRoot(app, env = process.env) {
  if (env.DOUBAO_SKIN_ROOT) return path.resolve(env.DOUBAO_SKIN_ROOT);
  if (!isDesktop(app)) return null;
  const workspace = path.join(app.dataDir, activeProfile(app), `.${app.scheme}`, 'agent_mode', 'workspace');
  return ['.user_skills', '.skills']
    .map(folder => path.join(workspace, folder, 'doubao-skin'))
    .find(root => fs.existsSync(path.join(root, 'SKILL.md'))) || null;
}

// Cosmetic work gets its own short budget. Late imports/file reads must not
// inject after the caller has timed out or closed the shared CDP connection.
async function bounded(operation, timeoutMs) {
  let active = true;
  let timer;
  try {
    return await Promise.race([
      operation(() => active),
      new Promise(resolve => {
        timer = setTimeout(() => {
          active = false;
          resolve(unavailable(new Error('skin refresh timed out')));
        }, timeoutMs);
      }),
    ]);
  } catch (error) { return unavailable(error); }
  finally { active = false; clearTimeout(timer); }
}

async function syncSkin(client, app, env, isActive) {
  if (!isLocalDesktop(app)) return { state: 'unsupported' };
  const { enabled } = readSkinSettings(env);
  const root = findSkinRoot(app, env);
  if (!root) return { state: 'not-installed' };
  const entry = path.join(root, 'src', 'integration.mjs');
  if (!fs.existsSync(entry)) return { state: 'update-required' };
  const skin = await import(pathToFileURL(entry).href);
  const evaluate = async expression => {
    if (!isActive()) throw new Error('skin refresh timed out');
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, timeout: 500 });
    if (result?.exceptionDetails) throw new Error('skin script failed');
    return result?.result?.value;
  };
  if (!enabled) {
    await evaluate(skin.REMOVE_SKIN_SCRIPT);
    return { state: 'disabled' };
  }
  if (await evaluate(skin.INSTALLED_SKIN_SCRIPT)) return { state: 'already-applied' };
  const script = await skin.buildApplyScript();
  if (!readSkinSettings(env).enabled) return { state: 'disabled' };
  const applied = await evaluate(script);
  return applied === true ? { state: 'applied' } : unavailable(new Error('skin was not applied'));
}

export function applyDesktopSkin(client, app, { env = process.env, timeoutMs = 750 } = {}) {
  return bounded(isActive => syncSkin(client, app, env, isActive), timeoutMs);
}

// Only explicit on/off commands open a connection. Automatic application uses
// the caller's existing connection and never launches or restarts the app.
export async function refreshDesktopSkin(app, { env = process.env, timeoutMs = 1500 } = {}) {
  if (!isLocalDesktop(app)) return { state: 'unsupported' };
  let client;
  try {
    return await bounded(async isActive => {
      const { findChatTarget, CdpClient } = await import('../cdp.mjs');
      return withApp(app, async () => {
        const target = await findChatTarget(app.endpoint, 500);
        if (!isActive()) throw new Error('skin refresh timed out');
        client = new CdpClient(target.webSocketDebuggerUrl);
        await client.connect();
        if (!isActive()) throw new Error('skin refresh timed out');
        return syncSkin(client, app, env, isActive);
      });
    }, timeoutMs);
  } finally { client?.close(); }
}

export async function runSkinCommand(options) {
  const action = options.args[1] || 'status';
  const settings = action === 'status' ? readSkinSettings() : setSkinEnabled(action === 'on');
  const app = resolvePlatform(options.platform || options.app || (process.platform === 'linux' ? 'headless' : undefined));
  const skillRoot = findSkinRoot(app);
  const compatible = Boolean(skillRoot && fs.existsSync(path.join(skillRoot, 'src', 'integration.mjs')));
  const refresh = action === 'status' ? null : await refreshDesktopSkin(app);
  const result = { ...settings, skillRoot, compatible, refresh };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`skin\t${settings.enabled ? 'on' : 'off'}`);
    console.log(`skill\t${skillRoot || 'not installed'}`);
    if (skillRoot && !compatible) console.log('integration\tupdate doubao-skin to enable CLI integration');
    if (refresh) console.log(`display\t${refresh.state}`);
  }
  return result;
}
