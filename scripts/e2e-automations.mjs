#!/usr/bin/env node
// Real-account CRUD against an installed candidate. Creates only far-future test jobs.
// Usage: node scripts/e2e-automations.mjs --cli /absolute/bin/doubao.mjs --output /private/path
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { configDirectory } from '../src/config.mjs';

const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const cli = option('--cli'), output = option('--output');
if (!cli || !output) throw new Error('Required: --cli <installed CLI path> --output <private evidence directory>');
const backends = option('--backend') ? [option('--backend')] : ['work', 'headless'];
assert.ok(backends.every(backend => ['work', 'headless'].includes(backend)));
const cliPath = realpathSync(resolve(cli));
const packageRoot = resolve(dirname(cliPath), '..');
const runtimeFiles = [];
function collect(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, item.name);
    if (item.isDirectory()) collect(file);
    else if (item.isFile()) runtimeFiles.push(file);
    else throw new Error('Candidate runtime must not contain symlinks or special files');
  }
}
for (const directory of ['bin', 'src', 'dist']) collect(join(packageRoot, directory));
runtimeFiles.push(join(packageRoot, 'package.json'));
const hash = createHash('sha256');
for (const file of runtimeFiles.sort()) hash.update(relative(packageRoot, file)).update('\0').update(readFileSync(file)).update('\0');
const manifest = { version: 1, cli: cliPath, runtimeSha256: hash.digest('hex'), node: process.version,
  runnerSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  parameters: { backends, output: resolve(output), config: resolve(configDirectory()),
    app: process.env.DOUBAO_APP || null, dataDir: process.env.DOUBAO_DATA_DIR || null, cdp: process.env.DOUBAO_CDP_ENDPOINT || null } };
// In-memory cookie overrides cannot be safely tied to a reusable account/config manifest.
if (process.env.DOUBAO_HEADLESS_COOKIE) throw new Error('Use a saved account config; cookie environment overrides are not supported by this runner');
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
const manifestPath = join(output, 'manifest.json');
if (existsSync(manifestPath)) {
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest,
    'Candidate or invocation changed; use a new output directory, never reuse old evidence');
} else {
  assert.equal(readdirSync(output).length, 0, 'Existing evidence has no manifest; preserve it and use a new output directory');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
}
const statePath = join(output, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { token: randomUUID(), backends: {} };
function save() { writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 }); }
function run(backend, stage, argv, mutation = false) {
  const file = join(output, `${backend}-${stage}.json`);
  const marker = `${file}.started`;
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    if (previous.exitCode !== 0) throw Object.assign(new Error(`${backend}/${stage} previously failed; inspect saved evidence, do not retry automatically`), { result: previous.data });
    console.log(JSON.stringify({ backend, stage, evidence: 'cached' }));
    return previous.data;
  }
  if (mutation && existsSync(marker)) throw new Error(`${backend}/${stage} has an unknown outcome; recover by list/get, never replay`);
  if (mutation) writeFileSync(marker, new Date().toISOString(), { mode: 0o600, flag: 'wx' });
  const prefix = backend === 'work' ? ['--app', 'work'] : ['headless'];
  const result = spawnSync(process.execPath, [cliPath, ...prefix, 'automations', ...argv, '--json', '--timeout', '60'], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' },
  });
  let data; try { data = JSON.parse(result.stdout); } catch { data = null; }
  writeFileSync(file, JSON.stringify({ exitCode: result.status, signal: result.signal, data, stdout: result.stdout, stderr: result.stderr }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ backend, stage, evidence: 'fresh', exitCode: result.status }));
  if (result.status !== 0) throw Object.assign(new Error(`${backend}/${stage} failed; see private evidence`), { result: data });
  return data;
}
const content = job => job?.content?.cron_job;
function assertSchedule(actual, expected) {
  assert.equal(actual.repeat_type, expected.repeat_type);
  assert.equal(Math.floor(Date.parse(actual.execute_at) / 1000), Math.floor(Date.parse(expected.execute_at) / 1000));
}
for (const backend of backends) {
  const record = state.backends[backend] ||= {};
  if (record.complete) { console.log(JSON.stringify({ backend, evidence: 'cached', complete: true })); continue; }
  const title = `CLI E2E ${backend} ${state.token.slice(0, 8)}`;
  // UTC with milliseconds exercises the server's timezone/second normalization.
  const future = new Date(Date.now() + 90 * 86400000).toISOString();
  const inputPath = join(output, `${backend}-input.json`);
  if (!existsSync(inputPath)) writeFileSync(inputPath, JSON.stringify({ title, prompt: 'CLI E2E test. Reply only AUTOMATION_E2E.', timezone: 'Asia/Shanghai', runtime_config: { runtime_type: 1 }, schedule: { repeat_type: 1, execute_at: future } }), { mode: 0o600 });
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const patchPath = join(output, `${backend}-patch.json`);
  const patch = { title: `${title} updated`, prompt: 'CLI E2E updated. Reply only AUTOMATION_UPDATED.',
    schedule: { repeat_type: 1, execute_at: new Date(Date.parse(input.schedule.execute_at) + 86400000).toISOString() } };
  writeFileSync(patchPath, JSON.stringify(patch), { mode: 0o600 });
  try {
    const before = run(backend, 'list-before', ['list']);
    assert.ok(Array.isArray(before.automations));
    const created = run(backend, 'create', ['create', '--file', inputPath], true);
    record.id = created.id; save();
    assert.equal(created.verified, true);
    assert.ok(record.id);
    assert.ok(!before.automations.some(job => job.id === record.id));
    const got = run(backend, 'get-created', ['get', record.id]).automation;
    assert.equal(got.title, title);
    assertSchedule(content(got).schedule_config, input.schedule);
    const listed = run(backend, 'list-created', ['list']).automations;
    assert.equal(listed.filter(job => job.id === record.id && job.title === title).length, 1);
    const updated = run(backend, 'update', ['update', record.id, '--file', patchPath], true);
    assert.equal(updated.verified, true);
    const patched = run(backend, 'get-updated', ['get', record.id]).automation;
    assert.equal(patched.title, `${title} updated`);
    assert.equal(patched.prompt, 'CLI E2E updated. Reply only AUTOMATION_UPDATED.');
    assertSchedule(content(patched).schedule_config, patch.schedule);
    record.crudValidated = true; save();
  } catch (error) {
    record.failure = error.message;
    record.id ||= error.result?.id || error.result?.result?.id;
    // A failed readback may follow successful creation. Read-only recovery by the unique title.
    if (!record.id) {
      try {
        const candidates = run(backend, 'recover-list', ['list']).automations.filter(job => job.title === title);
        if (candidates.length === 1) record.id = candidates[0].id;
      } catch { record.recoveryFailed = true; }
    }
    save();
  } finally {
    if (record.id && !record.cleaned) {
      try {
        const deleted = run(backend, 'delete', ['delete', record.id], true);
        assert.equal(deleted.deleted, true); assert.equal(deleted.verified, true);
        const after = run(backend, 'list-after', ['list']);
        assert.ok(!after.automations.some(job => job.id === record.id));
        const gone = run(backend, 'get-deleted', ['get', record.id]).automation;
        assert.ok(!gone || content(gone).status === 4);
        record.cleaned = true;
      } catch (error) { record.cleanupFailure = error.message; }
    }
    record.complete = Boolean(record.crudValidated && record.cleaned);
    save();
  }
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(state.backends).map(([key, value]) => [key, { complete: value.complete, cleaned: value.cleaned || false, failure: value.failure, cleanupFailure: value.cleanupFailure }]))));
if (Object.values(state.backends).some(value => !value.complete)) process.exitCode = 1;
