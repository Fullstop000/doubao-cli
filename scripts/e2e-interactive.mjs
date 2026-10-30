#!/usr/bin/env node
// Human-operated acceptance only. stdin and stderr stay attached to the native
// terminal; this runner never injects CLI approval answers. A private terminal
// transcript records visible prompts/errors; no extra operator questionnaires.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const [rootArg,mode='run']=process.argv.slice(2);
if(!rootArg||!path.isAbsolute(rootArg)||!['run','check','cleanup'].includes(mode))throw new Error('Usage: node scripts/e2e-interactive.mjs <private-suite-directory> [run|check|cleanup]');
process.umask(0o077);
const root=await fs.realpath(rootArg),manifest=JSON.parse(await fs.readFile(path.join(root,'runtime-manifest.json'),'utf8'));
const cli=await fs.realpath(manifest.cli),config=await fs.realpath(manifest.config),source=await fs.realpath(manifest.source);
assert.equal(config,path.join(root,'config'),'Use only this suite’s fresh isolated config');
const files=[];
async function walk(base,relative=''){for(const entry of (await fs.readdir(path.join(base,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(relative,entry.name);if(entry.isDirectory())await walk(base,f);else if(/\.(?:mjs|js)$/.test(f))files.push(f);}}
for(const folder of ['src','dist','bin']){const partial=[];const start=files.length;await walk(path.join(source,folder));for(let i=start;i<files.length;i++)files[i]=path.join(folder,files[i]);}
const hash=createHash('sha256');
for(const file of files.sort()){
 const original=await fs.readFile(path.join(source,file)),installed=await fs.readFile(path.join(path.dirname(path.dirname(cli)),file));
 assert(original.equals(installed),'Candidate differs from source: '+file);hash.update(file);hash.update(original);
}
assert.equal(hash.digest('hex'),manifest.runtimeSha256,'Runtime changed; prepare a new suite instead of mixing evidence');
if(mode==='check'){console.log(JSON.stringify({runtimeFilesVerified:files.length,interactive:false,executedCommands:0}));process.exit(0);}
if(!process.stdin.isTTY||!process.stderr.isTTY)throw new Error('Open the .command launcher in macOS Terminal; redirected or non-interactive execution is refused');
const resultsDir=path.join(root,'results');await fs.mkdir(resultsDir,{recursive:true,mode:0o700});
const env={...process.env,DOUBAO_CLI_CONFIG_DIR:config,DOUBAO_CLI_DISABLE_AUTO_UPDATE:'1'};delete env.DOUBAO_HEADLESS_COOKIE;
const save=async(name,data)=>{const file=path.join(resultsDir,name+'.json');await fs.writeFile(file,JSON.stringify(data,null,2),{mode:0o600});};
const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const stateFile=path.join(root,'suite-state.json');let state=await read(stateFile);
if(!state){state={suiteId:randomUUID(),createdAt:new Date().toISOString(),ownedConversations:[],connectorId:null,checks:{}};await fs.writeFile(stateFile,JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});}
const persist=()=>fs.writeFile(stateFile,JSON.stringify(state,null,2),{mode:0o600});
async function call(name,args,{cache=true}={}){
 const output=path.join(resultsDir,name+'.json');const previous=await read(output);
 if(previous&&cache){console.error('已保存，未重发：'+name);return previous;}
 const intent=path.join(resultsDir,name+'.started');
 try{await fs.writeFile(intent,JSON.stringify({startedAt:new Date().toISOString(),args}),{mode:0o600,flag:'wx'});}catch(e){if(e.code==='EEXIST')throw new Error(name+' has an uncertain prior attempt. Do not resend. Run the cleanup launcher and return to Codex.');throw e;}
 const result=await new Promise(resolve=>{
  // Do not replace inherited stdin/stderr with pipes: the real CLI must see TTY.
  const child=spawn(manifest.node,[cli,'headless',...args,'--json'],{env,stdio:['inherit','pipe','inherit']});
  let stdout='',timedOut=false,done=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},360000);
  child.stdout.on('data',part=>{stdout+=part;if(stdout.length>8*1024*1024){timedOut=true;child.kill('SIGTERM');}});
  const finish=(exitCode,signal,spawnError)=>{if(done)return;done=true;clearTimeout(timer);let data;try{data=JSON.parse(stdout);}catch{}resolve({exitCode,signal,timedOut,data,stdout,stderr:'inherited native terminal; not captured',spawnError:spawnError?.message,finishedAt:new Date().toISOString()});};
  child.once('error',error=>finish(null,null,error));child.once('close',(code,signal)=>finish(code,signal));
 });
 await save(name,result);
 if(args[0]==='sessions'&&['create','send'].includes(args[1])&&result.data?.conversationId){
  const item={conversationId:result.data.conversationId,runId:result.data.runId,stage:name};
  if(!state.ownedConversations.some(x=>x.conversationId===item.conversationId&&x.runId===item.runId))state.ownedConversations.push(item);await persist();
 }
 return result;
}
async function allReceipts(){
 const found=[];async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const f=path.join(dir,e.name);if(e.isDirectory())await scan(f);else if(e.name.endsWith('.json')){const data=await read(f);if(data?.conversationId&&data?.runId)found.push(data);}}}await scan(path.join(config,'turns'));return found;
}
async function journalFor(result){const receipts=await allReceipts();const receipt=receipts.find(r=>r.conversationId===result.data?.conversationId&&r.runId===result.data?.runId);assert(receipt?.localRuntime?.journalPath,'No runtime journal for exact accepted run');const journal=await read(receipt.localRuntime.journalPath);assert(journal,'Runtime journal unavailable');return journal;}
async function cleanup(){
 // Recover only IDs written by this suite's isolated runtime. Never submit again.
 for(const r of await allReceipts())if(JSON.stringify(r.requestBody||{}).includes(state.suiteId)&&!state.ownedConversations.some(x=>x.conversationId===r.conversationId&&x.runId===r.runId))state.ownedConversations.push({conversationId:r.conversationId,runId:r.runId,stage:'recovered-private-receipt'});
 await persist();const rows=[];const suffix=Date.now();
 for(const item of state.ownedConversations){try{
  const status=await call('cleanup-status-'+item.runId+'-'+suffix,['sessions','status',item.conversationId,'--run',item.runId]);let terminal=['completed','failed','cancelled'].includes(status.data?.status);
  if(!terminal){const stopped=await call('cleanup-stop-'+item.runId+'-'+suffix,['sessions','stop',item.conversationId,'--run',item.runId,'--timeout','90']);terminal=stopped.data?.stopped===true;}
  assert(terminal,'Task not confirmed terminal; resource removal withheld');
  const archived=await call('cleanup-archive-'+item.runId+'-'+suffix,['sessions','archive',item.conversationId]);assert.equal(archived.data?.verified,true);rows.push({...item,terminal:true,archived:true});
 }catch(e){rows.push({...item,terminal:false,archived:false,error:e.message});}}
 if(state.connectorId&&rows.every(x=>x.terminal)){
  const listed=await call('cleanup-mcp-before-'+suffix,['mcp','list']);const live=listed.data?.connectors?.find(x=>x.connectorId===state.connectorId&&x.enabled!==false);
  if(live){const removed=await call('cleanup-mcp-remove-'+suffix,['mcp','remove',state.connectorId]);assert.equal(removed.data?.removed,true);}
  const after=await call('cleanup-mcp-after-'+suffix,['mcp','list']);assert(!after.data?.connectors?.some(x=>x.connectorId===state.connectorId&&x.enabled!==false));state.connectorCleaned=true;
 }
 state.cleanup=rows;await persist();await save('cleanup-summary-'+suffix,{rows,connectorCleaned:state.connectorCleaned??!state.connectorId});
 if(rows.some(x=>!x.terminal||!x.archived))throw new Error('Cleanup incomplete; return to Codex with the private evidence directory');
}
if(mode==='cleanup'){await cleanup();console.error('已按原 run 回读并清理；没有重新提交测试消息。');process.exit(0);}
async function check(name,fn){if(state.checks[name]){console.error('保留已有结论，未重发：'+name);return;}try{await fn();state.checks[name]={status:'passed',at:new Date().toISOString()};}catch(e){state.checks[name]={status:'failed',reason:e.message,at:new Date().toISOString()};console.error('未通过：'+name+'；结果已保存，不会自动重试。');}await persist();await save('summary',state.checks);}
let login;
for(const filename of ['login-v2.json','login.json']){try{const value=await read(path.join(root,filename));if(value?.loggedIn===true){login=value;break;}}catch(e){if(!(e instanceof SyntaxError))throw e;}}
assert(login?.loggedIn===true,'Complete the fresh QR login launcher first');
const status=await call('fresh-login-readback',['status']);assert.equal(status.data?.loggedIn,true);assert.equal(status.data.accountId,login.accountId);if(manifest.authEvidence?.kind==='reused-qr-session')state.checks.authReadback={status:'passed',freshQr:false,sourceSuite:manifest.authEvidence.sourceSuite};
else state.checks.freshQr={status:'passed',freshConfig:true,cookieImport:false};await persist();
const catalog=await call('models',['models']);const model=catalog.data?.models?.find(m=>m.available&&m.modes?.includes('work')&&!['自动','auto'].includes(m.name));assert(model,'No available Work model');
const enabledStages=new Set(manifest.stages||['fullaccess-deny','fullaccess-approve','alwaysask-deny','alwaysask-approve','mcp-approve']);
assert([...enabledStages].every(s=>['fullaccess-deny','fullaccess-approve','alwaysask-deny','alwaysask-approve','mcp-approve'].includes(s)));
assert(['AskOnRisk','AlwaysAsk'].includes(manifest.mcpPermission||'AskOnRisk'));
const terminal=r=>{assert.equal(r.exitCode,0);assert.equal(r.data?.status,'completed');};
try{
 for(const [name,permission,approve] of [['fullaccess-deny','FullAccess',false],['fullaccess-approve','FullAccess',true],['alwaysask-deny','AlwaysAsk',false],['alwaysask-approve','AlwaysAsk',true]]){
  if(!enabledStages.has(name))continue;
  await check(name,async()=>{
   const workspace=path.join(root,'workspaces',name);await fs.mkdir(workspace,{recursive:true,mode:0o700});const marker=state.suiteId+'-'+name,proof=path.join(workspace,'proof.txt');
   console.error('\n【'+(approve?'批准测试：输入 y':'拒绝测试：输入 n')+'】'+name+'：模型最终用 Bash 写入 proof.txt；此前可能先请求在本次专用 workspace 内初始化 trajectory.jsonl、memory 等文件。');
   console.error(approve?'请逐项批准本次专用 workspace 内的初始化和指定 Bash（输入 y）；若请求访问其他目录或执行无关命令，请输入 n。':'请对本项出现的每个权限提示都输入 n；每项会回显并换行。初始化拒绝本身也是有效的拒绝测试，不要求继续到 Bash。');
   const before=(await allReceipts()).map(x=>x.runId);
   const transcriptPath=path.join(root,'run-terminal.typescript');
   const transcriptOffset=(await fs.stat(transcriptPath)).size;
   const prompt=`Synthetic interactive acceptance ${marker}. Use Bash exactly once to run this exact command:\nprintf '%s' '${marker}' > proof.txt\nDo not access other files or network. If permission is denied, stop immediately without retrying or using another tool. Reply DONE after success or DENIED after refusal.`;
   const result=await call(name,['sessions','create',prompt,'--runtime','local','--workspace',workspace,'--permission',permission,'--no-skills','--model',model.name,'--wait','--timeout','300']);
   const content=await fs.readFile(proof,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(permission==='FullAccess'&&!approve){assert.equal(result.exitCode,1);assert(!result.data?.runId);assert.equal(content,null);assert.deepEqual((await allReceipts()).map(x=>x.runId),before);
    const transcript=(await fs.readFile(transcriptPath)).subarray(transcriptOffset).toString('utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu,'');
    assert.match(transcript,/Enable FullAccess for this turn/u);
    assert.match(transcript,/FullAccess requires explicit confirmation/u);
    await save(name+'-proof',{promptShown:true,confirmationRejected:true,submitted:false,filePresent:false});return;}
   const journal=await journalFor(result),bash=journal.records.filter(x=>x.result?.name==='Bash');
   const denied=journal.records.some(x=>JSON.stringify(x.result||{}).includes('"error_code":"PERMISSION_DENIED"'));
   if(approve){terminal(result);assert(bash.length,'No real Bash request in local runtime journal');assert.equal(content,marker);assert(bash.some(x=>x.status==='uploaded'&&x.result?.isError===false));}
   else{assert.equal(content,null);assert(denied,'No actual permission denial in runtime journal');assert(!bash.some(x=>x.result?.isError===false));}
   await save(name+'-proof',{filePresent:content!==null,markerMatches:content===marker,bashRequests:bash.length,permissionDenied:denied,deniedAtInitialization:!approve&&bash.length===0});
  });
  await cleanup();
 }
 if(enabledStages.has('mcp-approve'))await check('mcp-approve',async()=>{
  const workspace=path.join(root,'workspaces','mcp');await fs.mkdir(workspace,{recursive:true,mode:0o700});const log=path.join(root,'mcp-calls.jsonl'),fixture=path.join(root,'mcp-fixture.mjs');
  const connectorName='cli-manual-'+state.suiteId.slice(0,8),marker=state.suiteId+'-mcp';
  console.error('\n【批准测试：MCP】本项验证实际执行，请在愿意批准时输入 y。可批准本次专用 workspace 内的初始化以及 interactive_e2e_echo 调用；工具仅返回 marker 并写测试日志。外部目录或无关命令请拒绝。');
  const registered=await call('mcp-register',['mcp','register',connectorName,'--command',manifest.node,'--arg',fixture,'--env','INTERACTIVE_E2E_LOG='+log]);
  if(registered.data?.connectorId){state.connectorId=registered.data.connectorId;await persist();}assert.equal(registered.exitCode,0);assert.equal(registered.data?.status,'READY');
  const task=await call('mcp-approve',['sessions','create',`Synthetic interactive acceptance ${state.suiteId}. Call interactive_e2e_echo exactly once with message ${marker}. Do not use any other tool. If approval is denied, stop without retrying. Return the tool's pong response.`, '--runtime','local','--workspace',workspace,'--mcp',state.connectorId,'--permission',manifest.mcpPermission||'AskOnRisk','--no-skills','--model',model.name,'--wait','--timeout','300']);
  terminal(task);const events=(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);const calls=events.filter(x=>x.event==='call'&&x.message===marker);assert.equal(calls.length,1);assert(task.data.reply?.text?.includes('pong: '+marker));
  const journal=await journalFor(task);assert(journal.records.some(x=>{if(x.status!=='uploaded'||x.result?.name!=='connector.call'||x.result.error_code)return false;try{const raw=JSON.parse(x.result.raw_result);return raw.isError!==true&&raw.content?.some(c=>c.type==='text'&&c.text?.includes('pong: '+marker));}catch{return false;}}));await save('mcp-proof',{calls:calls.length,actualServerExecution:true,successfulRuntimeResult:true});
 });
}finally{await cleanup();}
console.error('\n验收结束。结果保存在：'+resultsDir);console.error(JSON.stringify(Object.fromEntries(Object.entries(state.checks).map(([k,v])=>[k,v.status])),null,2));
if(Object.values(state.checks).some(x=>x.status!=='passed'))process.exitCode=1;
