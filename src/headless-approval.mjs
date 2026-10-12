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
  return `\n[local runtime: ${permission}; ${risk}] Approve ${tool}: ${operation}; cwd ${workspaceLabel}? [y/N] `;
}

/** Create the explicit TTY approval callback used by HeadlessLocalRuntime. */
export function createHeadlessApproval({ input = process.stdin, output = process.stderr,
  interactive = Boolean(input?.isTTY && output?.isTTY), workspace } = {}) {
  return async request => {
    if (!interactive || !input || typeof input.on !== 'function' || typeof output?.write !== 'function') return false;
    if (request?.signal?.aborted) return false;

    output.write(approvalPrompt(request, workspace));
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: Boolean(interactive) });
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
  };
}
