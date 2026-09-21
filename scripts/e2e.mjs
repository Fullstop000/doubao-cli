#!/usr/bin/env node
// Opt-in live test: uses synthetic messages, attachments and one temporary
// connector in the selected app. Run stages sequentially against a quiet app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { resolveApp, withApp } from '../src/app.mjs';
import { CdpClient, findChatTarget, withChatClient } from '../src/cdp.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
export const fallback = args.includes('--fallback');
assert.ok(!fallback || !args.includes('--app'), '--fallback cannot be combined with --app');
export const app = option('--app', fallback ? 'doubao' : 'work');
assert.ok(['work', 'doubao'].includes(app), '--app requires work or doubao');
export const dir = path.resolve(option('--output', path.join(root, '.e2e', fallback ? 'fallback' : app)));
const stage = option('--stage', 'all');
const bin = path.join(root, 'bin/doubao.mjs');
const absenceFixture = path.join(root, 'scripts/fixtures/work-absent.cjs');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const child of ['workspace', 'config', 'npm']) fs.mkdirSync(path.join(dir, child), { recursive: true });
const statePath = path.join(dir, 'state.json');
export const state = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
export function save(values) { fs.writeFileSync(statePath, JSON.stringify({ ...state(), ...values }, null, 2) + '\n', { mode: 0o600 }); }
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const testApp = () => resolveApp(app, fallback ? {} : process.env);

export async function inspect(expression) {
  return withApp(testApp(), () => withChatClient(client => client.evaluate(expression)));
}

export async function cli(argv, options = {}) {
  const hideWork = options.fallback ?? fallback;
  const selectedApp = options.app === undefined ? (fallback ? null : app) : options.app;
  const selected = selectedApp ? ['--app', selectedApp] : [];
  const commandArgs = [...(hideWork ? ['--require', absenceFixture] : []), options.entry || bin, ...selected, ...(options.json === false ? [] : ['--json']), ...argv];
  const env = { ...process.env, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1', DOUBAO_CLI_CONFIG_DIR: path.join(dir, 'config'), npm_config_prefix: path.join(dir, 'npm') };
  // Exercise automatic discovery, even if the invoking shell has overrides.
  if (fallback) for (const key of ['DOUBAO_APP', 'DOUBAO_DATA_DIR', 'DOUBAO_CDP_ENDPOINT']) delete env[key];
  Object.assign(env, options.env);
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs || 200_000);
    child.on('close', code => {
      clearTimeout(timer);
      let data;
      try { data = JSON.parse(stdout); } catch {}
      resolve({ code, stdout, stderr, data, timedOut, durationMs: Date.now() - started, invocation: commandArgs });
    });
  });
}

export function record(result) {
  fs.appendFileSync(path.join(dir, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n', { mode: 0o600 });
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': ' + result.error : ''}`);
}

export async function check(name, argv, validator = () => {}, options = {}) {
  const result = await cli(argv, options);
  let error;
  try {
    assert.equal(result.timedOut, false, 'CLI process exceeded its deadline');
    assert.equal(result.code, options.expectedCode ?? 0, result.stderr || result.stdout);
    await validator(result.data, result);
  } catch (failure) { error = failure.message; }
  const row = { name, args: argv, ...result, pass: !error, ...(error ? { error } : {}) };
  record(row);
  if (error && !options.allowFailure) throw new Error(`${name}: ${error}`);
  return row;
}

const sent = value => assert.ok(/^\d{12,24}$/.test(value?.conversationId));
const textIncludes = marker => value => { sent(value); assert.ok(value.reply?.text.includes(marker), value.reply?.text); };
const imageCount = value => value.messages.reduce((sum, message) => sum + (message.role === 'user' ? message.images || 0 : 0), 0);
function sendModel() {
  const ids = (state().models || []).map(model => model.id);
  const id = ['gpt-6-astra', 'gpt-5.6-sol', 'doubao-2.1-pro'].find(candidate => ids.includes(candidate)) || ids.find(candidate => candidate !== 'auto');
  assert.ok(id, 'Run baseline first to discover available models');
  return id;
}

export async function until(probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do { const value = await probe(); if (value) return value; await pause(250); } while (Date.now() < deadline);
  throw new Error('Expected live state was not observed before the deadline');
}

function fixtures() {
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'Synthetic E2E input. Test marker: FILE_OK_721\n');
  fs.writeFileSync(path.join(dir, 'second.txt'), 'Synthetic E2E input. Test marker: SECOND_OK_832\n');
  fs.writeFileSync(path.join(dir, 'reply-schema.json'), JSON.stringify({ type: 'object', required: ['marker'], properties: { marker: { type: 'string', enum: ['WORK_E2E'] } } }));
  fs.writeFileSync(path.join(dir, 'bad-schema.json'), '{');
  fs.writeFileSync(path.join(dir, 'invalid-schema.json'), '{"required":"marker"}');
  const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([size, payload, crc]);
  };
  const width = 200, height = 140;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * (width * 3 + 1) + 1 + x * 3 + 2] = 255;
  fs.writeFileSync(path.join(dir, 'blue.png'), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}

async function selection() {
  assert.ok(fallback, 'The selection stage requires --fallback');
  const regular = resolveApp('doubao', {}), work = resolveApp('work', {});
  const explicit = await check('explicit Doubao status reference', ['status'], d => assert.equal(d.app, 'doubao'), { app: 'doubao', fallback: false });
  const auto = await check('absent Work automatically selects Doubao', ['status'], (d, r) => {
    assert.equal(d.app, 'doubao');
    assert.equal(d.appPath, regular.appPath);
    assert.equal(d.dataDir, regular.dataDir);
    assert.equal(d.cdpEndpoint, regular.endpoint);
    assert.equal(d.installed, true);
    assert.deepEqual(d.profile, explicit.data.profile);
    assert.equal(r.invocation.includes('--app'), false);
  });
  save({ appVersion: auto.data.appVersion, profile: auto.data.profile, dataDir: auto.data.dataDir, selection: 'automatic with Work installation probe hidden' });
  await check('fallback profiles use Doubao data', ['profiles'], d => assert.ok(d.profiles.some(p => p.directory === auto.data.profile.directory)));
  const capabilities = await check('fallback capabilities use Doubao endpoint', ['capabilities'], d => assert.equal(d.cdp.endpoint, regular.endpoint));
  await check('fallback CDP status uses Doubao endpoint', ['cdp', 'status'], d => {
    assert.equal(d.endpoint, regular.endpoint);
    assert.equal(d.available, capabilities.data.cdp.available);
  }, { expectedCode: capabilities.data.cdp.available ? 0 : 1 });
  if (!capabilities.data.cdp.available) {
    await check('fallback unavailable CDP cannot use running Work', ['model'], (_, r) => assert.match(r.stderr, /Doubao CDP is unavailable.*9225/), { expectedCode: 1 });
    if (auto.data.running) await check('fallback restart requires consent', ['cdp', 'launch'], (_, r) => assert.match(r.stderr, /Doubao must restart.*--app doubao cdp launch --yes/), { expectedCode: 1 });
  }
  await check('fallback sessions list', ['sessions', 'list'], d => assert.ok(Array.isArray(d)));
  await check('explicit Work never falls back when missing', ['status'], d => {
    assert.equal(d.app, 'work');
    assert.equal(d.installed, false);
    assert.equal(d.appPath, work.appPath);
    assert.equal(d.dataDir, work.dataDir);
    assert.equal(d.cdpEndpoint, work.endpoint);
  }, { app: 'work' });
  if (fs.existsSync(work.appPath)) {
    await check('installed Work retains automatic priority', ['status'], d => assert.equal(d.app, 'work'), { fallback: false });
    await check('unavailable Work never switches to Doubao', ['model'], (_, r) => assert.match(r.stderr, /DoubaoWork CDP is unavailable.*19926/), { fallback: false, env: { DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:19926' }, expectedCode: 1 });
    const workCdp = await cli(['cdp', 'status'], { app: 'work', fallback: false });
    if (workCdp.data?.available) await check('fallback rejects Work endpoint', ['cdp', 'status'], d => {
      assert.equal(d.identityMismatch, true);
      assert.match(d.error, /does not belong to Doubao;/);
    }, { env: { DOUBAO_CDP_ENDPOINT: work.endpoint }, expectedCode: 1 });
    await check('absence fixture does not persist to other processes', ['status'], d => { assert.equal(d.app, 'work'); assert.equal(d.installed, true); }, { fallback: false });
  }
}

async function baseline() {
  const initial = await inspect(`({ href:location.href, draft:document.querySelector('[contenteditable="true"]')?.innerText || '' })`);
  assert.equal(initial.draft.trim(), '', 'Clear the draft before running live E2E');
  if (!state().initialUrl) save({ initialUrl: initial.href });
  await check('help', ['help'], (_, result) => assert.match(result.stdout, /--app work\|doubao/), { json: false });
  await check('version', ['--version'], (_, result) => assert.equal(result.stdout.trim(), JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version), { json: false });
  const status = await check('status selected app', ['status'], d => { assert.equal(d.app, app); assert.equal(d.running, true); assert.equal(d.installed, true); });
  save({ appVersion: status.data.appVersion, profile: status.data.profile, dataDir: status.data.dataDir });
  await check('status automatic app selection', ['status'], d => assert.equal(d.app, !fallback && fs.existsSync('/Applications/DoubaoWork.app') ? 'work' : 'doubao'), { app: null });
  await check('status profile directory', ['status', '--profile', status.data.profile.directory], d => assert.equal(d.profile.directory, status.data.profile.directory));
  await check('status profile display name', ['status', '--profile', status.data.profile.name], d => assert.equal(d.profile.name, status.data.profile.name));
  await check('profiles', ['profiles'], d => assert.ok(d.profiles.some(p => p.directory === status.data.profile.directory)));
  await check('capabilities', ['capabilities'], d => { assert.equal(d.cdp.available, true); for (const key of ['createSessions','readMessages','sendMessages','stopGeneration','mcpConnectors','uploadAttachments','selectModels']) assert.equal(d[key], true); });
  await check('cdp status', ['cdp', 'status'], d => assert.equal(d.available, true));
  await check('cdp launch already ready', ['cdp', 'launch'], d => { assert.equal(d.available, true); assert.notEqual(d.restarted, true); });
  await check('cdp launch confirmed already ready', ['cdp', 'launch', '--yes'], d => { assert.equal(d.available, true); assert.notEqual(d.restarted, true); });
  await check('wrong app endpoint rejected', ['cdp', 'status'], d => assert.equal(d.identityMismatch, true), { app: app === 'work' ? 'doubao' : 'work', env: { DOUBAO_CDP_ENDPOINT: testApp().endpoint }, expectedCode: 1 });
  await check('restart requires consent', ['cdp', 'launch'], (_, r) => assert.match(r.stderr, /must restart/), { env: { DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:19926' }, expectedCode: 1 });
  await check('sessions list', ['sessions', 'list'], d => assert.ok(Array.isArray(d)));
  const models = await check('models', ['models'], d => { assert.ok(d.models.length); assert.equal(d.models.filter(m => m.selected).length, 1); });
  save({ models: models.data.models, initialModel: models.data.current });
  save({ sendModel: sendModel() });
  await check('model current', ['model'], d => assert.equal(d.name, models.data.current));
  await check('model current alias', ['model', 'current'], d => assert.equal(d.name, models.data.current));
  const connectors = await check('mcp list baseline', ['mcp', 'list'], d => assert.ok(Array.isArray(d)));
  if (!state().initialConnectors) save({ initialConnectors: connectors.data });
}

async function messages() {
  await check('sessions create blank', ['sessions', 'create'], d => { assert.equal(d.conversationId, null); assert.equal(d.persisted, false); });
  await check('current draft is explicit error', ['sessions', 'current'], (_, r) => assert.match(r.stderr, /draft|no conversation/), { expectedCode: 1 });
  const first = await check('sessions create JSON schema', ['sessions','create','Reply with exactly {"marker":"WORK_E2E"}. Do not call tools.', '--model',sendModel(),'--reasoning','low','--wait','--workspace',path.join(dir,'workspace'),'--no-skills','--expect-json','--reply-schema',path.join(dir,'reply-schema.json')], d => { sent(d); assert.equal(d.replyValid, true); assert.equal(d.created, true); });
  save({ textId: first.data.conversationId });
  const id = first.data.conversationId;
  await check('sessions open', ['sessions','open',id], async d => { assert.equal(d.opened, true); assert.match(d.url, app === 'work' ? /^doubaowork:\/\/doubaoworkapp\// : /^doubao:\/\/doubaoapp\//); await until(async()=> (await inspect('location.href')).endsWith('/'+id)); });
  await check('sessions current', ['sessions','current'], d=>assert.equal(d.id,id));
  await check('sessions read', ['sessions','read',id], d=>assert.ok(d.messages.some(m=>m.role==='assistant'&&m.text.includes('WORK_E2E'))));
  await check('sessions read limit', ['sessions','read',id,'--limit','1'], d=>assert.equal(d.messages.length,1));
  await check('sessions send wait', ['sessions','send',id,'Reply only FOLLOWUP_OK_938.','--wait'], textIncludes('FOLLOWUP_OK_938'));
  await check('sessions send no wait', ['sessions','send',id,'Reply only NO_WAIT_OK_427.'], d=>{sent(d);assert.equal(d.reply,null)});
  await until(async()=> { const r=await cli(['sessions','read',id]);return r.data?.messages.some(m=>m.role==='assistant'&&m.text.includes('NO_WAIT_OK_427')); },45_000);
  await check('no wait reply persisted', ['sessions','read',id], d=>assert.ok(d.messages.some(m=>m.role==='assistant'&&m.text.includes('NO_WAIT_OK_427'))));
  await check('session list includes created chat', ['sessions','list'], d=>assert.ok(d.some(s=>s.id===id)));
  await check('reply validation rejects non JSON', ['sessions','send',id,'Reply with exactly NOT_JSON_721 without any quotation marks.','--wait','--expect-json'], d=>assert.equal(d.replyValid,false),{expectedCode:1});
  const literal='--model is literal text. Reply only LITERAL_OK_516.';
  await check('message option terminator', ['sessions','send',id,'--wait','--',literal], d=>{textIncludes('LITERAL_OK_516')(d);assert.equal(d.sent.text,literal)});
}

async function models() {
  const id=state().textId; assert.ok(id,'Run messages first');
  await check('open model test session', ['sessions','open',id], async()=>until(async()=> (await inspect('location.href')).endsWith('/'+id)));
  for(const model of state().models) {
    await check(`select ${model.id}`, ['model','select',model.id],d=>assert.equal(d.id,model.id));
    await check(`read selected ${model.id}`, ['model'],d=>assert.equal(d.id,model.id));
  }
  for(const [level,label] of [['low','低'],['medium','中'],['high','高'],['xhigh','极高'],['max','最高']]) {
    await check(`reasoning ${level}`, ['model','reasoning',level],d=>assert.equal(d.reasoning,level));
    await check(`read reasoning ${level}`, ['model'],d=>assert.equal(d.reasoning,label));
  }
  await check('select with reasoning', ['model','select',sendModel(),'--reasoning','low'], d=>{assert.equal(d.id,sendModel());assert.equal(d.reasoning,'low')});
  await check('models has one current selection', ['models'], d=>assert.deepEqual(d.models.filter(m=>m.selected).map(m=>m.id),[sendModel()]));
  await check('send explicit model reasoning', ['sessions','send',id,'Reply only MODEL_OK_289.','--model',sendModel(),'--reasoning','low','--wait'],textIncludes('MODEL_OK_289'));
  await check('blank for draft model', ['sessions','create'],d=>assert.equal(d.persisted,false));
  await check('select draft model', ['model','select','turbo'],d=>assert.equal(d.id,'doubao-2.1-turbo'));
  await check('read draft model', ['model'],d=>assert.equal(d.id,'doubao-2.1-turbo'));
}

async function attachments() {
  const notes=path.join(dir,'notes.txt'),second=path.join(dir,'second.txt'),blue=path.join(dir,'blue.png');
  const first=await check('create with file', ['sessions','create','Read the attached file and reply only with its test marker. Do not use other tools.','--attach',notes,'--model',sendModel(),'--wait'],textIncludes('FILE_OK_721'));
  save({fileId:first.data.conversationId}); const id=first.data.conversationId;
  await check('read file attachment', ['sessions','read',id],d=>assert.ok(d.messages.some(m=>m.attachments?.includes('notes.txt'))));
  await check('send multiple files', ['sessions','send',id,'Read both attached files and reply only with both test markers.','--attach',notes,'--attach',second,'--wait'],d=>{textIncludes('FILE_OK_721')(d);textIncludes('SECOND_OK_832')(d);assert.equal(d.attachments.length,2)});
  await check('send image', ['sessions','send',id,'What solid color is this image? Reply only with one English color word.','--attach',blue,'--wait'],d=>assert.match(d.reply.text,/blue/i));
  await check('read image attachment', ['sessions','read',id],d=>assert.ok(imageCount(d)>=1));
  const image=await check('create with image', ['sessions','create','What solid color is this image? Reply only with one English color word.','--attach',blue,'--model',sendModel(),'--wait'],d=>assert.match(d.reply.text,/blue/i));
  save({imageId:image.data.conversationId});
  await check('send duplicate images', ['sessions','send',id,'How many images are attached to THIS message? Reply only with the count.','--attach',blue,'--attach',blue,'--wait'],d=>{assert.match(d.reply.text,/2/);assert.equal(d.attachments.length,2)});
  await check('read duplicate images', ['sessions','read',id],d=>assert.ok(d.messages.some(m=>m.images===2)));
}

async function stop() {
  const first=await check('create for stop', ['sessions','create','Reply only STOP_READY.','--model',sendModel(),'--reasoning','low','--wait','--no-skills'],textIncludes('STOP_READY'));
  const id=first.data.conversationId;save({stopId:id});
  await check('open stop session', ['sessions','open',id],async()=>until(async()=> (await inspect('location.href')).endsWith('/'+id)));
  await check('start long generation', ['sessions','send',id,'For a stop-button test, write a long numbered list of 1500 imaginary fruit names, one item per line. Do not call any tools.','--model',sendModel(),'--reasoning','low'],d=>assert.equal(d.reply,null));
  // Do not reload the page: this deliberately checks the stale-composer case.
  await check('stop while UI is stale', ['sessions','stop',id,'--timeout','20'],d=>{assert.equal(d.stopped,true);assert.equal(d.interrupted,true)});
  await check('sessions stop active generation', ['sessions','stop',id,'--timeout','20'],d=>{assert.equal(d.stopped,true);assert.equal(d.interrupted,true)});
  record({name:'generation stopped readback',pass:true});
  await check('sessions stop idle', ['sessions','stop',id],d=>assert.equal(d.stopped,true));
}

async function mcp() {
  const log=path.join(dir,'mcp-calls.jsonl');
  let id=state().connectorId;
  if(!id) {
    const registered=await check('mcp register repeated args env', ['mcp','register',`doubao-cli-e2e-${Date.now()}`,'--command',process.execPath,'--arg',path.join(root,'scripts/fixtures/mcp-server.mjs'),'--arg','--synthetic','--arg','value','--env',`DOUBAO_E2E_LOG=${log}`,'--env','DOUBAO_E2E_MARKER=ENV_OK=721'],d=>{assert.match(d.connectorId,/^\d+$/);assert.equal(d.status,'READY')});
    id=registered.data.connectorId;save({connectorId:id});
  }
  const target=await withApp(testApp(),()=>findChatTarget());
  const observer=await new CdpClient(target.webSocketDebuggerUrl).connect();
  const requests=[];
  observer.socket.addEventListener('message',event=>{
    const message=JSON.parse(String(event.data));
    const request=message.method==='Network.requestWillBeSent'&&message.params.request;
    if(!request || !request.url?.includes('/chat/completion')||!request.postData)return;
    try {
      const body=JSON.parse(request.postData);
      const params=JSON.parse(body.ext.general_task_param);
      requests.push({aid:new URL(request.url).searchParams.get('aid'),params,connectorIds:JSON.parse(params.task_input_json).localConnectors.map(c=>c.connectorId)});
    } catch {}
  });
  await observer.send('Network.enable');
  try {
    await check('mcp registered list', ['mcp','list'],d=>assert.ok(d.some(c=>c.connectorId===id&&c.enabled)));
    const start=JSON.parse(fs.readFileSync(log,'utf8').trim().split('\n')[0]);
    assert.deepEqual(start.args,['--synthetic','value']);assert.equal(start.marker,'ENV_OK=721');
    record({name:'MCP process arguments environment readback',pass:true});
    let conversationId;
    for(const [label,mode,permission] of [['default FullAccess',null,2],['AlwaysAsk','AlwaysAsk',0],['AskOnRisk','AskOnRisk',1],['explicit FullAccess','FullAccess',2],['reset to default',null,2]]) {
      const marker='MCP_'+label.replaceAll(' ','_')+'_'+Date.now();
      const prompt=`Call doubao_e2e_ping once with message "${marker}". Reply only with its exact pong result. Do not use other tools.`;
      const r=await check(`MCP turn ${label}`,['sessions',conversationId?'send':'create',...(conversationId?[conversationId]:[]),prompt,'--mcp',id,'--model',sendModel(),'--reasoning','low','--workspace',path.join(dir,'workspace'),'--no-skills','--wait',...(mode?['--permission',mode]:[])],d=>textIncludes('pong: '+marker)(d));
      conversationId=r.data.conversationId;save({mcpId:conversationId});
      const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.event==='call'&&x.message===marker);
      assert.ok(calls.length>=1,'tool claim lacks a server call');
      record({name:`MCP server result ${label}`,pass:true,calls:calls.length});
      const wire=requests.at(-1);assert.ok(wire,'missing observed request');
      assert.equal(wire.aid,testApp().aid);
      assert.equal(String(wire.params.agent_task_param.local_app_id),testApp().aid);
      assert.deepEqual(wire.connectorIds,[id]);
      assert.equal(wire.params.client_option.sandbox_auth_type,permission);
      assert.equal(wire.params.agent_task_param.sandbox_auth_type,permission);
      assert.match(wire.params.client_option.sandbox_id,/^sandbox-/);
      assert.equal(wire.params.client_option.workspace,path.join(dir,'workspace'));
      assert.deepEqual(wire.params.client_option.agent_workspace.local_skill_paths,[]);
      record({name:`MCP permission workspace request ${label}`,pass:true,permission});
      const agentWorkspace=wire.params.client_option.agent_workspace.agent_workspace;
      assert.ok(agentWorkspace.startsWith(path.join(testApp().dataDir,state().profile.directory)+path.sep));
      const ancestry=[];
      for(let pid=calls.at(-1).pid,depth=0;pid>1&&depth<12;depth++) {
        const row=execFileSync('/bin/ps',['-p',String(pid),'-o','ppid=,comm='],{encoding:'utf8'}).trim();
        const match=/^(\d+)\s+(.+)$/.exec(row);assert.ok(match,'MCP process ancestry unavailable');
        ancestry.push({pid,command:match[2]});pid=Number(match[1]);
      }
      assert.ok(ancestry.some(p=>p.command.startsWith(testApp().appPath+path.sep)),'MCP server was not spawned by the selected app');
      const other=resolveApp(app==='work'?'doubao':'work',{});
      assert.ok(!ancestry.some(p=>p.command.startsWith(other.appPath+path.sep)),'MCP server belongs to the other app');
      record({name:`MCP selected app runtime ${label}`,pass:true,aid:wire.aid,agentWorkspace,ancestry});
    }
  } finally {
    observer.close();
    await check('mcp remove', ['mcp','remove',id],d=>{assert.equal(d.removed,true);assert.equal(d.runtimeDisconnected,true)});
    save({connectorId:null});
    await check('mcp removal account readback', ['mcp','list'],d=>{assert.ok(!d.some(c=>c.connectorId===id&&c.enabled));for(const before of state().initialConnectors||[]) assert.ok(d.some(c=>c.connectorId===before.connectorId&&c.enabled===before.enabled))});
  }
}

async function negative() {
  const id=state().textId || '38439138239851266';
  const cases=[
    ['invalid app',['status','--app','typo'],/--app/],
    ['unknown profile',['status','--profile','nonexistent-e2e-profile'],/unknown profile/],
    ['invalid session id',['sessions','read','bad'],/conversation id/],
    ['missing message',['sessions','send',id],/message cannot be empty/],
    ['invalid model',['model','select','not-a-model'],/unknown model/],
    ['invalid reasoning',['sessions','create','test','--reasoning','typo'],/unknown reasoning/],
    ['followup reasoning without model',['sessions','send',id,'test','--reasoning','low'],/requires --model/],
    ['invalid permission',['sessions','create','test','--wait','--mcp','123456','--permission','typo'],/unknown permission/],
    ['permission requires MCP',['sessions','create','test','--wait','--permission','AlwaysAsk'],/requires sessions create\/send with --mcp/],
    ['MCP requires wait',['sessions','create','test','--mcp','123456'],/requires --wait/],
    ['MCP requires message',['sessions','create','--wait','--mcp','123456'],/requires a message/],
    ['MCP attachment conflict',['sessions','create','test','--wait','--mcp','123456','--attach',path.join(dir,'notes.txt')],/not supported with attachments/],
    ['invalid connector id',['mcp','remove','bad'],/connector id/],
    ['missing executable',['mcp','register','e2e','--command','/missing-e2e-node'],/command not found/],
    ['invalid environment pair',['mcp','register','e2e','--env','BAD'],/KEY=VALUE/],
    ['JSON validation requires wait',['sessions','create','must not send','--expect-json'],/require --wait/],
    ['schema missing',['sessions','create','must not send','--wait','--reply-schema',path.join(dir,'missing.json')],/cannot read reply schema/],
    ['schema malformed JSON',['sessions','create','must not send','--wait','--reply-schema',path.join(dir,'bad-schema.json')],/cannot read reply schema/],
    ['schema invalid shape',['sessions','create','must not send','--wait','--reply-schema',path.join(dir,'invalid-schema.json')],/required must be/],
    ['invalid timeout',['status','--timeout','0'],/positive number/],
    ['invalid limit',['sessions','read',id,'--limit','0'],/integer from/],
    ['missing attachment flag value',['sessions','create','test','--attach','--wait'],/requires a file path/],
    ['missing attachment file',['sessions','create','test','--attach',path.join(dir,'missing.txt')],/attachment does not exist/],
    ['attachment directory',['sessions','create','test','--attach',path.join(dir,'workspace')],/not a regular file/],
    ['attachment reasoning conflict',['sessions','create','test','--attach',path.join(dir,'notes.txt'),'--reasoning','low'],/without attachments/],
    ['unknown update command',['update','typo'],/unknown update command/],
    ['unknown update auto action',['update','auto','typo'],/requires on/],
    ['unknown top-level command',['typo'],/unknown command/],
  ];
  for(const [name,argv,pattern] of cases) await check(name,argv,(_,r)=>assert.match(r.stderr,pattern),{expectedCode:1});
}

async function update() {
  const r=await check('update check', ['update','check'],d=>assert.ok(/^\d+\.\d+\.\d+/.test(d.latestVersion)));
  save({registryVersion:r.data.latestVersion});
  await check('update', ['update'],d=>{assert.equal(typeof d.updated,'boolean');if(!r.data.updateAvailable)assert.equal(d.updated,false)});
  for(const [label,value,expected] of [['on','on',true],['status enabled','status',true],['off','off',false],['status disabled','status',false]]) await check(`update auto ${label}`,['update','auto',value],d=>assert.equal(d.enabled,expected));
  await check('update auto implicit status',['update','auto'],d=>assert.equal(d.enabled,false));
}

async function cleanup() {
  if(state().connectorId) {
    await check('cleanup pending MCP', ['mcp','remove',state().connectorId],d=>assert.equal(d.removed,true));
    save({connectorId:null});
  }
  const initial=state().initialUrl;
  if(initial) await withApp(testApp(),()=>withChatClient(c=>c.send('Page.navigate',{url:initial})));
  const connectors=await cli(['mcp','list']);
  assert.equal(connectors.code,0,connectors.stderr);
  for(const before of state().initialConnectors||[]) assert.ok(connectors.data.some(c=>c.connectorId===before.connectorId&&c.enabled===before.enabled));
  record({name:'cleanup preserved original connectors',pass:true});
}

const stages={...(fallback ? {selection} : {}),baseline,messages,models,attachments,stop,mcp,negative,update,cleanup};
export function summary() {
  const rows=fs.existsSync(path.join(dir,'results.jsonl'))?fs.readFileSync(path.join(dir,'results.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const latest=[...new Map(rows.map(row=>[row.name,row])).values()];
  const checks=latest.filter(row=>!row.name.startsWith('stage '));
  const result={app,fallback,appVersion:state().appVersion,total:checks.length,passed:checks.filter(r=>r.pass).length,failed:latest.filter(r=>!r.pass).map(({name,error})=>({name,error})),checks:checks.map(({name,pass,durationMs})=>({name,pass,durationMs}))};
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(args.includes('--help')) { console.log('node scripts/e2e.mjs [--app work|doubao | --fallback] [--output DIR] [--stage all|selection|baseline|messages|models|attachments|stop|mcp|negative|update|cleanup]\nRequires an already running, signed-in app with CDP enabled. Sends synthetic chats and uploads generated fixtures. Does not restart apps.\n--fallback hides only the Work installation probe in CLI child processes and omits --app, then exercises real Doubao. The selection stage needs no restart.'); }
  else {
    fixtures();
    try {
      if(stage==='all') { try {for(const [name,run] of Object.entries(stages))if(name!=='cleanup')await run();}finally{await cleanup();} }
      else {assert.ok(stages[stage],`Unknown stage ${stage}`);await stages[stage]();}
      record({name:`stage ${stage}`,pass:true});
    } catch(error) { record({name:`stage ${stage}`,pass:false,error:error.message});console.error(error.message);process.exitCode=1; }
    const result=summary();console.log(JSON.stringify({total:result.total,passed:result.passed,failed:result.failed,output:dir}));
  }
}
