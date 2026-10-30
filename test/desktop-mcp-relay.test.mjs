import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopMcpRelay } from '../src/desktop-mcp-relay.mjs';

const frame = () => ({ event_type: 1, sandbox_id: 'owned-sandbox', signature: { user_id: 'user', device_id: '123' },
  tool_call: { id: 'tool-1', name: 'connector.call', input: JSON.stringify({ protocol_version: 1, connector_id: 'selected', remote_tool_name: 'echo', raw_arguments: '{"message":"test"}' }), option: {} } });
function fixture(options = {}) {
  const calls = [], uploads = [], errors = [];
  const relay = new DesktopMcpRelay({ appId: 'work', sandboxId: 'owned-sandbox', deviceId: '123', accountId: 'user', conversationId: '1234567890123456',
    workspace: os.tmpdir(), permission: 'FullAccess', connectors: [{ connectorId: 'selected', mcpToolsList: [{ name: 'echo' }] }], isActive: async () => true,
    callConnector: async x => { calls.push(x); return { mcpResponseJson: '{"content":[{"type":"text","text":"pong"}]}' }; },
    client: { request() { throw Error('unused'); }, async json(p, o) { uploads.push(JSON.parse(o.body)); return { code: 0 }; } }, onError: e => errors.push(e), ...options });
  return { relay, calls, uploads, errors };
}
test('desktop MCP executes once and uploads native result; duplicate delivery is ignored', async () => {
  const {relay,calls,uploads}=fixture();await relay.handleFrame(frame());await relay.handleFrame(frame());
  assert.equal(calls.length,1);assert.equal(uploads.length,1);assert.equal(uploads[0].tool_result.name,'connector.call');assert.match(uploads[0].tool_result.raw_result,/pong/);
});
test('desktop MCP ignores foreign, malformed and non-MCP frames without ACKs', async () => {
  const {relay,calls,uploads}=fixture();const variants=[];
  for(const edit of [f=>f.event_type=2,f=>f.sandbox_id='foreign',f=>f.tool_call.name='Bash',f=>delete f.signature,
    f=>f.signature.user_id='other',f=>f.signature.device_id='999',f=>f.tool_call.input='{',
    f=>f.tool_call.input=JSON.stringify({protocol_version:1,connector_id:'other',remote_tool_name:'echo',raw_arguments:'{}'}),
    f=>f.tool_call.input=JSON.stringify({protocol_version:1,connector_id:'selected',remote_tool_name:'unknown',raw_arguments:'{}'}),
    f=>f.tool_call.input=JSON.stringify({protocol_version:1,connector_id:'selected',remote_tool_name:'echo',raw_arguments:'[]'}),
    f=>f.tool_call.option.conversation_id='9876543210987654']) {const f=frame();edit(f);variants.push(f);}
  for(const f of variants)await relay.handleFrame(f);assert.equal(calls.length,0);assert.equal(uploads.length,0);
});
test('terminal or pending owner does not execute or acknowledge a replay', async()=>{
  const {relay,calls,uploads}=fixture({isActive:async()=>false});await relay.handleFrame(frame());assert.equal(calls.length,0);assert.equal(uploads.length,0);
});
test('same call id with modified arguments cannot execute again',async()=>{
 const {relay,calls,uploads,errors}=fixture();await relay.handleFrame(frame());const f=frame();f.tool_call.input=f.tool_call.input.replace('test','changed');await relay.handleFrame(f);assert.equal(calls.length,1);assert.equal(uploads.length,1);assert.equal(errors.length,1);
});
for(const permission of ['AskOnRisk','AlwaysAsk'])test(`${permission} requires explicit approval; denial never calls native MCP`,async()=>{
 const {relay,calls,uploads}=fixture({permission,approve:async()=>false});await relay.handleFrame(frame());assert.equal(calls.length,0);assert.equal(uploads[0].tool_result.error_code,'PERMISSION_DENIED');
});
test('missing approver fails closed',async()=>{const {relay,calls}=fixture({permission:'AlwaysAsk'});await relay.handleFrame(frame());assert.equal(calls.length,0);});
test('persisted result is reuploaded after restart without repeating native execution',async t=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'desktop-mcp-test-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const journalPath=path.join(dir,'journal.json');const a=fixture({journalPath,client:{request(){},async json(){throw Error('offline');}}});
 await assert.rejects(a.relay.handleFrame(frame()),/offline/);assert.equal(a.calls.length,1);
 const b=fixture({journalPath});await b.relay.handleFrame(frame());assert.equal(b.calls.length,0);assert.equal(b.uploads.length,1);
});
test('device lease excludes a second task, then releases for next owner',async t=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'desktop-mcp-lease-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const deviceLeasePath=path.join(dir,'device.lock');const a=fixture({deviceLeasePath});const b=fixture({deviceLeasePath,sandboxId:'other'});
 await a.relay.acquireLease();await assert.rejects(b.relay.acquireLease(),{code:'LOCAL_RUNTIME_BUSY'});await a.relay.releaseLease();await b.relay.acquireLease();await b.relay.releaseLease();
});

test('uncertain started journal is never reexecuted after process loss',async t=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'desktop-mcp-uncertain-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const journalPath=path.join(dir,'journal.json');const a=fixture({journalPath});await a.relay.handleFrame(frame());
 const journal=JSON.parse(await fs.readFile(journalPath));journal.records[0].status='started';delete journal.records[0].result;await fs.writeFile(journalPath,JSON.stringify(journal),{mode:0o600});
 const b=fixture({journalPath});await b.relay.handleFrame(frame());assert.equal(b.calls.length,0);assert.equal(b.uploads[0].tool_result.error_code,'TOOL_OUTCOME_UNCONFIRMED');
});

test('task completion during approval prevents late native execution',async()=>{
 let active=true;const {relay,calls}=fixture({permission:'AlwaysAsk',isActive:async()=>active,approve:async()=>{active=false;return true;}});
 await relay.handleFrame(frame());assert.equal(calls.length,0);
});
test('new turn rejects stale, missing and future timestamps before accepting fresh call',async()=>{
 const notBefore=Date.now()-1000;const {relay,calls,uploads}=fixture({notBefore});
 for(const timestamp of [undefined,notBefore-1,Date.now()+60000]) {const f=frame();f.signature.timestamp_ms=timestamp;await relay.handleFrame(f);}
 assert.equal(calls.length,0);assert.equal(uploads.length,0);
 const f=frame();f.signature.timestamp_ms=Date.now();await relay.handleFrame(f);assert.equal(calls.length,1);
});
