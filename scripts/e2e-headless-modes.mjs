#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {bindLiveManifest} from './e2e-live-manifest.mjs';
const opt=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>i%2?a:[...a,[x.slice(2),v[i+1]]],[]));
for(const k of ['cli','config','output'])if(!opt[k])throw new Error('--'+k+' required');
await bindLiveManifest(opt.output,{cli:opt.cli,config:opt.config,suite:'headless-modes-v2'});
const env={...process.env,DOUBAO_CLI_CONFIG_DIR:opt.config,DOUBAO_CLI_DISABLE_AUTO_UPDATE:'1'};delete env.DOUBAO_HEADLESS_COOKIE;
const exec=promisify(execFile),summary=[],owned=new Map();
function track(result,args){if(args[0]==='sessions'&&args[1]==='create'&&result.data?.conversationId&&result.data?.runId)owned.set(result.data.conversationId,result.data.runId);return result;}
const save=(n,v)=>fs.writeFile(path.join(opt.output,n+'.json'),JSON.stringify(v,null,2),{mode:0o600});
async function run(n,args){
 const file=path.join(opt.output,n+'.json');try{const saved=JSON.parse(await fs.readFile(file,'utf8'));console.log('RESUMED '+n);return track(saved,args);}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.writeFile(path.join(opt.output,n+'.intent'),new Date().toISOString(),{mode:0o600,flag:'wx'});
 let r;try{const x=await exec(process.execPath,[opt.cli,'headless',...args,'--json'],{env,timeout:330000,maxBuffer:8*1024*1024});r={code:0,data:JSON.parse(x.stdout)};}catch(e){let d;try{d=JSON.parse(e.stdout);}catch{}r={code:e.code,data:d,stderr:e.stderr};}
 await save(n,r);return track(r,args);
}
async function scenario(name,fn){try{await fn();summary.push({name,status:'passed'});}catch(e){summary.push({name,status:'failed',reason:e.message});}await save('summary',summary);console.log(JSON.stringify(summary.at(-1)));}
const complete=x=>{assert.equal(x.code,0);assert.equal(x.data.status,'completed');};
const archive=async(name,id)=>{if(id){const x=await run(name+'-archive',['sessions','archive',id]);assert.equal(x.data?.verified,true);}};
try {
for(const [name,flags] of [['chat',['--mode','chat']],['goal',['--mode','goal','--runtime','cloud']],['enterprise',['--runtime','cloud','--enterprise-knowledge']]]){
 await scenario(name,async()=>{const r=await run(name,['sessions','create','Do not use tools or external knowledge. Reply exactly E2E_OK.',...flags,'--wait','--timeout','240']);try{complete(r);assert.equal(r.data.reply?.text?.trim(),'E2E_OK');if(name==='enterprise')assert.equal(r.data.context.enterpriseKnowledge,true);}finally{if(r.data?.status==='completed')await archive(name,r.data.conversationId);}});
}
await scenario('background-read',async()=>{
 const dir=path.join(opt.output,'background-workspace');await fs.mkdir(dir,{recursive:true,mode:0o700});
 const markerFile=path.join(dir,'probe.txt');let marker;try{marker=await fs.readFile(markerFile,'utf8');}catch{marker=randomUUID();await fs.writeFile(markerFile,marker,{mode:0o600});}
 const accepted=await run('background-create',['sessions','create','Use only Read to read probe.txt in this workspace. Return its entire contents exactly, without extra text.','--runtime','local','--workspace',dir,'--no-skills','--permission','AskOnRisk','--timeout','240']);
 assert.equal(accepted.code,0);assert.equal(accepted.data.accepted,true);
 const {conversationId:id,runId}=accepted.data;
 const waited=await run('background-wait',['sessions','wait',id,'--run',runId,'--timeout','300']);complete(waited);assert.equal(waited.data.reply?.text?.trim(),marker);
 await archive('background',id);
});
await scenario('active-stop',async()=>{
 const accepted=await run('stop-create',['sessions','create','Write a detailed 10000 word explanation of prime numbers. Do not use tools.','--runtime','cloud','--timeout','120']);assert.equal(accepted.code,0);assert.equal(accepted.data.accepted,true);
 const {conversationId:id,runId}=accepted.data;
 const before=await run('stop-before',['sessions','status',id,'--run',runId]);
 const stop=await run('stop-active',['sessions','stop',id,'--run',runId,'--timeout','120']);assert.equal(stop.data?.stopped,true);
 const after=await run('stop-readback',['sessions','status',id,'--run',runId]);assert(['cancelled','completed','failed'].includes(after.data?.status));
 await save('stop-evidence',{before:before.data?.status,after:after.data?.status,stopped:stop.data.stopped,cancellationProven:after.data?.status==='cancelled'});await archive('stop',id);
});

await scenario('cancel-running-tool',async()=>{
 const accepted=await run('cancel-create',['sessions','create','For this cancellation test, use the cloud Python tool to sleep for 90 seconds, then reply CANCEL_TEST_DONE. Do not read or write files or access the network.','--runtime','cloud','--timeout','120']);assert.equal(accepted.code,0);assert.equal(accepted.data.accepted,true);
 const {conversationId:id,runId}=accepted.data;
 const stop=await run('cancel-immediate',['sessions','stop',id,'--run',runId,'--timeout','120']);assert.equal(stop.data?.stopped,true);
 const after=await run('cancel-readback',['sessions','status',id,'--run',runId]);
 await save('cancel-evidence',{accepted:accepted.data.status,after:after.data?.status,stopped:stop.data.stopped,cancellationProven:after.data?.status==='cancelled'});await archive('cancel',id);
 assert.equal(after.data?.status,'cancelled');
});

if(summary.some(x=>x.status!=='passed'))process.exitCode=1;

} finally {
 const cleanup=[];
 async function cleanupCall(args){
  const {stdout}=await exec(process.execPath,[opt.cli,'headless',...args,'--json'],{env,timeout:150000,maxBuffer:1024*1024});return JSON.parse(stdout);
 }
 for(const [id,runId] of owned) {
  try {
   const before=await cleanupCall(['sessions','status',id,'--run',runId]);
   let terminal=['completed','cancelled','failed'].includes(before.status);
   if(!terminal){const stopped=await cleanupCall(['sessions','stop',id,'--run',runId,'--timeout','120']);terminal=stopped.stopped===true;}
   if(!terminal)throw new Error('owned run not terminal');
   const archived=await cleanupCall(['sessions','archive',id]);cleanup.push({id,terminal,archived:archived.verified===true});
  }catch(error){cleanup.push({id,terminal:false,archived:false,error:error.code||'cleanup_failed'});}
 }
 await save('cleanup-'+Date.now(),cleanup);
 if(cleanup.some(x=>!x.terminal||!x.archived)){process.exitCode=1;console.error('Synthetic task cleanup incomplete; inspect private receipt');}
}
