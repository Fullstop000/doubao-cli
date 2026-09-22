import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeTurn, messageState, taskLinks, readTurn, stopTurn, followTaskStreams, waitTurn, receiptStore } from '../src/turns.mjs';
import { updateLiveControls } from '../src/protocol.mjs';
import { withApp, resolveApp } from '../src/app.mjs';
const id = '38442602625749250', runId = '56322687642882050';
const root = { user_type: 1, message_id: runId, index_in_conv: '1' };
const text = value => ({ block_type: 10000, content: { text_block: { text: value } } });
const task = thread => ({ block_type: 10090, content: { complex_task_block: { thread_id: thread, display_type: 'organizer' } } });
const reply = (index, blocks, extra = {}) => ({ message_id: String(56310000000000000n + BigInt(index)), index_in_conv: String(index), user_type: 2, bot_reply_message_id: runId, content_block: blocks, ext: { is_finish: '1' }, ...extra });

test('does not finish on a delegation message even after child completion; selects final summary', () => {
 const first = reply(2, [text('delegated'), task('thread')]);
 const nodes = [{ threadId:'thread', status:'completed', messages:[] }];
 assert.equal(summarizeTurn(id,root,[first],nodes).status,'running');
 const final = reply(3,[task('thread'),text('final result')]);
 const result=summarizeTurn(id,root,[first,final],nodes);
 assert.equal(result.status,'completed'); assert.equal(result.reply.text,'final result');
 assert.equal(summarizeTurn(id,root,[first,final],[{...nodes[0],status:'running'}]).status,'running');
});
test('turns are isolated by server question id and use exact integer message ordering',()=>{
 const a=reply('9007199254740994',[text('latest')]);
 const b=reply('9007199254740993',[text('older')]);
 const other=reply('9007199254740995',[text('other turn')],{bot_reply_message_id:'999'});
 assert.equal(summarizeTurn(id,root,[a,other,b],[]).reply.text,'latest');
});
test('pending input, failure and cancellation do not become successful replies',()=>{
 const ask=reply(2,[{block_type:10080,content:{interaction_ask_block:{status:1,clarify_id:'q',questions:[{title:'Choose'}]}}}]);
 const pending=summarizeTurn(id,root,[ask],[]);assert.equal(pending.status,'waiting_input');assert.equal(pending.pending.length,1);assert.equal(pending.reply,null);
 assert.equal(messageState(reply(2,[],{content_status:500})),'failed');
 assert.equal(messageState(reply(2,[],{ext:{async_job:'{"status":4}'}})),'cancelled');
});
test('task links merge repeated cards and hidden progress is omitted',()=>{
 assert.equal(taskLinks([reply(2,[task('x')]),reply(3,[task('x')])]).length,1);
 const p={...text('planning'),control_info:{collapse_block_id:'elapsed'}};
 assert.equal(summarizeTurn(id,root,[reply(2,[p,text('answer')])],[]).reply.text,'answer');
});
function clientFor(handler) {
 const context=vm.createContext({URL,crypto,AbortSignal,AbortController,TextDecoder,setTimeout,clearTimeout,
 performance:{getEntriesByType:()=>[{name:'https://www.doubao.com/im/chain/recent_conv?aid=1044603&device_id=test'}]},
 window:{'@flow-web/desktop:stable':{push:parts=>{const req=()=>({iv:{AGWTaskTerminate:async body=> (await handler('https://www.doubao.com/alice/generaltask/terminate',{body:JSON.stringify(body)})).json()}});req.e=async()=>{};parts[2](req);}},neotix:{taskMode:{runtime:{queryRuntimeInfo:async()=>({env:{}})}}}},
 fetch:handler});
 return {evaluate:e=>vm.runInContext(e,context),close(){}};
}
test('read rejects an unavailable requested run instead of selecting a newer turn',async()=>{
 const client=clientFor(async()=>Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:[root]}]}}}));
 await withApp(resolveApp('work',{}),()=>assert.rejects(readTurn(client,id,{runId:'56322687642882051'}),/requested turn/));
});
test('cancellation uses run id and thread terminate, then verifies child status',async()=>{
 let cancelled=false;const calls=[];
 const first=reply(2,[text('working'),task('56320433759901186')]);
 const client=clientFor(async(url,options)=>{
 const body=JSON.parse(options.body);calls.push({url,body});
 if(url.includes('/generaltask/terminate')){cancelled=true;return Response.json({code:0});}
 if(url.includes('break_stream_msg'))return Response.json({status_code:0});
 if(url.includes('batch_get'))return Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,conversation_type:3,messages:[root,first]}]}}});
 if(url.includes('thread/info'))return Response.json({downlink_body:{get_thread_info_downlink_body:{thread_info:{source_conversation_id:id,ext:{thread_status:cancelled?'cancelled':'running'}}}}});
 return Response.json({downlink_body:{pull_thread_message_chain_downlink_body:{messages:[],has_more:false}}});
 });
 const result=await withApp(resolveApp('work',{}),()=>stopTurn(client,id,{runId,timeoutMs:1000}));
 assert.equal(result.stopped,true);assert.equal(result.status,'cancelled');
 assert.equal(calls.find(c=>c.url.includes('break_stream_msg')).body.uplink_body.break_stream_msg_uplink_body.reply_msg_id,runId);
 assert.equal(calls.filter(c=>c.url.includes('/generaltask/terminate')).length,1);
});
test('async stream reconnects with its cursor, follows children and never resubmits completion',async()=>{
 const requests=[];let attempts=0;
 const sse=(id,event,data)=>`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
 const client=clientFor(async(url,options)=>{
 assert.ok(url.includes('/chat/async/chunk_stream'));
 const body=JSON.parse(options.body);requests.push(body);
 if(body.task_id==='parent'&&attempts++===0)return new Response(sse(1,'FETCH_STREAM',{fetch_type:2,fetch_key:'child',append_scene:6}));
 return new Response(sse(2,'SSE_REPLY_END',{end_type:3}));
 });
 const receipt={handoffs:[{taskId:'parent',appendScene:7,seq:0}]};
 await withApp(resolveApp('work',{}),()=>followTaskStreams(client,receipt,2000));
 assert.deepEqual(requests.filter(r=>r.task_id==='parent').map(r=>r.seq_start),[0,1]);
 assert.equal(requests.filter(r=>r.task_id==='child').length,1);
 assert.equal(receipt.handoffs.every(t=>t.completed),true);
});

test('approval controls block completion while reply suggestions do not', () => {
 const quick=(scene,status=1)=>reply(2,[{block_id:'approval',content:{quick_reply_block:{scene,status,items:[{text:'Allow'}]}}}]);
 assert.equal(summarizeTurn(id,root,[quick(2)],[]).status,'waiting_input');
 assert.equal(summarizeTurn(id,root,[quick(3)],[]).status,'completed');
 assert.equal(summarizeTurn(id,root,[quick(2,2)],[]).status,'completed');
 const answered={...quick(2,2),index_in_conv:'3'};
 assert.equal(summarizeTurn(id,root,[quick(2),answered],[]).pending.length,0);
});
test('waiting timeout preserves run id and never requests cancellation', async () => {
 const calls=[];
 const client=clientFor(async(url,options)=>{
  calls.push(url);
  return Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:[root,reply(2,[text('working')],{content_status:100})]}]}}});
 });
 await withApp(resolveApp('work',{}),()=>assert.rejects(waitTurn(client,id,{runId,timeoutMs:15}),e=>{
  assert.equal(e.code,'timeout');assert.equal(e.result.runId,runId);assert.equal(e.result.status,'running');assert.equal(e.result.reply,null);return true;
 }));
 assert.ok(calls.every(url=>url.includes('batch_get')));
});
test('wait pins the selected run even if another user message arrives', async()=>{
 let calls=0;
 const newer={...root,message_id:'56322687642882051',index_in_conv:'9'};
 const client=clientFor(async()=>{
  calls++;
  return Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:[root,reply(2,[text(calls===1?'working':'original final')],{content_status:calls===1?100:0}),...(calls>1?[newer]:[])]}]}}});
 });
 const result=await withApp(resolveApp('work',{}),()=>waitTurn(client,id,{timeoutMs:2000}));
 assert.equal(result.runId,runId);assert.equal(result.reply.text,'original final');
});
test('ACK persistence delay is retried without sending another message', async()=>{
 let calls=0;
 const client=clientFor(async()=>Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:++calls===1?[]:[root,reply(2,[text('done')])]}]}}}));
 const result=await withApp(resolveApp('work',{}),()=>waitTurn(client,id,{runId,timeoutMs:2000}));
 assert.equal(result.runId,runId);assert.equal(calls,2);
});
test('receipt scope is stable for implicit/explicit profile and separates accounts/apps', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'doubao-turns-'));
 const old=process.env.DOUBAO_CLI_CONFIG_DIR;process.env.DOUBAO_CLI_CONFIG_DIR=dir;
 fs.writeFileSync(path.join(dir,'Local State'),JSON.stringify({profile:{last_used:'Profile 1'}}));
 const app={...resolveApp('work',{}),dataDir:dir};
 const client={evaluate:async()=> 'synthetic-user'};
 try {
  const first=await withApp(app,()=>receiptStore(client));first.save({conversationId:id,runId,handoffs:[{taskId:'job',seq:3}]});
  const explicit=await withApp({...app,profile:'Profile 1'},()=>receiptStore(client));
  assert.equal(explicit.read(id,runId).handoffs[0].seq,3);
  const other=await withApp({...app,id:'doubao'},()=>receiptStore(client));assert.deepEqual(other.read(id,runId),{});
  const account=await withApp(app,()=>receiptStore({evaluate:async()=> 'another-user'}));assert.deepEqual(account.read(id,runId),{});
 } finally { if(old===undefined)delete process.env.DOUBAO_CLI_CONFIG_DIR;else process.env.DOUBAO_CLI_CONFIG_DIR=old;fs.rmSync(dir,{recursive:true,force:true}); }
});

test('live task cards and input controls survive delayed IM persistence', async()=>{
 const state={};
 updateLiveControls(state,'STREAM_MSG_NOTIFY',{meta:{message_id:reply(2,[]).message_id,thread_id:'0'},content:{content_block:[]}});
 const ask={block_id:'question',block_type:10080,content:{interaction_ask_block:{status:1,questions:[{title:'choose'}]}}};
 assert.equal(updateLiveControls(state,'STREAM_CHUNK',{message_id:reply(2,[]).message_id,patch_op:[{patch_value:{content_block:[ask]}}]}),true);
 const client=clientFor(async()=>Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:[root,reply(2,[],{content_status:100})]}]}}}));
 const snapshot=await withApp(resolveApp('work',{}),()=>readTurn(client,id,{runId,receipt:{liveMessages:state.liveMessages}}));
 assert.equal(snapshot.result.status,'waiting_input');assert.equal(snapshot.result.pending[0].questions[0].title,'choose');
});
test('persisted resolved controls override stale live pending controls', async()=>{
 const message=reply(2,[{block_id:'q',block_type:10080,content:{interaction_ask_block:{status:2}}},text('done')]);
 const live={...message,content_block:[{block_id:'q',block_type:10080,content:{interaction_ask_block:{status:1}}}]};
 const client=clientFor(async()=>Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:[root,message]}]}}}));
 const snapshot=await withApp(resolveApp('work',{}),()=>readTurn(client,id,{runId,receipt:{liveMessages:[live]}}));
 assert.equal(snapshot.result.status,'completed');assert.deepEqual(snapshot.result.pending,[]);
});

test('recovery keeps the original unique key and local id and sets is_recovery', async()=>{
 const request={client_meta:{conversation_id:id},messages:[{local_message_id:'accepted-local',content_block:[text('hello')]}],option:{unique_key:'accepted-key',recovery_option:{is_recovery:false,req_create_time_sec:1790070000,append_sse_event_scene:0}}};
 const {sendChatCompletion}=await import('../src/protocol.mjs');let actual;
 const client=clientFor(async(url,options)=>{
  actual=JSON.parse(options.body);
  return new Response(`event: SSE_ACK\ndata: ${JSON.stringify({ack_client_meta:{conversation_id:id},query_list:[{question_id:runId}]})}\n\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n`);
 });
 const result=await withApp(resolveApp('work',{}),()=>sendChatCompletion(client,{conversationId:id,runId,localMessageId:'accepted-local',model:{},resumeRequest:request,timeoutMs:1000}));
 assert.equal(result.runId,runId);assert.equal(actual.option.unique_key,'accepted-key');assert.equal(actual.messages[0].local_message_id,'accepted-local');assert.equal(actual.option.recovery_option.is_recovery,true);
});
test('confirmed cancellation overrides server success without exposing a successful reply',()=>{
 const result=summarizeTurn(id,root,[reply(2,[text('task cancelled')])],[],{cancellation:{confirmed:true}});
 assert.equal(result.status,'cancelled');assert.equal(result.reply,null);
});
test('artifact blocks are separate from the final main reply and deduplicated',()=>{
 const artifact={block_id:'file-1',content:{artifact_code_file_block:{name:'result.md',content:'# Test'}}};
 const result=summarizeTurn(id,root,[reply(2,[text('final'),artifact])],[{threadId:'child',status:'completed',messages:[reply(1,[artifact])]}]);
 assert.equal(result.reply.text,'final');assert.equal(result.artifacts.length,1);assert.equal(result.artifacts[0].content.name,'result.md');
});

test('answered inputs stop blocking a still-running task', async()=>{
 const message=reply(2,[{block_id:'q',block_type:10080,content:{interaction_ask_block:{status:2}}}],{content_status:100});
 const live={...message,content_block:[{block_id:'q',block_type:10080,content:{interaction_ask_block:{status:1}}}]};
 const client=clientFor(async()=>Response.json({downlink_body:{batch_get_conv_info_downlink_body:{conversation_info_list:[{conversation_id:id,messages:[root,message]}]}}}));
 const snapshot=await withApp(resolveApp('work',{}),()=>readTurn(client,id,{runId,receipt:{liveMessages:[live]}}));
 assert.equal(snapshot.result.status,'running');assert.deepEqual(snapshot.result.pending,[]);
});
