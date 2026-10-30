import path from 'node:path';
import { createInterface } from 'node:readline/promises';

function visibleText(value, limit = 120) {
  const sanitized = String(value ?? '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return sanitized.length > limit ? `${sanitized.slice(0, limit)}…` : sanitized;
}

function operationSummary(request, workspace) {
  const toolName = request?.toolName;
  let input = request?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? visibleText(input.command, 400) : '';
    return command ? `command: ${command}` : 'shell command';
  }
  if (toolName === 'connector.call') {
    const connector = visibleText(input.connector_id || 'unknown connector', 80);
    const remoteTool = visibleText(input.remote_tool_name || 'unknown tool', 96);
    const args = typeof input.raw_arguments === 'string' && input.raw_arguments
      ? `; args: ${visibleText(input.raw_arguments, 200)}` : '';
    return `connector ${connector} / ${remoteTool}${args}`;
  }
  if (toolName === 'local.workspace.apply') {
    const operation = ['ensure_dir', 'ensure_file', 'write_file'].includes(input.type) ? input.type : 'workspace change';
    const target = typeof input.path === 'string' ? path.basename(input.path) : '';
    return target ? `${operation} (${visibleText(target, 64)})` : operation;
  }
  const resource = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof resource === 'string' && resource) {
    const requested = path.resolve(workspace || process.cwd(), resource);
    const relative = workspace ? path.relative(path.resolve(workspace), requested) : resource;
    const outside = request?.risk === 'outside-workspace' || relative === '..'
      || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (outside) return `resource ${visibleText(requested, 180)}`;
    const basename = path.basename(resource);
    return basename ? `resource ${visibleText(basename, 64)}` : 'resource';
  }
  return 'requested operation';
}

function approvalPrompt(request, workspace) {
  const tool = visibleText(request?.toolName || 'local tool', 48);
  const permission = visibleText(request?.permission || 'restricted', 24);
  const risk = visibleText(request?.risk || 'approval-required', 40);
  const operation = operationSummary(request, workspace);
  const workspaceLabel = workspace ? visibleText(path.resolve(workspace), 240) : 'configured workspace';
  if (request?.risk === 'enable-full-access') {
    return `\n[local runtime: FullAccess] Enable FullAccess for this turn? Commands can read, modify or delete files accessible to this user, inherit environment credentials, and send tool results to Doubao. There is no OS sandbox; cwd ${workspaceLabel}. [y/N] `;
  }
  return `\n[local runtime: ${permission}; ${risk}] Approve ${tool}: ${operation}; cwd ${workspaceLabel}? [y/N] `;
}

// All approval callbacks sharing a terminal must share one reader, including
// callbacks created by separate runtimes and the per-turn FullAccess gate.
const terminalQueues = new Map();
function enqueueApproval(input, signal, ask) {
  const key = input.isTTY && Number.isInteger(input.fd) ? `tty:${input.fd}` : input;
  let queue = terminalQueues.get(key);
  if (!queue) { queue = { active: false, waiting: [] }; terminalQueues.set(key, queue); }
  const drain = () => {
    if (queue.active) return;
    const next = queue.waiting.shift();
    if (!next) { if (terminalQueues.get(key) === queue) terminalQueues.delete(key); return; }
    if (next.signal?.aborted) { next.finish(false); drain(); return; }
    queue.active = true;
    // Start the first prompt synchronously. Queued requests do not attach a
    // readline listener, print anything, or consume input until their turn.
    let response;
    try { response = next.ask(); } catch (error) { response = Promise.reject(error); }
    Promise.resolve(response).then(value => next.finish(value), error => next.finish(undefined, error)).finally(() => {
      queue.active = false;
      drain();
    });
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const item = { signal, ask, finish(value, error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    } };
    const onAbort = () => {
      const index = queue.waiting.indexOf(item);
      if (index !== -1) {
        queue.waiting.splice(index, 1);
        item.finish(false);
        drain();
      }
      // The active reader owns its abort listener and closes before draining.
    };
    queue.waiting.push(item);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    drain();
  });
}

/** FullAccess must be explicitly confirmed in the caller's terminal per turn. */
export async function confirmHeadlessFullAccess(options = {}) {
  return createHeadlessApproval(options)({ permission: 'FullAccess', risk: 'enable-full-access' });
}

/** Create the explicit TTY approval callback used by HeadlessLocalRuntime. */
export function createHeadlessApproval({ input = process.stdin, output = process.stderr,
  interactive = Boolean(input?.isTTY && output?.isTTY), workspace } = {}) {
  return async request => {
    if (!interactive || !input || typeof input.on !== 'function' || typeof output?.write !== 'function') return false;
    if (request?.signal?.aborted) return false;

    return enqueueApproval(input, request?.signal, async () => {
      if (request?.signal?.aborted || input.destroyed || input.readableEnded) return false;
      output.write(approvalPrompt(request, workspace));
      // output is required for raw-TTY echo and newline feedback. Without it,
      // sequential prompts look stacked and typed y/n appears to do nothing.
      const lines = createInterface({ input, output, crlfDelay: Infinity, terminal: Boolean(interactive) });
      let onAbort;
      try {
        return await new Promise(resolve => {
          let settled = false;
          const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          lines.once('line', answer => finish(/^(?:y|yes)$/iu.test(answer.trim())));
          lines.once('close', () => finish(false));
          onAbort = () => finish(false);
          request?.signal?.addEventListener('abort', onAbort, { once: true });
          if (request?.signal?.aborted) finish(false);
        });
      } finally {
        request?.signal?.removeEventListener('abort', onAbort);
        lines.close();
      }
    });
  };
}
