#!/usr/bin/env node
// Opt-in real-account supplement. Requires an isolated config and an already
// created synthetic conversation. Every response is private and persisted before
// the next operation; failed/uncertain operations are never automatically retried.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {bindLiveManifest} from './e2e-live-manifest.mjs';
const exec=promisify(execFile);
const options=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>i%2?a:[...a,[x.replace(/^--/,''),v[i+1]]],[]));
for(const key of ['cli','config','output','conversation','run']) if(!options[key]) throw new Error(`--${key} required`);
const out=path.resolve(options.output);
await bindLiveManifest(out,{cli:options.cli,config:options.config,conversation:options.conversation,run:options.run,suite:'headless-commands-v2'});
const env={...process.env,DOUBAO_CLI_CONFIG_DIR:path.resolve(options.config),DOUBAO_CLI_DISABLE_AUTO_UPDATE:'1'};
delete env.DOUBAO_HEADLESS_COOKIE;
const save=(name,data)=>fs.writeFile(path.join(out,name+'.json'),JSON.stringify(data,null,2),{mode:0o600});
const summary=[];
async function step(name,args,check=()=>{}) {
 const file=path.join(out,name+'.json'); let result; let cached=false;
 try {result=JSON.parse(await fs.readFile(file,'utf8'));cached=true;} catch(error) {
  if(error.code!=='ENOENT')throw error;
  const intent=path.join(out,name+'.intent');
  try {await fs.writeFile(intent,new Date().toISOString(),{flag:'wx',mode:0o600});} catch {throw new Error(`${name}: prior uncertain attempt; inspect private receipt`);}
  try { const {stdout}=await exec(process.execPath,[options.cli,'headless',...args,'--json'],{env,timeout:340000,maxBuffer:8*1024*1024});result=JSON.parse(stdout);await save(name,result); }
  catch(error){await save(name+'-failure',{code:error.code,stdout:error.stdout,stderr:error.stderr});throw new Error(`${name}: failed; inspect private receipt`);}
 }
 check(result); summary.push({name,status:'passed',cached});await save('summary',summary); console.log('PASS '+name);return result;
}
const id=options.conversation,run=options.run;
try {
await step('open',['sessions','open',id],x=>assert.equal(x.id,id));
await step('current',['sessions','current'],x=>assert.equal(x.id,id));
await step('read',['sessions','read',id,'--limit','5'],x=>{assert.equal(x.conversationId,id);assert(Array.isArray(x.messages));assert(x.messages.length>0&&x.messages.length<=5);assert(x.messages.some(m=>m.role==='assistant'&&typeof m.text==='string'&&m.text.length>0));});
await step('status',['sessions','status',id,'--run',run],x=>assert.equal(x.status,'completed'));
await step('stop-terminal',['sessions','stop',id,'--run',run],x=>assert.equal(x.stopped,true));
const current=await step('model-current',['model','current']);
const models=await step('models',['models']);
const selected=models.models.find(x=>x.available&&x.modes?.includes('work')&&x.name!==current.name)||models.models.find(x=>x.available&&x.modes?.includes('work'));
assert(selected);
try {
 await step('model-select',['model','select',selected.name,'--reasoning','low'],x=>assert.equal(x.changed,true));
 await step('model-selected-readback',['model'],x=>{assert.equal(x.id,selected.id);assert.equal(x.reasoning,'low');});
 await step('model-reasoning',['model','reasoning','medium'],x=>assert.equal(x.changed,true));
 await step('model-reasoning-readback',['model','current'],x=>assert.equal(x.reasoning,'medium'));
} finally {
 if(current.name) {
  await step('model-restore',['model','select',current.name,...(current.reasoning?['--reasoning',current.reasoning]:[])],x=>assert.equal(x.changed,true));
  await step('model-restore-readback',['model','current'],x=>{assert.equal(x.id,current.id);if(current.reasoning)assert.equal(x.reasoning,current.reasoning);});
 }
}
for(const action of ['rename','pin','unpin','archive','unarchive']) {
 await step(action,['sessions',action,id,...(action==='rename'?['CLI E2E test']:[])],x=>assert.equal(x.verified,true));
}
await step('project-list',['projects','list']);
const workspace=path.join(out,'project-workspace');await fs.mkdir(workspace,{recursive:true,mode:0o700});
const project=await step('project-create',['projects','create','CLI E2E Headless '+path.basename(out).slice(-8),'--workspace',workspace],x=>assert(x.id));
await step('project-create-readback',['projects','list'],x=>assert(x.projects.some(p=>p.id===project.id&&p.folders.some(f=>JSON.stringify(f).includes(workspace)))));
await step('move-project',['sessions','move',id,project.id],x=>assert.equal(x.verified,true));
await step('move-none',['sessions','move',id,'none'],x=>assert.equal(x.verified,true));
await step('final-archive',['sessions','archive',id],x=>assert.equal(x.verified,true));
await step('archived-list',['sessions','list','--archived','--all','--timeout','180'],x=>assert(x.sessions.some(s=>s.id===id)));
await step('draft',['sessions','create'],x=>assert.equal(x.conversationId,null));
console.log('PASS supplemental commands; project retained because CLI has no project-delete command');

} finally {
 const cleanup=[];
 for(const action of ['unpin','move','archive']) {
  try {
   const {stdout}=await exec(process.execPath,[options.cli,'headless','sessions',action,id,...(action==='move'?['none']:[]),'--json'],{env,timeout:60000,maxBuffer:1024*1024});
   const data=JSON.parse(stdout);cleanup.push({action,verified:data.verified===true});
  } catch(error) {cleanup.push({action,verified:false,exitCode:error.code});}
 }
 await save('cleanup-'+Date.now(),cleanup);
 if(cleanup.some(x=>!x.verified)) {console.error('Synthetic session cleanup is incomplete; inspect private cleanup receipt');process.exitCode=1;}
}
