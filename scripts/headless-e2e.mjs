#!/usr/bin/env node
// Opt-in live acceptance for the direct Headless backend. This runner uses
// synthetic conversations and private per-run files in an operator-provided
// isolated config directory. It never reads credential files or emits raw CLI
// output, prompts, fixture markers, or MCP environment values to its receipts.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { configDirectory } from '../src/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CLI = path.join(ROOT, 'bin', 'doubao.mjs');
const MCP_FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'headless-mcp-server.mjs');
const PROCESS_TIMEOUT_MS = 330_000;
const TERM_GRACE_MS = 5_000;
const CLI_TIMEOUT_SECONDS = 300;
const STAGES = new Set(['attachments', 'local', 'mcp', 'background', 'baseline', 'all']);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--cli', '--config', '--output', '--stage'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    const key = arg.slice(2);
    if (options[key] !== undefined) throw new Error(`${arg} may be provided only once`);
    options[key] = value;
  }
  options.stage ||= 'all';
  if (!options.config) throw new Error('--config is required and must point to an isolated Headless config directory with an existing login');
  if (!STAGES.has(options.stage)) throw new Error('--stage must be attachments, local, mcp, background, baseline, or all');
  if (!path.isAbsolute(options.config)) throw new Error('--config must be an absolute path');
  return options;
}

function mkdirPrivate(directory) {
  let existed = false;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`output path must be a regular directory: ${directory}`);
    existed = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) fs.chmodSync(directory, 0o700);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertIsolatedConfig(configDir) {
  const supplied = path.resolve(configDir);
  const normal = path.resolve(configDirectory());
  let suppliedReal = supplied, normalReal = normal;
  try { suppliedReal = fs.realpathSync(supplied); } catch {}
  try { normalReal = fs.realpathSync(normal); } catch {}
  if (suppliedReal === normalReal || supplied === normal) {
    throw new Error('--config resolves to the current default CLI config directory; provide a separate isolated copy with its own existing login');
  }
  const standardUserDirs = [
    path.join(os.homedir(), 'Library', 'Application Support', 'doubao-cli'),
    path.join(os.homedir(), '.config', 'doubao-cli'),
  ];
  for (const standard of standardUserDirs) {
    let standardReal = path.resolve(standard);
    try { standardReal = fs.realpathSync(standard); } catch {}
    if (supplied === path.resolve(standard) || suppliedReal === standardReal) {
      throw new Error('--config must not be the standard user Doubao CLI config directory');
    }
  }
  const suppliedStat = fs.lstatSync(supplied);
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()) throw new Error('--config must be an existing, non-symlink directory');
  return suppliedReal;
}

function safeArgv(argv) {
  const messagePositions = new Set();
  const sessionIndex = argv.indexOf('sessions');
  const operation = sessionIndex >= 0 ? argv[sessionIndex + 1] : '';
  if (operation === 'create') messagePositions.add(sessionIndex + 2);
  if (operation === 'send') messagePositions.add(sessionIndex + 3);
  return argv.map((value, index) => {
    if (messagePositions.has(index)) return '<message>';
    const previous = argv[index - 1];
    if (previous === '--env') return `${String(value).split('=', 1)[0]}=<redacted>`;
    if (['--attach', '--workspace', '--reply-schema', '--command', '--arg'].includes(previous)) return '<path-or-value>';
    return value;
  });
}

function genericDataSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const summary = {};
  for (const key of ['platform', 'loggedIn', 'accepted', 'selected', 'changed', 'verified', 'removed',
    'serverInactive', 'ownedLocalConfigurationRemoved', 'browserRequired', 'appRequired', 'replyValid',
    'conversationId', 'runId', 'status', 'stopped', 'started', 'mode']) {
    if (data[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof data[key])) summary[key] = data[key];
  }
  if (data.reply && typeof data.reply === 'object') summary.replyPresent = typeof data.reply.text === 'string';
  if (Array.isArray(data.sessions)) summary.sessionCount = data.sessions.length;
  if (Array.isArray(data.models)) summary.modelCount = data.models.length;
  if (Array.isArray(data.profiles)) summary.profileCount = data.profiles.length;
  if (Array.isArray(data.connectors)) summary.connectorCount = data.connectors.length;
  return summary;
}

const markerHash = marker => createHash('sha256').update(marker).digest('hex');

function pngChunk(type, body) {
  const data = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, checksum]);
}

function writeBluePng(file) {
  const width = 64, height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) pixels[row * (width * 3 + 1) + 1 + column * 3 + 2] = 255;
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png, { mode: 0o600, flag: 'wx' });
}

function writeSchema(file, properties) {
  fs.writeFileSync(file, JSON.stringify({
    type: 'object', required: Object.keys(properties), properties,
  }), { mode: 0o600, flag: 'wx' });
}

function responseObject(data) {
  const text = data?.reply?.text;
  if (typeof text !== 'string') throw new Error('completed task had no reply text');
  try { return JSON.parse(text); }
  catch { throw new Error('reply was not a JSON object'); }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const configDir = assertIsolatedConfig(options.config);
  const cliPath = path.resolve(options.cli || DEFAULT_CLI);
  const cliStat = fs.statSync(cliPath);
  if (!cliStat.isFile()) throw new Error('--cli must point to a JavaScript entry or executable CLI');
  const useNodeLauncher = ['.js', '.mjs', '.cjs'].includes(path.extname(cliPath));
  if (!useNodeLauncher && (process.platform === 'win32' ? false : (cliStat.mode & 0o111) === 0)) {
    throw new Error('--cli executable is not marked executable');
  }
  const outputRoot = path.resolve(options.output || path.join(os.tmpdir(), 'doubao-headless-e2e'));
  if (isWithin(configDir, outputRoot) || isWithin(outputRoot, configDir)) {
    throw new Error('--output and --config must be separate directories');
  }
  mkdirPrivate(outputRoot);
  const outputRootReal = fs.realpathSync(outputRoot);
  if (isWithin(configDir, outputRootReal) || isWithin(outputRootReal, configDir)) {
    throw new Error('--output and --config must resolve to separate directories');
  }
  const runDir = path.join(outputRootReal, `run-${randomUUID()}`);
  mkdirPrivate(runDir);
  const fixtureDir = path.join(runDir, 'fixtures');
  mkdirPrivate(fixtureDir);
  const workspaceRoot = path.join(runDir, 'workspaces');
  mkdirPrivate(workspaceRoot);

  const receipt = { version: 1, stage: options.stage, startedAt: new Date().toISOString(), steps: [] };
  const receiptPath = path.join(runDir, 'receipt.json');
  const saveReceipt = () => {
    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, receiptPath);
  };
  saveReceipt();
  const childEnv = { ...process.env,
    DOUBAO_CLI_CONFIG_DIR: configDir,
    DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1',
  };
  delete childEnv.DOUBAO_HEADLESS_COOKIE;
  const acceptedTurns = new Map();
  let activeStage = 'setup';

  function turnKey(ids) { return `${ids.conversationId}:${ids.runId}`; }

  function forgetAcceptedTurn(ids) {
    const key = turnKey(ids);
    for (const turns of acceptedTurns.values()) turns.delete(key);
  }

  function rememberAcceptedTurn(stage, ids) {
    if (!acceptedTurns.has(stage)) acceptedTurns.set(stage, new Map());
    acceptedTurns.get(stage).set(turnKey(ids), ids);
  }

  async function execute(name, args) {
    const argv = [...args, '--json'];
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const command = useNodeLauncher ? process.execPath : cliPath;
      const commandArgs = useNodeLauncher ? [cliPath, ...argv] : argv;
      const child = spawn(command, commandArgs, {
        cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', timedOut = false, settled = false;
      const finish = (code, signal, spawnError) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(killDeadline);
        if (spawnError) reject(spawnError);
        else {
          let data = null;
          try { data = JSON.parse(stdout); } catch {}
          resolve({ code, signal, timedOut, data, jsonParsed: data !== null, stderrPresent: stderr.length > 0,
            stdoutLength: Buffer.byteLength(stdout), durationMs: Date.now() - started, rawError: stderr });
        }
      };
      child.stdout.on('data', chunk => {
        if (stdout.length < 2_000_000) stdout += chunk.toString('utf8').slice(0, 2_000_000 - stdout.length);
        else { child.kill('SIGTERM'); }
      });
      child.stderr.on('data', chunk => {
        // Retain bytes only in memory for the optional timeout ID recovery path.
        if (stderr.length < 64_000) stderr += chunk.toString('utf8').slice(0, 64_000 - stderr.length);
      });
      child.once('error', error => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
      const deadline = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killDeadline = setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS);
      }, PROCESS_TIMEOUT_MS);
      let killDeadline;
    });
    const row = { name, command: argv.slice(0, 3), safeArgv: safeArgv(argv), exitCode: result.code,
      signal: result.signal, timedOut: result.timedOut, jsonParsed: result.jsonParsed,
      stderrPresent: result.stderrPresent, durationMs: result.durationMs,
      ...(result.jsonParsed ? { data: genericDataSummary(result.data) } : {}) };
    receipt.steps.push(row);
    saveReceipt();
    const ids = idsFrom(result);
    if (ids && result.data && ['completed', 'failed', 'cancelled'].includes(result.data.status)) {
      forgetAcceptedTurn(ids);
    } else if (ids && argv.includes('sessions') && ['create', 'send'].includes(argv[argv.indexOf('sessions') + 1])) {
      const accepted = result.data?.accepted === true && ['running', 'unknown', 'waiting_input'].includes(result.data?.status)
        || /request was accepted|accepted.*sessions wait|sessions wait.*same IDs/iu.test(result.rawError || '');
      if (accepted) rememberAcceptedTurn(activeStage, ids);
    }
    return result;
  }

  function requireOkay(name, result) {
    if (result.timedOut) throw new Error(`${name}: CLI process exceeded its 330-second deadline`);
    if (result.code !== 0 || !result.jsonParsed) throw new Error(`${name}: expected successful JSON output (exit ${result.code})`);
    return result.data;
  }

  async function jsonStep(name, args) {
    return requireOkay(name, await execute(name, args));
  }

  async function waitForTurn(name, conversationId, runId, schemaFile) {
    const args = ['headless', 'sessions', 'wait', conversationId, '--run', runId,
      '--timeout', String(CLI_TIMEOUT_SECONDS), '--expect-json', '--reply-schema', schemaFile];
    return execute(name, args);
  }

  async function cancelOwnedTurns(stage = undefined) {
    const entries = stage === undefined
      ? [...acceptedTurns.entries()].flatMap(([owner, turns]) => [...turns.values()].map(ids => [owner, ids]))
      : [...(acceptedTurns.get(stage)?.values() || [])].map(ids => [stage, ids]);
    const failures = [];
    for (const [owner, ids] of entries) {
      try {
        const status = await jsonStep(`${owner}: cleanup status for owned run`, [
          'headless', 'sessions', 'status', ids.conversationId, '--run', ids.runId,
        ]);
        if (['completed', 'failed', 'cancelled'].includes(status.status)) {
          forgetAcceptedTurn(ids);
          receipt.steps.push({ name: `${owner}: owned run already terminal`, ...ids, status: status.status });
          saveReceipt();
          continue;
        }
        if (!['running', 'unknown', 'waiting_input'].includes(status.status)) throw new Error(`${owner}: could not verify owned run state`);
        const stopped = await jsonStep(`${owner}: cancel owned run`, [
          'headless', 'sessions', 'stop', ids.conversationId, '--run', ids.runId,
        ]);
        if (stopped.stopped !== true) throw new Error(`${owner}: owned run cancellation was not confirmed`);
        forgetAcceptedTurn(ids);
        receipt.steps.push({ name: `${owner}: owned run cancellation confirmed`, ...ids, stopped: true, status: stopped.status });
        saveReceipt();
      } catch (error) { failures.push(`${owner} ${ids.conversationId}/${ids.runId}: ${error.message}`); }
    }
    if (failures.length) throw new Error(failures.join('; ').slice(0, 500));
  }

  function idsFrom(result) {
    const data = result?.data;
    if (/^\d{12,24}$/u.test(data?.conversationId || '') && /^\d{12,24}$/u.test(data?.runId || '')) {
      return { conversationId: data.conversationId, runId: data.runId };
    }
    const message = result?.rawError || '';
    const match = message.match(/sessions wait (\d{12,24}) --run (\d{12,24})/u);
    return match ? { conversationId: match[1], runId: match[2] } : null;
  }

  function assertCompleted(name, result, expectedSchema = true) {
    if (result.timedOut) throw new Error(`${name}: CLI process exceeded its 330-second deadline`);
    if (!result.jsonParsed || result.code !== 0) throw new Error(`${name}: expected successful JSON completion (exit ${result.code})`);
    if (result.data.status !== 'completed') throw new Error(`${name}: turn did not complete`);
    if (expectedSchema && result.data.replyValid !== true) throw new Error(`${name}: JSON reply did not pass schema validation`);
    return result.data;
  }

  async function recoverIfNeeded(name, result, schemaFile) {
    if (result.code === 0 && result.jsonParsed && result.data.status === 'completed') return result.data;
    const ids = idsFrom(result);
    const timedOutByCli = /Waiting timed out|timeout/u.test(result.rawError || '')
      || result.data?.status === 'unknown' || result.data?.status === 'running';
    if (!ids || !timedOutByCli || result.timedOut) throw new Error(`${name}: task failed or timed out without recoverable accepted IDs`);
    receipt.steps.push({ name: `${name}: recovered accepted turn`, conversationId: ids.conversationId, runId: ids.runId });
    saveReceipt();
    const recovered = await waitForTurn(`${name}: recover same IDs`, ids.conversationId, ids.runId, schemaFile);
    return assertCompleted(`${name}: same-ID recovery`, recovered);
  }

  async function baseline() {
    const status = await jsonStep('baseline status', ['headless', 'status', '--timeout', String(CLI_TIMEOUT_SECONDS)]);
    if (status.loggedIn !== true || status.loginRequired === true) throw new Error('baseline status: isolated config is not already authenticated');
    const profiles = await jsonStep('baseline profiles', ['headless', 'profiles']);
    if (!Array.isArray(profiles.profiles) || !profiles.profiles.some(profile => profile.name === 'default')) {
      throw new Error('baseline profiles: default profile is missing');
    }
    const usage = await jsonStep('baseline usage', ['headless', 'usage', '--timeout', String(CLI_TIMEOUT_SECONDS)]);
    if (usage.platform !== 'headless') throw new Error('baseline usage: unexpected backend result');
    const models = await jsonStep('baseline models', ['headless', 'models', '--timeout', String(CLI_TIMEOUT_SECONDS)]);
    if (!Array.isArray(models.models) || models.models.length === 0) throw new Error('baseline models: live model catalog is empty');
    const runtimes = await jsonStep('baseline runtimes', ['headless', 'runtimes', '--timeout', String(CLI_TIMEOUT_SECONDS)]);
    const runtimeIds = (runtimes.runtimes || []).map(item => item.id);
    if (!runtimeIds.includes('cloud') || !runtimeIds.includes('local')) throw new Error('baseline runtimes: expected cloud and local entries');
    const sessions = await jsonStep('baseline sessions list', ['headless', 'sessions', 'list', '--limit', '10']);
    if (!Array.isArray(sessions.sessions)) throw new Error('baseline sessions list: session array is missing');
    const capabilities = await jsonStep('baseline capabilities', ['headless', 'capabilities']);
    for (const key of ['attachments', 'localRuntime', 'mcp', 'projects', 'enterpriseKnowledgeSelection', 'profiles', 'usage']) {
      if (capabilities[key] !== true) throw new Error(`baseline capabilities: ${key} is unavailable`);
    }
    const rejected = await execute('baseline rejects desktop target option', ['headless', 'sessions', 'list', '--target', '123']);
    if (rejected.code === 0 || !/--target is not supported on doubao headless/u.test(rejected.rawError || '')) {
      throw new Error('baseline strict options: unsupported --target was not rejected');
    }
    receipt.baseline = {
      loggedIn: true, profileCount: profiles.profiles.length, usageAvailable: true,
      modelCount: models.models.length,
      workModel5Available: models.models.some(model => model.id === '5' && model.available && model.modes?.includes('work')),
      runtimes: runtimeIds, sessionCount: sessions.sessions.length,
      capabilityKeys: Object.keys(capabilities).filter(key => capabilities[key] === true),
    };
    saveReceipt();
    return models.models;
  }

  function modelForWork(models) {
    const available = models.filter(model => model.available && Array.isArray(model.modes) && model.modes.includes('work'));
    return available.find(model => /GPT-5\.6 Sol/iu.test(model.name))
      || available.find(model => model.id === '5') || available[0] || null;
  }

  async function attachmentsStage(models) {
    const marker = `HEADLESS_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const textPath = path.join(fixtureDir, `attachment-${randomUUID()}.txt`);
    const imagePath = path.join(fixtureDir, `blue-${randomUUID()}.png`);
    fs.writeFileSync(textPath, `Synthetic acceptance marker: ${marker}\n`, { mode: 0o600, flag: 'wx' });
    writeBluePng(imagePath);
    const schema = { marker: { type: 'string' }, color: { type: 'string' } };
    const prompt = 'Inspect the attached text file and image. Return one valid JSON object with the exact text marker in "marker" and the dominant image color as an English word in "color". Use double quotes for every JSON key and string. Do not use Python syntax, single quotes, Markdown or explanatory text.';
    const model = modelForWork(models);
    const command = ['headless', 'sessions', 'create', prompt, '--mode', 'work', '--runtime', 'cloud',
      '--attach', textPath, '--attach', imagePath, '--expect-json', '--reply-schema', writeStageSchema('attachments', schema),
      '--timeout', String(CLI_TIMEOUT_SECONDS)];
    if (model) command.push('--model', model.id, '--reasoning', 'low');
    const started = await execute('attachments: create and wait', [...command, '--wait']);
    const data = await recoverIfNeeded('attachments', started, writeStageSchema('attachments-recovery', schema));
    const object = responseObject(data);
    if (object.marker !== marker || object.color?.toLowerCase() !== 'blue') throw new Error('attachments: model did not identify the file marker and blue image');
    receipt.steps.push({ name: 'attachments verified', conversationId: data.conversationId, runId: data.runId,
      markerSha256: markerHash(marker), imageColor: 'blue', modelId: model?.id || null });
    saveReceipt();
    await verifyCurrent(data.conversationId, 'attachments');
  }

  function writeStageSchema(name, schema) {
    const file = path.join(fixtureDir, `${name}-${randomUUID()}.schema.json`);
    writeSchema(file, schema);
    return file;
  }

  async function verifyCurrent(conversationId, name) {
    const current = await jsonStep(`${name}: current selection`, ['headless', 'sessions', 'current']);
    if (current.id !== conversationId || current.selected !== true) throw new Error(`${name}: created conversation is not selected`);
    receipt.steps.push({ name: `${name}: current selection verified`, conversationId });
    saveReceipt();
  }

  async function localStage(models) {
    const name = 'local';
    const marker = `HEADLESS_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const workspace = path.join(workspaceRoot, `${name}-${randomUUID()}`);
    mkdirPrivate(workspace);
    fs.writeFileSync(path.join(workspace, 'probe.txt'), `Synthetic local acceptance marker: ${marker}\n`, { mode: 0o600, flag: 'wx' });
    const schema = { marker: { type: 'string' } };
    const schemaFile = writeStageSchema(name, schema);
    const prompt = 'Use the Read tool to read probe.txt in the configured workspace. Do not use Bash or any other tool. Return one valid JSON object with the exact token as "marker". Use double quotes for every JSON key and string; no Python syntax, single quotes, Markdown or explanatory text.';
    const model = models.find(item => item.id === '5' && item.available && item.modes?.includes('work')) || modelForWork(models);
    const command = ['headless', 'sessions', 'create', prompt, '--mode', 'work', '--runtime', 'local',
      '--workspace', workspace, '--no-skills', '--permission', 'FullAccess', '--timeout', String(CLI_TIMEOUT_SECONDS)];
    if (model) command.push('--model', model.id, '--reasoning', 'low');
    command.push('--wait', '--expect-json', '--reply-schema', schemaFile);
    const started = await execute('local: create and wait', command);
    const data = await recoverIfNeeded('local', started, schemaFile);
    if (responseObject(data).marker !== marker) throw new Error('local: workspace file marker was not returned');
    receipt.steps.push({ name: 'local verified', conversationId: data.conversationId, runId: data.runId,
      markerSha256: markerHash(marker), workspaceCreated: true, modelId: model?.id || null });
    saveReceipt();
    await verifyCurrent(data.conversationId, 'local');
    // Verify the existing-session path as well as creation: switch to cloud,
    // then back to local with a new workspace and permission policy. The new
    // marker never appears in a prompt or schema, so history cannot satisfy it.
    const cloud = await execute('local: switch existing session to cloud', ['headless', 'sessions', 'send', data.conversationId,
      'Return one JSON object with marker equal to "cloud-switch-confirmed".', '--runtime', 'cloud', '--wait',
      '--expect-json', '--reply-schema', schemaFile, '--timeout', String(CLI_TIMEOUT_SECONDS)]);
    const cloudData = await recoverIfNeeded('cloud switch', cloud, schemaFile);
    if (responseObject(cloudData).marker !== 'cloud-switch-confirmed') throw new Error('local: cloud switch reply did not match');
    const nextMarker = `HEADLESS_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const nextWorkspace = path.join(workspaceRoot, `followup-${randomUUID()}`);
    mkdirPrivate(nextWorkspace);
    fs.writeFileSync(path.join(nextWorkspace, 'probe.txt'), `Synthetic local acceptance marker: ${nextMarker}\n`, { mode: 0o600, flag: 'wx' });
    const followed = await execute('local: switch back and read new workspace', ['headless', 'sessions', 'send', data.conversationId,
      prompt, '--runtime', 'local', '--workspace', nextWorkspace, '--no-skills', '--permission', 'AskOnRisk', '--wait',
      '--expect-json', '--reply-schema', schemaFile, '--timeout', String(CLI_TIMEOUT_SECONDS)]);
    const followedData = await recoverIfNeeded('local followup', followed, schemaFile);
    if (responseObject(followedData).marker !== nextMarker) throw new Error('local: followup did not read the changed workspace');
    receipt.steps.push({ name: 'existing session cloud/local/workspace/permission transitions verified',
      conversationId: followedData.conversationId, runId: followedData.runId, markerSha256: markerHash(nextMarker), permission: 'AskOnRisk' });
    saveReceipt();
  }

  async function registerFixture(marker, label) {
    const connectorName = `headless-e2e-${randomUUID().slice(0, 8)}`;
    const registered = await jsonStep(`${label}: register isolated fixture`, [
      'headless', 'mcp', 'register', connectorName, '--command', process.execPath,
      '--arg', MCP_FIXTURE, '--env', `DOUBAO_HEADLESS_E2E_MARKER=${marker}`,
      '--timeout', String(CLI_TIMEOUT_SECONDS),
    ]);
    const connectorId = registered.connectorId;
    if (!/^\d{6,24}$/u.test(connectorId || '') || registered.status !== 'READY') {
      throw new Error(`${label}: fixture registration was not confirmed READY`);
    }
    receipt.steps.push({ name: `${label}: registered own connector`, connectorId,
      status: registered.status, markerSha256: markerHash(marker) });
    saveReceipt();
    return connectorId;
  }

  async function removeFixture(connectorId, label) {
    const removed = await jsonStep(`${label}: remove exact owned connector`, [
      'headless', 'mcp', 'remove', connectorId, '--timeout', String(CLI_TIMEOUT_SECONDS),
    ]);
    if (removed.connectorId !== connectorId || removed.removed !== true) throw new Error(`${label}: exact connector removal was not confirmed`);
    const remaining = await jsonStep(`${label}: verify owned connector absent`, ['headless', 'mcp', 'list']);
    const retained = (remaining.connectors || []).find(item => item.connectorId === connectorId);
    if (retained && retained.enabled !== false || removed.serverInactive !== true || removed.ownedLocalConfigurationRemoved !== true) {
      throw new Error(`${label}: connector cleanup was not confirmed inactive and locally removed`);
    }
    receipt.steps.push({ name: `${label}: cleanup verified`, connectorId, removed: true,
      serverInactive: true, ownedLocalConfigurationRemoved: true, retainedDisabledRow: Boolean(retained) });
    saveReceipt();
  }

  async function backgroundStage(models) {
    const name = 'background';
    const fileMarker = `HEADLESS_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const toolMarker = `HEADLESS_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const workspace = path.join(workspaceRoot, `${name}-${randomUUID()}`);
    mkdirPrivate(workspace);
    fs.writeFileSync(path.join(workspace, 'probe.txt'), `Synthetic local acceptance marker: ${fileMarker}\n`, { mode: 0o600, flag: 'wx' });
    const schemaFile = writeStageSchema(name, {
      fileMarker: { type: 'string' },
      toolMarker: { type: 'string' },
    });
    const model = modelForWork(models);
    const prompt = 'Read probe.txt in the configured workspace, then call doubao_headless_e2e_marker once with no arguments. Return one valid JSON object with the file token as "fileMarker" and the tool result token as "toolMarker". Use double quotes for every JSON key and string; no Python syntax, single quotes, Markdown or explanatory text.';
    let connectorId = null;
    let stageError = null;
    let safeToRemove = true;
    try {
      connectorId = await registerFixture(toolMarker, name);
      const command = ['headless', 'sessions', 'create', prompt, '--mode', 'work', '--runtime', 'local',
        '--workspace', workspace, '--no-skills', '--permission', 'FullAccess', '--mcp', connectorId,
        '--timeout', String(CLI_TIMEOUT_SECONDS)];
      if (model) command.push('--model', model.id, '--reasoning', 'low');
      const accepted = requireOkay(`${name}: no-wait create`, await execute(`${name}: no-wait create`, command));
      const ids = idsFrom({ data: accepted });
      if (!ids || accepted.accepted !== true || accepted.status !== 'running') throw new Error(`${name}: no-wait create returned no accepted IDs`);
      receipt.steps.push({ name: `${name}: accepted`, ...ids, workerReturned: true,
        fileMarkerSha256: markerHash(fileMarker), toolMarkerSha256: markerHash(toolMarker), connectorId });
      saveReceipt();
      const waited = await waitForTurn(`${name}: wait with same IDs`, ids.conversationId, ids.runId, schemaFile);
      const data = await recoverIfNeeded(name, waited, schemaFile);
      const object = responseObject(data);
      if (object.fileMarker !== fileMarker || object.toolMarker !== toolMarker) {
        throw new Error(`${name}: detached worker did not return both fixture markers`);
      }
      receipt.steps.push({ name: `${name}: background MCP recovery verified`, ...ids,
        workerReturned: true, fileMarkerSha256: markerHash(fileMarker), toolMarkerSha256: markerHash(toolMarker), connectorId });
      saveReceipt();
      await verifyCurrent(ids.conversationId, name);
    } catch (error) { stageError = error; }
    finally {
      try { await cancelOwnedTurns(name); }
      catch (error) {
        safeToRemove = false;
        receipt.cleanupFailure = 'background MCP accepted run cancellation was not confirmed';
        saveReceipt();
        stageError ||= error;
      }
      if (connectorId && safeToRemove) {
        try { await removeFixture(connectorId, name); }
        catch (error) {
          receipt.cleanupFailure = 'background MCP connector removal or readback failed';
          saveReceipt();
          stageError ||= error;
        }
      }
    }
    if (stageError) throw new Error(`${name} stage failed: ${stageError.message}`);
  }

  async function mcpStage(models) {
    const marker = `HEADLESS_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    let connectorId = null;
    let stageError = null;
    let safeToRemove = true;
    try {
      connectorId = await registerFixture(marker, 'mcp');
      const model = modelForWork(models);
      const schema = { marker: { type: 'string' } };
      const schemaFile = writeStageSchema('mcp', schema);
      const prompt = 'Call the doubao_headless_e2e_marker tool once with no arguments. Return only the JSON object returned by that tool.';
      const taskArgs = ['headless', 'sessions', 'create', prompt, '--mode', 'work', '--runtime', 'local',
        '--mcp', connectorId, '--permission', 'FullAccess', '--no-skills', '--wait', '--expect-json',
        '--reply-schema', schemaFile, '--timeout', String(CLI_TIMEOUT_SECONDS)];
      if (model) taskArgs.push('--model', model.id, '--reasoning', 'low');
      const task = await execute('mcp: local task and wait', taskArgs);
      const data = await recoverIfNeeded('mcp', task, schemaFile);
      if (responseObject(data).marker !== marker) throw new Error('mcp: tool environment marker was not returned');
      receipt.steps.push({ name: 'mcp tool verified', connectorId, conversationId: data.conversationId,
        runId: data.runId, markerSha256: markerHash(marker), toolName: 'doubao_headless_e2e_marker' });
      saveReceipt();
      await verifyCurrent(data.conversationId, 'mcp');
    } catch (error) { stageError = error; }
    finally {
      try { await cancelOwnedTurns('mcp'); }
      catch (error) {
        safeToRemove = false;
        receipt.cleanupFailure = 'MCP accepted run cancellation was not confirmed';
        saveReceipt();
        stageError ||= error;
      }
      if (connectorId && safeToRemove) {
        try { await removeFixture(connectorId, 'mcp'); }
        catch (error) {
          receipt.cleanupFailure = 'owned MCP connector removal or readback failed';
          saveReceipt();
          stageError ||= error;
        }
      }
    }
    if (stageError) throw new Error(`mcp stage failed: ${stageError.message}`);
  }

  try {
    console.log(`OUTPUT ${runDir}`);
    const models = await baseline();
    if (options.stage === 'baseline') {
      receipt.completedAt = new Date().toISOString();
      receipt.passed = true;
      saveReceipt();
      console.log('PASS baseline');
      return;
    }
    const stages = options.stage === 'all' ? ['attachments', 'local', 'mcp', 'background'] : [options.stage];
    for (const stage of stages) {
      activeStage = stage;
      if (stage === 'attachments') await attachmentsStage(models);
      else if (stage === 'local') await localStage(models);
      else if (stage === 'mcp') await mcpStage(models);
      else if (stage === 'background') await backgroundStage(models);
      console.log(`PASS ${stage}`);
    }
    receipt.completedAt = new Date().toISOString();
    receipt.passed = true;
    saveReceipt();
    console.log(`PASS all selected Headless acceptance checks; receipt ${receiptPath}`);
  } catch (error) {
    try { await cancelOwnedTurns(); }
    catch (cleanupError) {
      receipt.cleanupFailure = String(cleanupError.message || 'owned accepted run cancellation failed').slice(0, 300);
    }
    receipt.failedAt = new Date().toISOString();
    receipt.passed = false;
    receipt.failure = String(error.message || 'acceptance failed').replaceAll(configDir, '<config>').slice(0, 500);
    saveReceipt();
    console.error(`FAIL ${receipt.failure}`);
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error(`FAIL ${String(error.message || 'acceptance runner failed').slice(0, 500)}`);
  process.exitCode = 1;
});
