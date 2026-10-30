import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const source = new URL('../src/', import.meta.url).href;
function scenario(code) {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const root = ${JSON.stringify(source)};
    const state = { delivery: 'dispatcher', status: 'running', pending: [], run: '2345678901234567',
      account: { isLogin: true, userId: 'account' }, identity: { params: { aid: '1044603', device_id: '12345' } },
      probes: [], instances: [], transports: [], reads: [], diagnostics: [], blockStart: false };
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const until = async predicate => { for(let i=0;i<40&&!predicate();i++)await tick();assert(predicate(),'expected lifecycle state was not reached'); };
    class Runtime {
      constructor(options) { this.options=options; this.controller=new AbortController(); state.instances.push(this); }
      async start({signal}) { this.signal=signal; this.leased=true; if(state.blockStart)await new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>{this.leased=false;reject(new DOMException('Aborted','AbortError'));},{once:true});
      }); return {ready:true}; }
      async close() { this.closed=true; this.leased=false; }
    }
    mock.module(root+'headless-local-runtime.mjs',{namedExports:{HeadlessLocalRuntime:Runtime}});
    mock.module(root+'headless-approval.mjs',{namedExports:{createHeadlessApproval:()=>async()=>false}});
    mock.module(root+'desktop-mcp-transport.mjs',{namedExports:{createDesktopMcpTransport:(_client,identity)=>{
      const transport={identity,closed:false,close:async()=>{transport.closed=true;},callConnector:()=>assert.fail('no tool in lifecycle tests')};
      state.transports.push(transport);return transport;
    }}});
    mock.module(root+'desktop-mcp-delivery.mjs',{namedExports:{nativeDeliveryProbe:options=>{
      state.probes.push(options);return async()=>typeof state.delivery==='function'?state.delivery():state.delivery;
    }}});
    mock.module(root+'app.mjs',{namedExports:{currentApp:()=>({id:'work',aid:'1044603',dataDir:'/private/work'})}});
    mock.module(root+'config.mjs',{namedExports:{configDirectory:()=>'/private/config'}});
    mock.module(root+'protocol.mjs',{namedExports:{runtimeParameters:async()=>state.identity}});
    mock.module(root+'turns.mjs',{namedExports:{readTurn:async(_client,id,options)=>{
      state.reads.push({id,options});if(state.readError){const error=typeof state.readError==='function'?state.readError():state.readError;if(error)throw error;}
      return {result:{runId:state.run,status:state.status,pending:state.pending}};
    }}});
    const {createDesktopMcpRelayOwner}=await import(root+'desktop-mcp-relay.mjs');
    const client={evaluate:async()=>state.account};
    const receipt=()=>({conversationId:'1234567890123456',runId:'2345678901234567',requestBody:{option:{general_task_param:{
      runtime_type:2,client_option:{sandbox_id:'owned',workspace:'/private/workspace',sandbox_auth_type:2},
      agent_task_param:{local_app_id:'1044603',local_device_id:'12345'},
      task_input_json:JSON.stringify({localConnectors:[{connectorId:'connector',mcpToolsList:[{name:'echo'}]}]})
    }}}});
    const owner=options=>createDesktopMcpRelayOwner(client,{deadline:Date.now()+5000,onDiagnostic:message=>state.diagnostics.push(message),...options});
    ${code}
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
}

test('owner ignores incomplete receipts and cloud/non-MCP accepted tasks', () => scenario(`
  const incomplete=owner();incomplete.accept({runId:'2345678901234567'});await incomplete.close();
  for(const mutate of [r=>r.requestBody.option.general_task_param.runtime_type=1,r=>r.requestBody.option.general_task_param.task_input_json='{}']){
    const r=receipt();mutate(r);const o=owner();o.accept(r);await tick();await o.close();
  }
  assert.equal(state.probes.length,0);assert.equal(state.transports.length,0);
`));

test('owner leaves native SSE alone and fails closed when delivery is unknown', () => scenario(`
  state.delivery='sse';let o=owner();o.accept(receipt());await tick();await o.close();
  assert.equal(state.reads.length,0);assert.equal(state.transports.length,0);
  state.delivery=null;o=owner({deadline:Date.now()+20});o.accept(receipt());await new Promise(resolve=>setTimeout(resolve,40));await o.close();
  assert.equal(state.transports.length,0);assert(state.diagnostics.some(x=>x.includes('could not be verified')));
`));

test('long initialization gets a fresh admission window while frame freshness keeps the accepted timestamp', () => scenario(`
  const startedAt=Date.now()-60000,r=receipt();r.mcpStartedAt=startedAt-1000;
  const o=owner({startedAt});o.accept(r);await until(()=>state.instances.length===1);
  assert.equal(state.probes[0].startedAt,startedAt);assert.equal(state.instances[0].notBefore,r.mcpStartedAt);
  await o.close();
`));

test('wait recovery cannot authorize routing from the old receipt alone', () => scenario(`
  const startedAt=Date.now(),r=receipt();r.mcpStartedAt=startedAt-60000;
  state.delivery=()=>state.probes[0].startedAt===r.mcpStartedAt?'dispatcher':null;
  const o=owner({startedAt,deadline:Date.now()+20});o.accept(r);await new Promise(resolve=>setTimeout(resolve,40));await o.close();
  assert.equal(state.probes[0].startedAt,startedAt);assert.equal(state.instances.length,0);
  assert(state.diagnostics.some(x=>x.includes('could not be verified')));
`));

test('ACK before history retries turn_unavailable and starts only after the exact turn exists', () => scenario(`
  state.readError=()=>state.reads.length===1?Object.assign(Error('not persisted'),{code:'turn_unavailable'}):null;
  const o=owner();o.accept(receipt());await tick();assert.equal(state.instances.length,0);
  await new Promise(resolve=>setTimeout(resolve,300));await until(()=>state.instances.length===1);
  assert.equal(state.reads.length,2);assert.equal(o.failure,undefined);await o.close();
`));

test('persistent unavailable history expires without transport or native execution', () => scenario(`
  state.readError=Object.assign(Error('not persisted'),{code:'turn_unavailable'});
  const deadline=Date.now()+30,o=owner({deadline});o.accept(receipt());
  await new Promise(resolve=>setTimeout(resolve,60));await o.close();
  assert(state.reads.length>0);assert(state.reads.every(r=>r.options.deadline===deadline));
  assert.equal(state.instances.length,0);assert.equal(state.transports.length,0);assert.equal(o.failure,undefined);
`));

test('unknown status and non-transient read errors are not retried', () => scenario(`
  state.status='unknown';let o=owner();o.accept(receipt());await tick();await o.close();assert.equal(state.reads.length,1);
  state.readError=Object.assign(Error('denied'),{code:'forbidden'});o=owner();o.accept(receipt());await until(()=>o.failure);await o.close();
  assert.equal(state.reads.length,2);assert.equal(state.transports.length,0);assert.equal(o.failure.code,'forbidden');
`));

test('invalid provided timestamps fail closed; absent timestamps use owner start', () => scenario(`
  for(const timestamp of [null,0,-1,1.5,'123',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,Date.now()+60000]){
    const r=receipt();r.mcpStartedAt=timestamp;const o=owner();o.accept(r);await until(()=>o.failure);await o.close();
    assert.match(o.failure.message,/timestamp/);
  }
  assert.equal(state.probes.length,0);assert.equal(state.transports.length,0);
  const startedAt=Date.now()-1000,o=owner({startedAt});o.accept(receipt());await until(()=>state.instances.length===1);
  assert.equal(state.instances[0].notBefore,startedAt);await o.close();
`));

test('owner requires the exact active run with no pending interaction', () => scenario(`
  for(const change of [()=>state.status='completed',()=>{state.status='running';state.pending=[{}];},()=>{state.pending=[];state.run='9999999999999999';}]){
    change();const o=owner();o.accept(receipt());await tick();await o.close();
  }
  assert.equal(state.transports.length,0);assert.equal(state.reads.length,3);
  for(const r of state.reads){assert.equal(r.id,'1234567890123456');assert.equal(r.options.runId,'2345678901234567');}
`));

test('owner freezes accepted identity and ignores later rebinding callbacks', () => scenario(`
  let release;state.delivery=()=>new Promise(r=>{release=r;});
  const r=receipt(),o=owner();o.accept(r);await tick();
  r.requestBody.option.general_task_param.client_option.sandbox_id='changed';r.runId='9999999999999999';
  o.accept(r);release('dispatcher');await until(()=>state.instances.length===1);
  const runtime=state.instances[0];assert.equal(runtime.options.sandboxId,'owned');assert.equal(runtime.options.permission,'FullAccess');
  assert.equal(runtime.options.accountId,'account');assert.equal(runtime.options.deviceId,'12345');
  assert(runtime.allowed.get('connector').has('echo'));
  assert.match(runtime.options.journalPath,/desktop-mcp/);assert.match(runtime.leasePath,/device\.lock$/);
  await o.close();assert(runtime.closed);assert(!runtime.leased);assert(state.transports[0].closed);
`));

test('owner rejects changed account/app and mismatched receipt target before transport opens', () => scenario(`
  for(const mode of ['logout','wrong-current-app','wrong-receipt-app','wrong-receipt-device']){
    state.account={isLogin:true,userId:'account'};state.identity={params:{aid:'1044603',device_id:'12345'}};
    const r=receipt();if(mode==='logout')state.account.isLogin=false;
    if(mode==='wrong-current-app')state.identity.params.aid='582478';
    if(mode==='wrong-receipt-app')r.requestBody.option.general_task_param.agent_task_param.local_app_id='582478';
    if(mode==='wrong-receipt-device')r.requestBody.option.general_task_param.agent_task_param.local_device_id='other';
    const o=owner();o.accept(r);await until(()=>o.failure);await o.close();
  }
  assert.equal(state.transports.length,0);
`));

test('close during pending delivery discovery never starts a late relay', () => scenario(`
  let release;state.delivery=()=>new Promise(r=>{release=r;});
  const o=owner();o.accept(receipt());await tick();const closed=o.close();release('dispatcher');await closed;
  assert.equal(state.transports.length,0);o.accept(receipt());await tick();assert.equal(state.probes.length,1);
`));

test('close aborts pending relay startup and releases its lease and transport', () => scenario(`
  state.blockStart=true;const o=owner();o.accept(receipt());await until(()=>state.instances[0]?.leased);
  await o.close();assert(state.instances[0].signal.aborted);assert(!state.instances[0].leased);assert(state.instances[0].closed);assert(state.transports[0].closed);
`));

test('invalid permission prevents relay start and diagnostic failure cannot hide the error', () => scenario(`
  const r=receipt();r.requestBody.option.general_task_param.client_option.sandbox_auth_type=17;
  const o=owner({onDiagnostic:()=>{throw Error('diagnostic callback');}});o.accept(r);await until(()=>o.failure);
  assert.match(o.failure.message,/permission/);await o.close();assert.equal(state.instances.length,0);
  assert(state.transports.every(t=>t.closed));
`));

test('normal send/create/wait paths do not instantiate the MCP compatibility owner', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';import {mock} from 'node:test';
    const root=${JSON.stringify(source)};
    const receipt={conversationId:'1234567890123456',runId:'2345678901234567',requestBody:{option:{general_task_param:{runtime_type:1}}}};
    mock.module(root+'desktop-mcp-relay.mjs',{namedExports:{createDesktopMcpRelayOwner:()=>assert.fail('ordinary commands must not instantiate MCP compatibility')}});
    mock.module(root+'cdp.mjs',{namedExports:{withChatClient:fn=>fn({evaluate:async()=>true})}});
    mock.module(root+'app.mjs',{namedExports:{currentApp:()=>({id:'work',aid:'1044603'})}});
    mock.module(root+'features.mjs',{namedExports:{desktopVersion:()=>'',rendererJsonClient:()=>{},requireGoalMode:()=>{}}});
    mock.module(root+'attachments.mjs',{namedExports:{uploadAttachmentsFromClient:()=>{},uploadedAttachmentBlocks:()=>{},clearUploadedAttachments:()=>{}}});
    mock.module(root+'models.mjs',{namedExports:{resolveModelFromClient:()=>{},resolveReasoningEffort:()=>{},selectModelFromClient:()=>{},setReasoningForConversation:()=>{}}});
    mock.module(root+'context.mjs',{namedExports:{resolveTaskContext:async()=>({taskContext:{runtime:'cloud'}}),publicTaskContext:x=>x,validateTaskOptions:()=>{}}});
    mock.module(root+'protocol.mjs',{namedExports:{AUTOMATIC_MODEL_PROTOCOL:{},switchConversationModel:()=>{},sendChatCompletion:async()=>structuredClone(receipt)}});
    mock.module(root+'mcp.mjs',{namedExports:{sendWithConnectors:()=>assert.fail('no MCP send'),prepareToolSandbox:()=>assert.fail('no local runtime')}});
    mock.module(root+'turns.mjs',{namedExports:{refreshTurn:()=>{},readTurn:async()=>({result:{...receipt,status:'completed'}}),stopTurn:()=>{},waitTurn:async()=>({...receipt,status:'completed'}),receiptStore:async()=>({save:()=>{},read:()=>structuredClone(receipt)})}});
    const {sendMessage,createConversation,waitConversation}=await import(root+'automation.mjs');
    for(const waitForReply of [false,true]){
      assert.equal((await sendMessage(receipt.conversationId,'hello',{waitForReply,timeoutMs:1000})).runId,receipt.runId);
      assert.equal((await createConversation('hello',{waitForReply,timeoutMs:1000})).runId,receipt.runId);
    }
    assert.equal((await waitConversation(receipt.conversationId,{runId:receipt.runId,timeoutMs:1000})).status,'completed');
  `], {encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);
});
