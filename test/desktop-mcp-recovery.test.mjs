import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const source = new URL('../src/', import.meta.url).href;

// Exercise the real automation entry points. Native submission and server turn
// tracking are controlled boundaries; direct tool execution and local SSE are
// forbidden so recovery cannot accidentally introduce a second executor.
function scenario(code) {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    const root=${JSON.stringify(source)};
    const conversationId='1234567890123456',runId='2345678901234567';
    const accepted={conversationId,runId,localMessageId:'accepted-local',handoffs:[],liveMessages:[],
      requestBody:{option:{general_task_param:{runtime_type:2,
        client_option:{sandbox_id:'accepted-sandbox',sandbox_auth_type:2},
        task_input_json:JSON.stringify({localConnectors:[{connectorId:'selected',mcpToolsList:[{name:'echo'}]}]})}}}};
    const state={sends:[],waits:[],reads:[],saved:[],receiptReads:[],receipts:new Map(),
      sendError:null,waitError:null,waitResult:{conversationId,runId,status:'completed',reply:{text:'done'}},latestRun:runId};
    const forbidden=()=>assert.fail('Desktop recovery must not execute tools or open a local runtime');
    const client={evaluate:forbidden,send:forbidden,request:forbidden,json:forbidden};
    globalThis.fetch=forbidden;
    mock.module(root+'headless-local-runtime.mjs',{namedExports:{HeadlessLocalRuntime:class{constructor(){forbidden();}},prepareHeadlessLocalChannel:forbidden}});
    mock.module(root+'cdp.mjs',{namedExports:{withChatClient:fn=>fn(client)}});
    mock.module(root+'app.mjs',{namedExports:{currentApp:()=>({id:'work',aid:'1044603'})}});
    mock.module(root+'features.mjs',{namedExports:{desktopVersion:()=>'',rendererJsonClient:forbidden,requireGoalMode:forbidden}});
    mock.module(root+'attachments.mjs',{namedExports:{uploadAttachmentsFromClient:forbidden,uploadedAttachmentBlocks:forbidden,clearUploadedAttachments:forbidden}});
    mock.module(root+'models.mjs',{namedExports:{resolveModelFromClient:forbidden,resolveReasoningEffort:forbidden,selectModelFromClient:forbidden,setReasoningForConversation:forbidden}});
    mock.module(root+'context.mjs',{namedExports:{resolveTaskContext:async()=>({taskContext:{runtime:'local'},workspace:'/private/test-workspace'}),publicTaskContext:x=>x,validateTaskOptions:()=>{}}});
    mock.module(root+'protocol.mjs',{namedExports:{AUTOMATIC_MODEL_PROTOCOL:{},switchConversationModel:forbidden,sendChatCompletion:forbidden}});
    mock.module(root+'mcp.mjs',{namedExports:{prepareToolSandbox:forbidden,sendWithConnectors:async(actualClient,request,connectors)=>{
      assert.equal(actualClient,client);state.sends.push({request,connectors});
      request.onReceipt(structuredClone(accepted));
      if(state.sendError)throw Object.assign(Error('accepted stream interrupted'),{code:state.sendError,receipt:structuredClone(accepted)});
      return structuredClone(accepted);
    }}});
    const store={save:r=>{const copy=structuredClone(r);state.saved.push(copy);state.receipts.set(copy.conversationId+':'+copy.runId,copy);},
      read:(id,run)=>{state.receiptReads.push({id,run});return structuredClone(state.receipts.get(id+':'+run)||{});}};
    mock.module(root+'turns.mjs',{namedExports:{refreshTurn:forbidden,stopTurn:forbidden,
      receiptStore:async actualClient=>{assert.equal(actualClient,client);return store;},
      readTurn:async(actualClient,id,options)=>{assert.equal(actualClient,client);state.reads.push({id,options});return {result:{conversationId:id,runId:state.latestRun}};},
      waitTurn:async(actualClient,id,options)=>{
        assert.equal(actualClient,client);state.waits.push({id,options});
        if(state.waitError)throw state.waitError;
        return state.waitResult;
      }}});
    const {createConversation,sendMessage,waitConversation}=await import(root+'automation.mjs');
    ${code}
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
}

test('accepted MCP create timeout recovers the same receipt and repeated wait never resends', () => scenario(`
  state.sendError='timeout';
  const timeout=Object.assign(Error('waiting timed out'),{code:'timeout',result:{conversationId,runId,status:'running'}});
  state.waitError=timeout;
  await assert.rejects(createConversation('use selected connector',{mcps:['selected'],waitForReply:true,timeoutMs:1000}),error=>error===timeout);
  assert.equal(state.sends.length,1);assert.deepEqual(state.sends[0].connectors,['selected']);
  const receipt=store.read(conversationId,runId);
  assert.equal(receipt.runId,runId);assert.deepEqual(receipt.requestBody,accepted.requestBody);
  assert.equal(state.waits[0].options.receipt.runId,runId);
  state.waitError=null;
  for(let i=0;i<2;i++){
    const result=await waitConversation(conversationId,{runId,timeoutMs:1000});
    assert.equal(result.status,'completed');assert.equal(result.runId,runId);
    const wait=state.waits.at(-1);assert.equal(wait.id,conversationId);assert.equal(wait.options.runId,runId);
    assert.deepEqual(wait.options.receipt,receipt);
    assert.deepEqual(wait.options.loadReceipt(runId),receipt);
  }
  assert.equal(state.sends.length,1);assert.equal(state.reads.length,0);
`));

test('accepted MCP send interruption uses native submission once and retains tracking callbacks', () => scenario(`
  state.sendError='incomplete_stream';
  const result=await sendMessage(conversationId,'continue using connector',{mcps:['selected'],waitForReply:true,timeoutMs:1000});
  assert.equal(result.status,'completed');assert.equal(state.sends.length,1);
  assert.equal(state.sends[0].request.conversationId,conversationId);
  const wait=state.waits[0];assert.equal(wait.options.receipt.runId,runId);
  wait.options.onReceipt({...wait.options.receipt,handoffs:[{taskId:'tracked-child',completed:true}]});
  assert.equal(store.read(conversationId,runId).handoffs[0].completed,true);
  await waitConversation(conversationId,{runId,timeoutMs:1000});assert.equal(state.sends.length,1);
`));

test('legacy MCP receipt with mcpStartedAt is accepted without recreating its executor', () => scenario(`
  const legacy={...structuredClone(accepted),mcpStartedAt:Date.now()-86400000};store.save(legacy);
  const result=await waitConversation(conversationId,{runId,timeoutMs:1000});
  assert.equal(result.status,'completed');assert.deepEqual(state.waits[0].options.receipt,legacy);
  assert.equal(state.sends.length,0);assert.equal(state.reads.length,0);
`));

test('server running, pending, failed and cancelled outcomes remain delegated to waitTurn', () => scenario(`
  store.save(accepted);
  for(const status of ['running','waiting_input','failed','cancelled']){
    state.waitResult={conversationId,runId,status,...status==='waiting_input'?{pending:[{type:'approval'}]}:{}};
    const result=await waitConversation(conversationId,{runId,timeoutMs:1000});
    assert.equal(result,state.waitResult);
    assert.equal(state.waits.at(-1).options.runId,runId);
  }
  const unavailable=Object.assign(Error('requested turn is unavailable; no other turn selected'),{code:'turn_unavailable'});
  state.waitError=unavailable;
  await assert.rejects(waitConversation(conversationId,{runId:'9999999999999999',timeoutMs:1000}),error=>error===unavailable);
  assert.equal(state.waits.at(-1).options.runId,'9999999999999999');
  assert.deepEqual(state.waits.at(-1).options.receipt,{});
  assert.equal(state.sends.length,0);assert.equal(state.reads.length,0);
`));

test('wait without a receipt passes the explicit run to server tracking without selecting another', () => scenario(`
  const result=await waitConversation(conversationId,{runId,timeoutMs:1000});
  assert.equal(result.runId,runId);assert.equal(state.reads.length,0);
  const wait=state.waits[0];assert.equal(wait.id,conversationId);assert.equal(wait.options.runId,runId);
  assert.deepEqual(wait.options.receipt,{});assert.equal(typeof wait.options.onReceipt,'function');
  wait.options.onReceipt({conversationId,runId,handoffs:[{taskId:'server-child'}]});
  assert.equal(store.read(conversationId,runId).handoffs.length,1);
  assert.equal(state.sends.length,0);
`));

test('wait without run resolves the server run once and tracks that exact identity', () => scenario(`
  state.latestRun='3456789012345678';state.waitResult={conversationId,runId:state.latestRun,status:'completed'};
  await waitConversation(conversationId,{timeoutMs:1000});
  assert.equal(state.reads.length,1);assert.equal(state.reads[0].id,conversationId);
  assert.equal(state.receiptReads[0].run,state.latestRun);
  assert.equal(state.waits[0].options.runId,state.latestRun);
  assert.deepEqual(state.waits[0].options.receipt,{});assert.equal(state.sends.length,0);
`));
