import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDirectory } from './config.mjs';
import { validateHeadlessProfileName } from './headless-state.mjs';

const ID = /^[1-9]\d{11,23}$/u;
const WORKER_FILE = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_SECONDS = 86_400;
const HARD_STOP_GRACE_SECONDS = 60;
const SUBMISSION_ACK_TIMEOUT_MS = 120_000;

function validateId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${label} must contain 12 to 24 digits`);
  return value;
}

function validateAccountId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{5,24}$/u.test(value)) throw new TypeError('expected account id must contain 6 to 25 digits');
  return value;
}

function validateInvocation({ profile = 'default', conversationId, runId, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = {}) {
  return {
    profile: validateHeadlessProfileName(profile),
    conversationId: validateId(conversationId, 'conversation id'),
    runId: validateId(runId, 'run id'),
    timeoutSeconds: Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= DEFAULT_TIMEOUT_SECONDS
      ? timeoutSeconds : (() => { throw new TypeError(`timeoutSeconds must be an integer from 1 to ${DEFAULT_TIMEOUT_SECONDS}`); })(),
  };
}

export function headlessWaitArguments(options = {}) {
  const value = validateInvocation(options);
  return ['headless', '--profile', value.profile, 'sessions', 'wait', value.conversationId,
    '--run', value.runId, '--timeout', String(value.timeoutSeconds), '--json'];
}

function workerArguments(options) {
  const value = validateInvocation(options);
  return [WORKER_FILE, '--worker', '--profile', value.profile, '--conversation', value.conversationId,
    '--run', value.runId, '--timeout', String(value.timeoutSeconds)];
}

function parseWorkerArguments(args) {
  if (args[0] !== '--worker') throw new Error('headless worker entry requires --worker');
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--profile', '--conversation', '--run', '--timeout'].includes(key) || value === undefined || values[key]) {
      throw new Error('headless worker arguments are invalid');
    }
    values[key] = value;
  }
  const timeoutSeconds = Number(values['--timeout']);
  return validateInvocation({ profile: values['--profile'], conversationId: values['--conversation'], runId: values['--run'], timeoutSeconds });
}

async function preparePrivateLog(logPath) {
  const absolute = path.resolve(logPath);
  const parent = path.dirname(absolute);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) throw new Error('Headless worker log directory resolves through a symlink');
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Headless worker log path must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fs.open(absolute, flags, 0o600);
  try { await handle.chmod(0o600); }
  catch (error) { await handle.close(); throw error; }
  return { absolute, handle };
}

export async function startHeadlessWorker({ profile = 'default', conversationId, runId,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, configDir = configDirectory(), logPath, env = process.env } = {}) {
  const value = validateInvocation({ profile, conversationId, runId, timeoutSeconds });
  const resolvedConfigDir = path.resolve(configDir);
  const workerLogPath = logPath || path.join(resolvedConfigDir, 'headless', 'workers',
    `${value.profile}-${value.conversationId}-${value.runId}.log`);
  const { absolute: resolvedLogPath, handle } = await preparePrivateLog(workerLogPath);
  const childEnv = { ...env, DOUBAO_CLI_CONFIG_DIR: resolvedConfigDir, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' };
  let child;
  try {
    child = spawn(process.execPath, workerArguments(value), {
      cwd: path.dirname(WORKER_FILE), env: childEnv, detached: true,
      stdio: ['ignore', 'ignore', handle.fd], windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return { started: true, pid: child.pid, profile: value.profile, conversationId: value.conversationId,
    runId: value.runId, timeoutSeconds: value.timeoutSeconds, configDir: resolvedConfigDir, logPath: resolvedLogPath, child };
}

function serializeMessage(value, maxLength = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, maxLength);
}

function serializeSubmissionResult(value) {
  if (!value || typeof value !== 'object' || value.platform !== 'headless'
    || !['chat', 'work', 'goal'].includes(value.mode) || value.accepted !== true
    || value.status !== 'running' || value.reply !== null) return null;
  try {
    return {
      platform: 'headless', mode: value.mode,
      ...(value.mode === 'goal' && typeof value.goalId === 'string' && /^[\w-]{1,128}$/u.test(value.goalId) ? { goalId: value.goalId } : {}),
      conversationId: validateId(value.conversationId, 'conversation id'),
      runId: validateId(value.runId, 'run id'),
      localMessageId: typeof value.localMessageId === 'string' && value.localMessageId.length > 0
        && value.localMessageId.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value.localMessageId)
        ? value.localMessageId : (() => { throw new TypeError('local message id is invalid'); })(),
      status: 'running', accepted: true, reply: null,
    };
  } catch { return null; }
}

function plainJsonOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('submission options must be an object');
  const parsed = JSON.parse(JSON.stringify(options));
  if (!Array.isArray(parsed.args) || parsed.args[0] !== 'sessions' || !['create', 'send'].includes(parsed.args[1])) {
    throw new TypeError('submission worker requires a headless sessions create/send command');
  }
  return parsed;
}

function waitForChildClose(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    let timer;
    const done = () => { clearTimeout(timer); child.removeListener('close', done); resolve(); };
    child.once('close', done);
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

async function terminateBeforeAck(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {}
  await waitForChildClose(child, 500);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
    await waitForChildClose(child, 500);
  }
}

/** Run a local-capable submission in a detached process that owns both completion and SSE. */
export async function startHeadlessSubmissionWorker({ options, configDir = configDirectory(), expectedAccountId,
  ackTimeoutMs = SUBMISSION_ACK_TIMEOUT_MS, logPath, env = process.env, workerPath = WORKER_FILE, fullAccessConfirmed = false } = {}) {
  const safeOptions = plainJsonOptions(options);
  const expected = expectedAccountId == null ? undefined : validateAccountId(String(expectedAccountId));
  if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 2_147_000_000) {
    throw new TypeError('ackTimeoutMs must be between 1 and 2147000000');
  }
  const resolvedConfigDir = path.resolve(configDir);
  const resolvedWorkerPath = path.resolve(workerPath);
  const workerLogPath = logPath || path.join(resolvedConfigDir, 'headless', 'workers', 'submission.log');
  const { absolute: resolvedLogPath, handle } = await preparePrivateLog(workerLogPath);
  const childEnv = { ...env, DOUBAO_CLI_CONFIG_DIR: resolvedConfigDir, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' };
  let child;
  try {
    child = spawn(process.execPath, [resolvedWorkerPath, '--submit-worker'], {
      cwd: path.dirname(WORKER_FILE), env: childEnv, detached: true,
      stdio: ['ignore', 'ignore', handle.fd, 'ipc'], windowsHide: true,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
  let earlyError = null;
  let earlyClose = null;
  const onEarlyError = error => { earlyError = error; };
  const onEarlyClose = (code, signal) => { earlyClose = { code, signal }; };
  child.once('error', onEarlyError);
  child.once('close', onEarlyClose);
  await handle.close();

  let accepted = false;
  let settled = false;
  let timeout;
  const outcome = new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.removeListener('error', onEarlyError);
      child.removeListener('close', onEarlyClose);
    };
    const fail = error => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onMessage = message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'accepted') {
        const result = serializeSubmissionResult(message.result);
        if (!result) {
          const error = Object.assign(new Error('Submission worker returned a malformed acceptance receipt'), {
            code: 'SUBMISSION_WORKER_INVALID_ACK',
            result: { platform: 'headless', accepted: false, status: 'unknown', reply: null,
              recovery: 'Acceptance is unknown; inspect session history before retrying' },
          });
          fail(error);
          void terminateBeforeAck(child);
          return;
        }
        accepted = true;
        settled = true;
        cleanup();
        try { child.disconnect(); } catch {}
        child.unref();
        resolve({ ...result, pid: child.pid, configDir: resolvedConfigDir, logPath: resolvedLogPath, child });
      } else if (message.type === 'failed') {
        const code = typeof message.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(message.code) ? message.code : 'SUBMISSION_WORKER_FAILED';
        const error = Object.assign(new Error(serializeMessage(message.message || 'Headless submission failed')), { code });
        if (message.result && typeof message.result === 'object') error.result = message.result;
        fail(error);
        try { child.disconnect(); } catch {}
        void terminateBeforeAck(child);
      }
    };
    const onError = error => fail(Object.assign(new Error('Headless submission worker could not start'), { code: 'SUBMISSION_WORKER_START_FAILED', cause: error }));
    const onClose = (code, signal) => {
      if (!accepted) fail(Object.assign(new Error(`Headless submission worker exited before acceptance (${signal || code})`), { code: 'SUBMISSION_WORKER_EXITED' }));
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('close', onClose);
    timeout = setTimeout(() => {
      const error = Object.assign(new Error('Timed out waiting for a verified acceptance receipt; inspect session history before retrying'), {
        code: 'SUBMISSION_WORKER_ACK_TIMEOUT',
        result: { platform: 'headless', accepted: false, status: 'unknown', reply: null,
          recovery: 'Acceptance is unknown; inspect session history before retrying' },
      });
      fail(error);
      void terminateBeforeAck(child);
    }, ackTimeoutMs);
    if (earlyError) { onError(earlyError); return; }
    if (earlyClose) { onClose(earlyClose.code, earlyClose.signal); return; }
    if (!child.connected) {
      fail(Object.assign(new Error('Headless submission worker has no IPC channel'), { code: 'SUBMISSION_WORKER_IPC_FAILED' }));
      void terminateBeforeAck(child);
      return;
    }
    child.send({ type: 'start', options: safeOptions, expectedAccountId: expected, fullAccessConfirmed: fullAccessConfirmed === true }, error => {
      if (error) {
        fail(Object.assign(new Error('Could not send headless submission to worker'), { code: 'SUBMISSION_WORKER_IPC_FAILED', cause: error }));
        void terminateBeforeAck(child);
      }
    });
  });
  return outcome;
}

async function runWorker(args) {
  const value = parseWorkerArguments(args);
  const timer = setTimeout(() => {
    process.stderr.write('Headless wait worker exceeded its bounded deadline.\n');
    process.exit(1);
  }, (value.timeoutSeconds + HARD_STOP_GRACE_SECONDS) * 1000);
  try {
    const { main } = await import('./cli.mjs');
    await main(headlessWaitArguments(value));
  } catch (error) {
    process.stderr.write(`Headless wait worker failed: ${error.message || error}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

async function runSubmissionWorker() {
  let completed = false;
  const fail = async (error, code = 'SUBMISSION_WORKER_FAILED') => {
    if (completed) {
      process.stderr.write(`Headless submission worker failed after acceptance (${code}).\n`);
      process.exitCode = 1;
      return;
    }
    completed = true;
    const result = error?.result && typeof error.result === 'object' ? error.result : undefined;
    const message = serializeMessage(error?.message || 'Headless submission failed');
    if (process.connected) process.send({ type: 'failed', code, message, ...(result ? { result } : {}) });
    process.exitCode = 1;
  };
  process.on('message', async message => {
    if (completed || !message || message.type !== 'start') return;
    let options;
    try {
      options = plainJsonOptions(message.options);
      options.wait = true;
      options.backgroundWorker = true;
      options.expectedAccountId = message.expectedAccountId;
      options.timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;
      const { executeHeadless } = await import('./headless.mjs');
      const { resolvePlatform, withApp } = await import('./app.mjs');
      options.onAccepted = result => {
        if (completed) return;
        const safeResult = serializeSubmissionResult(result);
        if (!safeResult) throw new Error('Headless submission acceptance receipt was invalid');
        completed = true;
        if (process.connected) process.send({ type: 'accepted', result: safeResult });
      };
      await withApp(resolvePlatform('headless'), () => executeHeadless(options, { fullAccessConfirmed: message.fullAccessConfirmed === true }));
      if (!completed) await fail(Object.assign(new Error('Headless submission ended before a verified acceptance receipt'), { code: 'SUBMISSION_WORKER_NO_ACK' }), 'SUBMISSION_WORKER_NO_ACK');
    } catch (error) {
      await fail(error, typeof error?.code === 'string' ? error.code : 'SUBMISSION_WORKER_FAILED');
    }
  });
  process.on('disconnect', () => {
    // The parent disconnects only after ACK. The submission continues independently.
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === WORKER_FILE) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--submit-worker') await runSubmissionWorker();
  else await runWorker(args);
}
