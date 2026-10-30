#!/usr/bin/env node
// Opt-in real-account verification. Receipts are private and durable; failed
// invocations are never replayed automatically. Only owned resources are mutated.
// DOUBAO_E2E_SEED_SESSION may name an existing test-owned session to open before
// verification. The original page is restored. Modules-only verification may
// reuse a completed test-owned session via DOUBAO_E2E_EXISTING_SESSION; it does
// not resend the original turn. Never point either variable at a user session.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {APP_MODULE_BOOTSTRAP} from '../src/app-modules.mjs';
import {listProjects} from '../src/context.mjs';
import {withApp,resolveApp} from '../src/app.mjs';
import {withChatClient} from '../src/cdp.mjs';
const [cli,out,stage='all']=process.argv.slice(2);
assert(['all','modules'].includes(stage),'stage must be all or modules');
assert(cli&&out&&path.isAbsolute(cli)&&path.isAbsolute(out),'usage: runner <absolute candidate entry> <private output> [all|modules]');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const runtimeRoot=path.resolve(path.dirname(cli),'..');
const runtimeFiles=[];
function collect(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())collect(file);else runtimeFiles.push(file);}}
for(const child of ['bin','src','dist'])collect(path.join(runtimeRoot,child));
runtimeFiles.push(path.join(runtimeRoot,'package.json'));
const hash=createHash('sha256');
for(const file of runtimeFiles.sort()){hash.update(path.relative(runtimeRoot,file));hash.update('\0');hash.update(fs.readFileSync(file));hash.update('\0');}
const manifest={cli:path.resolve(cli),runtimeSha256:hash.digest('hex'),node:process.version,args:process.argv.slice(2),seedSession:process.env.DOUBAO_E2E_SEED_SESSION||null,existingSession:process.env.DOUBAO_E2E_EXISTING_SESSION||null};
const manifestFile=path.join(out,'manifest.json');
if(fs.existsSync(manifestFile))assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)),manifest,'candidate or invocation changed; use a new output directory');
else{assert.equal(fs.readdirSync(out).filter(f=>f.endsWith('.json')||f.endsWith('.pending')).length,0,'existing receipts lack manifest; preserve them and use a new output directory');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{mode:0o600});}

const config=path.join(out,'config'),workspace=path.join(out,'workspace');
for(const dir of [config,workspace])fs.mkdirSync(dir,{recursive:true,mode:0o700});
const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2),{mode:0o600});
const rows=[];
async function call(name,args,validate=()=>{},expected=0){
 const file=path.join(out,name+'.json');let r;const cached=fs.existsSync(file);
 if(fs.existsSync(file))r=JSON.parse(fs.readFileSync(file));
 else {
  const pending=path.join(out,name+'.pending');assert(!fs.existsSync(pending),'uncertain invocation: '+name);fs.writeFileSync(pending,'started',{mode:0o600});
  r=await new Promise(resolve=>{const c=spawn(process.execPath,[cli,'--app','work','--json',...args],{env:{...process.env,DOUBAO_CLI_CONFIG_DIR:config,DOUBAO_CLI_DISABLE_AUTO_UPDATE:'1'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',d=>stdout+=d);c.stderr.on('data',d=>stderr+=d);const timer=setTimeout(()=>c.kill('SIGTERM'),360000);c.on('close',code=>{clearTimeout(timer);let data;try{data=JSON.parse(stdout)}catch{}resolve({code,data,stdout,stderr})});});
  write(name+'.json',r);fs.unlinkSync(pending);
 }
 let error;try{assert.equal(r.code,expected);await validate(r.data,r);}catch(e){error=e.message;}
 rows.push({name,pass:!error,error,cached});write('summary.json',rows);console.log(JSON.stringify({name,pass:!error}));
 if(args[0]==='sessions'&&args[1]==='create'&&r.data?.conversationId)session=r.data.conversationId;
 if(args[0]==='sessions'&&['create','send'].includes(args[1])&&args.includes('--wait')&&r.data?.runId&&!['completed','cancelled','failed'].includes(r.data.status))throw new Error('Accepted run is unresolved; recover the saved run before further submissions');
 return {...r,pass:!error};
}
const inspect=expr=>withApp(resolveApp('work'),()=>withChatClient(c=>c.evaluate(expr)));
const navigate=url=>withApp(resolveApp('work'),()=>withChatClient(c=>c.send('Page.navigate',{url})));
const initialFile=path.join(out,'initial.json');
const initial=fs.existsSync(initialFile)?JSON.parse(fs.readFileSync(initialFile)):await inspect(`({href:location.href,draft:document.querySelector('[contenteditable="true"]')?.innerText||''})`);write('initial.json',initial);
assert.equal(initial.draft.trim(),'','existing draft must be preserved');
let session,connector,ownedProject;
try{
 const seed=process.env.DOUBAO_E2E_SEED_SESSION;
 if(seed){await call('open-owned-preflight',['sessions','open',seed],d=>assert(d.opened));await new Promise(r=>setTimeout(r,2500));}
 const status=await call('status',['status'],d=>assert(d.running));
 await call('profile-directory',['status','--profile',status.data.profile.directory],d=>assert.equal(d.profile.directory,status.data.profile.directory));
 await call('profiles',['profiles'],d=>assert(d.profiles.length));
 await call('capabilities',['capabilities'],d=>assert(d.cdp.available));
 await call('usage',['usage'],d=>assert(d));
 await call('runtimes',['runtimes'],d=>assert(d));
 await call('cdp-status',['cdp','status'],d=>assert(d.available));
 await call('cdp-launch-ready',['cdp','launch'],d=>{assert(d.available);assert.notEqual(d.restarted,true)});
 await call('cdp-launch-yes-ready',['cdp','launch','--yes'],d=>{assert(d.available);assert.notEqual(d.restarted,true)});
 await call('sessions-list-limit',['sessions','list','--limit','1'],d=>assert.equal(d.sessions.length,1));
 await call('sessions-list-archived',['sessions','list','--archived','--limit','1'],d=>assert(d.sessions));
 const models=await call('models',['models'],d=>assert(d.models.length));
 await call('model-current',['model','current'],d=>assert(d.id));
 assert(models.pass,'Model catalog failed; downstream selections cannot run');
 const model=models.data.models.find(m=>m.name==='GPT-6 Astra')||models.data.models.find(m=>!/^auto$|自动/i.test(m.name));
 const schema=path.join(out,'schema.json');write('schema.json',{type:'object',required:['marker'],properties:{marker:{type:'string',enum:['E2E_DESKTOP_OK']}}});
 let create;
 if(stage==='modules'&&process.env.DOUBAO_E2E_EXISTING_SESSION){create={pass:true,data:{conversationId:process.env.DOUBAO_E2E_EXISTING_SESSION}};}
 else create=await call('create-schema',['sessions','create','Do not use tools. Reply exactly {"marker":"E2E_DESKTOP_OK"}.','--mode','goal','--runtime','local','--permission','AskOnRisk','--workspace',workspace,'--no-skills','--model',model.name,'--reasoning','low','--wait','--expect-json','--reply-schema',schema,'--timeout','300'],d=>{assert.equal(d.status,'completed');assert(d.replyValid);});
 session=create.data?.conversationId;assert(create.pass&&session,'create receipt lacks session ID; stop without resending');
 await call('open',['sessions','open',session],d=>assert(d.opened));
 await new Promise(r=>setTimeout(r,2000));
 const current=await call('current',['sessions','current'],d=>assert.equal(d.id,session));assert(current.pass,'Refusing model changes outside the owned test session');
 await call('read',['sessions','read',session],d=>assert(d.messages.some(m=>m.text?.includes('E2E_DESKTOP_OK'))));
 await call('read-limit',['sessions','read',session,'--limit','1'],d=>assert.equal(d.messages.length,1));
 if(create.data.runId){
 await call('status-run',['sessions','status',session,'--run',create.data.runId],d=>assert.equal(d.status,'completed'));
 await call('wait-schema',['sessions','wait',session,'--run',create.data.runId,'--expect-json','--reply-schema',schema],d=>assert(d.replyValid));
 }
 if(stage==='modules'){await call('reasoning-low-recheck',['model','reasoning','low'],d=>assert.equal(d.reasoning,'low'));await call('reasoning-low-recheck-read',['model'],d=>assert.equal(d.reasoning,'低'));}
 if(stage==='all'){
 for(const m of models.data.models){await call('select-'+m.id,['model','select',m.name],d=>assert.equal(d.id,m.id));await call('selected-'+m.id,['model'],d=>assert.equal(d.id,m.id));}
 for(const [level,label] of [['low','低'],['medium','中'],['high','高'],['xhigh','极高'],['max','最高']]){await call('reasoning-'+level,['model','reasoning',level],d=>assert.equal(d.reasoning,level));await call('reasoning-read-'+level,['model'],d=>assert.equal(d.reasoning,label));}
 await call('select-reasoning',['model','select',model.name,'--reasoning','low'],d=>assert.equal(d.reasoning,'low'));
 await call('literal-send',['sessions','send',session,'--wait','--timeout','300','--','--model is literal. Do not use tools. Reply exactly LITERAL_OK.'],d=>assert(d.reply.text.includes('LITERAL_OK')));
 }
 for(const [name,text] of [['first.txt','ATTACH_ONE'],['second.txt','ATTACH_TWO']])fs.writeFileSync(path.join(out,name),text,{mode:0o600});
 await call('attachments',['sessions','send',session,'Read both attachments and reply only with their two markers. Do not use other tools.','--attach',path.join(out,'first.txt'),'--attach',path.join(out,'second.txt'),'--wait','--timeout','300'],d=>{assert(d.reply.text.includes('ATTACH_ONE'));assert(d.reply.text.includes('ATTACH_TWO'));assert.equal(d.attachments.length,2)});
 await call('attachments-read',['sessions','read',session],d=>assert(d.messages.some(m=>m.attachments?.includes('first.txt'))));
 const project=await call('project-create',['projects','create','CLI E2E Desktop 20261029','--workspace',workspace],d=>assert(d.id));
 if(project.pass)ownedProject=project.data;
 if(project.pass)await call('project-list',['projects','list'],d=>assert((d.projects||d).some(p=>p.id===project.data.id)));
 if(project.pass)await call('enterprise',['sessions','send',session,'Do not search or use tools. Reply exactly ENTERPRISE_OK.','--project',project.data.id,'--enterprise-knowledge','--wait','--timeout','300'],d=>{assert.equal(d.status,'completed');assert(d.reply.text.includes('ENTERPRISE_OK'));assert.equal(d.context.projectId,project.data.id);assert.equal(d.context.enterpriseKnowledge,true)});
 const log=path.join(out,'mcp-calls.jsonl');
 const reg=await call('mcp-register',['mcp','register','cli-e2e-desktop-20261029','--command',process.execPath,'--arg',path.resolve('scripts/fixtures/mcp-server.mjs'),'--arg','--synthetic','--arg','value','--env','DOUBAO_E2E_LOG='+log,'--env','DOUBAO_E2E_MARKER=DESKTOP_E2E'],d=>{assert(d.connectorId);assert.equal(d.status,'READY')});
 connector=reg.data?.connectorId;
 if(connector&&reg.pass){
 await call('mcp-list',['mcp','list'],d=>assert((d.connectors||d).some(c=>c.connectorId===connector&&c.enabled)));
 await call('mcp-call',['sessions','send',session,'Call doubao_e2e_ping exactly once with message DESKTOP_MCP_OK and reply with the pong result. Do not use other tools.','--mcp',connector,'--runtime','local','--permission','AskOnRisk','--workspace',workspace,'--no-skills','--wait','--timeout','300'],d=>{assert(d.reply.text.includes('pong: DESKTOP_MCP_OK'));const events=fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(JSON.parse);assert(events.some(r=>r.event==='call'&&r.message==='DESKTOP_MCP_OK'));const start=events.find(r=>r.event==='start');assert.deepEqual(start.args,['--synthetic','value']);assert.equal(start.marker,'DESKTOP_E2E')});
 }
 if(stage==='all'){
 const long=await call('send-no-wait',['sessions','send',session,'Do not use tools. Write a numbered list of 1500 imaginary fruit names.','--model',model.name,'--reasoning','low'],d=>{assert(d.runId);assert.equal(d.reply,null)});
 if(long.data?.runId){await call('stop-run',['sessions','stop',session,'--run',long.data.runId,'--timeout','60'],d=>assert(d.stopped));await call('stop-status',['sessions','status',session,'--run',long.data.runId],d=>assert(['cancelled','failed','completed'].includes(d.status)));}
 }
}finally{
 const cleanup=async(name,fn)=>{try{await fn();}catch(error){rows.push({name,pass:false,error:error.message});}};
 if(connector)await cleanup('cleanup-mcp',()=>call('mcp-remove',['mcp','remove',connector],d=>assert(d.removed)));
 if(connector)await cleanup('cleanup-mcp-read',()=>call('mcp-removed-read',['mcp','list'],d=>assert(!(d.connectors||d).some(c=>c.connectorId===connector&&c.enabled))));
 if(session)await cleanup('cleanup-archive',()=>call('archive',['sessions','archive',session],d=>assert(d.verified)));
 if(ownedProject)await cleanup('cleanup-project',()=>withApp(resolveApp('work'),()=>withChatClient(async c=>{
  const before=await listProjects(c);const found=before.find(p=>p.id===ownedProject.id);
  if(found){assert.equal(found.name,ownedProject.name);const receipt=path.join(out,'project-cleanup.json');assert(!fs.existsSync(receipt),'cleanup previously attempted; inspect before retry');write('project-cleanup.json',{phase:'started',id:ownedProject.id});
   const result=await c.evaluate(`(async()=>{const req=await new Promise(resolve=>window['@flow-web/desktop:stable'].push([['cleanup_'+crypto.randomUUID()],{},resolve]));${APP_MODULE_BOOTSTRAP} return appModule(req,'projects').th().deleteProject(${JSON.stringify({projectId:ownedProject.id,isKicked:false})},${JSON.stringify({operationId:randomUUID()})})})()`);
   const absent=!(await listProjects(c)).some(p=>p.id===ownedProject.id);write('project-cleanup.json',{phase:'completed',id:ownedProject.id,result,absent});assert(absent);
  }
 })));
 await cleanup('restore-page',()=>navigate(initial.href));
 write('summary.json',rows);
 if(rows.some(r=>!r.pass))process.exitCode=1;
}
