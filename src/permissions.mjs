// Doubao 2.30.1 SandboxAuthType (804013.j4), also used by the native runtime.
const PERMISSIONS = { AlwaysAsk: 0, AskOnRisk: 1, FullAccess: 2 };

export const DEFAULT_HEADLESS_PERMISSION = 'AskOnRisk';

export function resolvePermission(value = 'FullAccess') {
  const normalized = String(value).replace(/[-_]/gu, '').toLowerCase();
  const name = Object.keys(PERMISSIONS).find((key) => key.toLowerCase() === normalized);
  if (!name) throw new Error('unknown permission; expected AlwaysAsk, AskOnRisk, or FullAccess');
  return PERMISSIONS[name];
}

export function taskPermission(explicit, previous, fallback) {
  let value = explicit;
  if (value == null && previous?.runtime_type === 2 && previous.sandbox_auth_type !== undefined) {
    value = Object.keys(PERMISSIONS).find(name => PERMISSIONS[name] === previous.sandbox_auth_type);
    if (!value) throw new Error('Doubao conversation execution context has an invalid permission');
  }
  return Object.keys(PERMISSIONS).find(name => PERMISSIONS[name] === resolvePermission(value ?? fallback));
}
