import fs from 'node:fs/promises';
import path from 'node:path';

// Native worker routing Event records are written to saman_frontend logs.
// The separate saman log contains C++ diagnostics, not this event contract.
// No renderer AB value or old app-wide routing observation is sufficient here.
const MAX_FILES = 8;
const MAX_BYTES = 256 * 1024;
const MAX_LINE = 64 * 1024;
const FILE = /^saman_frontend_(\d{4})\.(\d{4})\.\d+\.log$/u;
const ROW = /^\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{1,6}):INFO:FRONTEND\(\d+\)\] \[neotix\] "Event: ([a-z0-9_]+) (\{.*\})", source:.*$/u;

function timestamp(line, year) {
  const m = /^\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{1,6}):/u.exec(line);
  if (!m) return null;
  const [, month, day, hour, minute, second, fraction] = m;
  const at = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0').slice(0, 3)));
  if (at.getMonth() !== Number(month) - 1 || at.getDate() !== Number(day)
    || at.getHours() !== Number(hour) || at.getMinutes() !== Number(minute) || at.getSeconds() !== Number(second)) return null;
  return at.getTime();
}

function row(line, year) {
  if (line.length > MAX_LINE) return null;
  const m = ROW.exec(line), at = timestamp(line, year);
  if (!m || at === null) return null;
  const event = m[7], json = m[8];
  try {
    const meta = JSON.parse(json);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    return { at, event, meta, worker: line.slice(1, line.indexOf(':')) };
  } catch { return null; }
}

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
function sandbox(meta) {
  const values = [meta.sandbox_id, meta.sandboxId].filter(value => value !== undefined);
  return values.length && values.every(text) && values.every(value => value === values[0]) ? values[0] : null;
}

/** Read-only, bounded, per-turn evidence probe. It never returns identifiers. */
export function nativeDeliveryProbe({ dataDir, sandboxId, startedAt } = {}) {
  const since = startedAt instanceof Date ? startedAt.getTime() : startedAt;
  const valid = typeof dataDir === 'string' && path.isAbsolute(dataDir) && text(sandboxId) && Number.isFinite(since);
  const seen = new Set();
  let conflicted = false;
  const sizes = new Map();
  return async function detect() {
    if (!valid || conflicted) return null;
    try {
      const folder = path.join(dataDir, 'sdk_storage', 'log');
      const entries = await fs.readdir(folder, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        const match = FILE.exec(entry.name);
        if (!match) continue;
        // Refuse symlinks instead of reading files outside the selected app.
        if (entry.isSymbolicLink()) return null;
        if (!entry.isFile()) continue;
        const file = path.join(folder, entry.name);
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= since) candidates.push({ file, stat, year: Number(match[1]) });
      }
      if (!candidates.length || candidates.length > MAX_FILES) return null;
      const rows = [];
      for (const { file, stat, year } of candidates) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (sizes.has(identity) && stat.size < sizes.get(identity)) return null;
        sizes.set(identity, stat.size);
        const start = Math.max(0, stat.size - MAX_BYTES);
        const handle = await fs.open(file, 'r');
        let buffer;
        try {
          const before = await handle.stat();
          if (before.dev !== stat.dev || before.ino !== stat.ino || before.size < stat.size) return null;
          buffer = Buffer.alloc(stat.size - start);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          const after = await handle.stat();
          if (bytesRead !== buffer.length || after.size < stat.size || after.ino !== stat.ino) return null;
        } finally { await handle.close(); }
        let data = buffer.toString('utf8');
        // Never interpret a cut-off prefix or an unfinished writer's last line.
        if (start) {
          const firstNewline = data.indexOf('\n');
          if (firstNewline < 0) return null;
          data = data.slice(firstNewline + 1);
        }
        if (data && !data.endsWith('\n')) return null;
        const lines = data.split('\n').filter(Boolean);
        const parsed = lines.map(line => row(line.replace(/\r$/u, ''), year));
        // If the bounded window starts after the task, evidence was lost: do not
        // infer absence of a conflicting route from an incomplete log window.
        const firstAt = lines.length ? timestamp(lines[0], year) : null;
        if (start && (firstAt === null || firstAt >= since)) return null;
        for (const record of parsed) if (record && record.at >= since) rows.push(record);
      }
      const bindings = new Map();
      for (const { event, meta, worker } of rows) {
        if (event !== 'multi_env_command_received' || !text(meta.commandID)) continue;
        const sid = sandbox(meta);
        if (!sid) continue;
        const key = `${worker}:${meta.commandID}`;
        if (!bindings.has(key)) bindings.set(key, new Set());
        bindings.get(key).add(sid);
      }
      for (const { event, meta, worker } of rows) {
        if (!['dispatcher', 'sse'].includes(meta.delivery)) continue;
        const sid = sandbox(meta);
        if (/^(?:local_file_|sandbox_sse_|multi_env_)/u.test(event) && sid === sandboxId) seen.add(meta.delivery);
        if (event !== 'multi_env_queue_lifecycle' || !text(meta.commandID)) continue;
        const bound = bindings.get(`${worker}:${meta.commandID}`);
        if (bound?.has(sandboxId)) {
          if (bound.size !== 1 || (sid && sid !== sandboxId)) { conflicted = true; return null; }
          seen.add(meta.delivery);
        }
      }
      if (seen.size > 1) conflicted = true;
      return seen.size === 1 ? [...seen][0] : null;
    } catch { return null; }
  };
}
