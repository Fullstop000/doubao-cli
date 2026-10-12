import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { headlessWaitArguments, startHeadlessWorker, startHeadlessSubmissionWorker } from '../src/headless-worker.mjs';

const conversationId = '1234567890123456';
const runId = '2345678901234567';

test('builds a profile-scoped wait command without changing its local-selection semantics', () => {
  assert.deepEqual(headlessWaitArguments({ profile: 'team_one', conversationId, runId, timeoutSeconds: 60 }), [
    'headless', '--profile', 'team_one', 'sessions', 'wait', conversationId, '--run', runId, '--timeout', '60', '--json',
  ]);
  assert.throws(() => headlessWaitArguments({ profile: '../escape', conversationId, runId }), /profile/u);
  assert.throws(() => headlessWaitArguments({ profile: 'default', conversationId: 'bad', runId }), /conversation id/u);
  assert.throws(() => headlessWaitArguments({ profile: 'default', conversationId, runId: 'bad' }), /run id/u);
});

test('starts a detached worker with private log and isolated no-auth config', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-worker-'));
  const configDir = path.join(root, 'config');
  const result = await startHeadlessWorker({ profile: 'fixture', conversationId, runId, timeoutSeconds: 1,
    configDir, env: { HOME: root, PATH: process.env.PATH, DOUBAO_HEADLESS_COOKIE: '' } });
  try {
    assert.equal(result.started, true);
    assert.equal(result.profile, 'fixture');
    assert.equal(result.configDir, configDir);
    assert.equal(result.child.stdout, null);
    assert.equal(result.child.stdin, null);
    assert.equal((await fs.stat(result.logPath)).mode & 0o777, 0o600);
    const logStat = await fs.lstat(result.logPath);
    assert.equal(logStat.isSymbolicLink(), false);

    const child = result.child;
    child.ref();
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated fixture worker did not exit')), 10_000);
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(exit.code, 1);
    assert.match(await fs.readFile(result.logPath, 'utf8'), /login is required/u);
    assert.equal(await fs.access(path.join(configDir, 'headless', 'profiles', 'fixture', 'session.json')).then(() => true, () => false), false);
  } finally {
    result.child.kill('SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a symlinked worker log target', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-worker-link-'));
  const target = path.join(root, 'target.log');
  const link = path.join(root, 'link.log');
  await fs.writeFile(target, '');
  await fs.symlink(target, link);
  await assert.rejects(startHeadlessWorker({ profile: 'default', conversationId, runId, configDir: root, logPath: link }), /regular file/u);
  await fs.rm(root, { recursive: true, force: true });
});

test('forwards memory-only cookie auth through the environment, never argv or logs', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-worker-cookie-'));
  const proofPath = path.join(root, 'env-proof.txt');
  const preloadPath = path.join(root, 'preload.mjs');
  const cookie = 'fixture-cookie-that-must-not-be-printed';
  await fs.writeFile(preloadPath, `if (process.argv.includes('--worker')) {\n` +
    `  const fs = await import('node:fs/promises');\n` +
    `  await fs.writeFile(process.env.FIXTURE_COOKIE_PROOF, process.env.DOUBAO_HEADLESS_COOKIE === process.env.FIXTURE_COOKIE_EXPECTED ? 'matched' : 'missing', { mode: 0o600 });\n` +
    `  process.exit(0);\n}\n`, { mode: 0o600 });
  const result = await startHeadlessWorker({ profile: 'memory', conversationId, runId, timeoutSeconds: 1,
    configDir: path.join(root, 'config'), env: { HOME: root, PATH: process.env.PATH,
      DOUBAO_HEADLESS_COOKIE: cookie, FIXTURE_COOKIE_EXPECTED: cookie, FIXTURE_COOKIE_PROOF: proofPath,
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` } });
  try {
    const child = result.child;
    child.ref();
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cookie environment fixture worker did not exit')), 10_000);
      child.once('close', value => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0);
    assert.equal(await fs.readFile(proofPath, 'utf8'), 'matched');
    assert.equal(child.spawnargs.join(' ').includes(cookie), false);
    assert.equal((await fs.readFile(result.logPath, 'utf8')).includes(cookie), false);
  } finally {
    result.child.kill('SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('submission worker returns verified ACK while its detached child continues after IPC disconnect', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-submit-worker-'));
  const workerPath = path.join(root, 'fixture-worker.mjs');
  const proofPath = path.join(root, 'worker-proof.json');
  const cookie = 'fixture-memory-cookie-never-print';
  await fs.writeFile(workerPath, `import fs from 'node:fs/promises';\n` +
    `process.on('message', async message => {\n` +
    `  if (message.type !== 'start') return;\n` +
    `  process.send({ type: 'accepted', result: { platform: 'headless', mode: 'work', conversationId, runId, localMessageId, status: 'running', accepted: true, reply: null } });\n` +
    `  process.on('disconnect', async () => {\n` +
    `    await new Promise(resolve => setTimeout(resolve, 100));\n` +
    `    await fs.writeFile(process.env.FIXTURE_PROOF, JSON.stringify({ aliveAfterDisconnect: true, cookieInherited: process.env.DOUBAO_HEADLESS_COOKIE === process.env.FIXTURE_COOKIE, argvSecretFree: !process.argv.join(' ').includes(process.env.FIXTURE_COOKIE), optionsReceived: message.options.args.join(' ') }), { mode: 0o600 });\n` +
    `    setTimeout(() => process.exit(0), 100);\n` +
    `  });\n` +
    `});\n` +
    `const conversationId = '${conversationId}', runId = '${runId}', localMessageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';\n`, { mode: 0o600 });
  const configDir = path.join(root, 'config');
  const result = await startHeadlessSubmissionWorker({
    options: { args: ['sessions', 'create', 'fixture message'], profile: 'fixture', timeoutMs: 1000 },
    configDir, expectedAccountId: '123456', ackTimeoutMs: 5_000, workerPath,
    env: { HOME: root, PATH: process.env.PATH, DOUBAO_HEADLESS_COOKIE: cookie,
      FIXTURE_COOKIE: cookie, FIXTURE_PROOF: proofPath },
  });
  assert.deepEqual({ accepted: result.accepted, mode: result.mode, conversationId: result.conversationId,
    runId: result.runId, localMessageId: result.localMessageId, status: result.status }, {
    accepted: true, mode: 'work', conversationId, runId,
    localMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'running',
  });
  assert.equal(result.child.connected, false);
  assert.equal(result.child.spawnargs.join(' ').includes(cookie), false);
  assert.equal((await fs.stat(result.logPath)).mode & 0o777, 0o600);
  const deadline = Date.now() + 5_000;
  let proof;
  while (!proof && Date.now() < deadline) {
    try { proof = JSON.parse(await fs.readFile(proofPath, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.deepEqual(proof, { aliveAfterDisconnect: true, cookieInherited: true, argvSecretFree: true,
    optionsReceived: 'sessions create fixture message' });
  assert.equal((await fs.readFile(result.logPath, 'utf8')).includes(cookie), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('submission worker failure before ACK is returned without an accepted result', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-submit-failure-'));
  const workerPath = path.join(root, 'fixture-worker.mjs');
  await fs.writeFile(workerPath, `process.on('message', message => { if (message.type === 'start') process.send({ type: 'failed', code: 'FIXTURE_REJECTED', message: 'fixture failed before ACK', result: { accepted: false, status: 'unknown' } }); });\n`, { mode: 0o600 });
  await assert.rejects(startHeadlessSubmissionWorker({ options: { args: ['sessions', 'send', conversationId, 'fixture'], profile: 'default' },
    configDir: path.join(root, 'config'), workerPath, ackTimeoutMs: 5_000 }), error => {
    assert.equal(error.code, 'FIXTURE_REJECTED');
    assert.equal(error.message, 'fixture failed before ACK');
    assert.deepEqual(error.result, { accepted: false, status: 'unknown' });
    return true;
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('submission ACK timeout kills only the pre-ACK worker and reports unknown acceptance', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-submit-timeout-'));
  const workerPath = path.join(root, 'fixture-worker.mjs');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(workerPath, `process.on('message', () => {});\n`, { mode: 0o600 });
  const originalSpawn = childProcess.spawn;
  let workerPid;
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    workerPid = child.pid;
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(startHeadlessSubmissionWorker({ options: { args: ['sessions', 'create', 'fixture'], profile: 'default' },
      configDir: path.join(root, 'config'), workerPath, ackTimeoutMs: 100 }), error => {
      assert.equal(error.code, 'SUBMISSION_WORKER_ACK_TIMEOUT');
      assert.equal(error.result.accepted, false);
      assert.equal(error.result.status, 'unknown');
      assert.match(error.result.recovery, /inspect session history/u);
      return true;
    });
    assert.ok(Number.isInteger(workerPid), 'spawn should capture the real worker PID');
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(workerPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('submission worker rejects a malformed ACK as unknown acceptance', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-submit-validation-'));
  const workerPath = path.join(root, 'malformed-worker.mjs');
  await fs.writeFile(workerPath, `process.on('message', message => { if (message.type === 'start') process.send({ type: 'accepted', result: { platform: 'headless', mode: 'work', conversationId: 'bad', runId: '${runId}', localMessageId: 'm', status: 'running', accepted: true, reply: null } }); });\n`, { mode: 0o600 });
  await assert.rejects(startHeadlessSubmissionWorker({ options: { args: ['sessions', 'create', 'fixture'] },
    configDir: path.join(root, 'config'), workerPath, ackTimeoutMs: 5_000 }), error => {
    assert.equal(error.code, 'SUBMISSION_WORKER_INVALID_ACK');
    assert.equal(error.result.accepted, false);
    assert.match(error.result.recovery, /inspect session history/u);
    return true;
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('submission worker rejects unsafe options before spawning', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-headless-submit-options-'));
  await assert.rejects(startHeadlessSubmissionWorker({ options: { args: ['status'] }, configDir: root }), /create\/send/u);
  await assert.rejects(startHeadlessSubmissionWorker({ options: { args: ['sessions', 'create', 'hello'] },
    configDir: root, expectedAccountId: 'bad' }), /expected account id/u);
  await fs.rm(root, { recursive: true, force: true });
});
