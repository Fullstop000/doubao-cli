import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { registerConnector, listConnectors, removeConnector } from '../src/mcp.mjs';

function renderer({ missing = false, ambiguous = false } = {}) {
  let exists = false;
  let created = 0;
  let required = [];
  const api = {
    async AGWManageCreatePersonalConnector() { created++; exists = true; return {data:{connector:{connector_id:'123456'}}}; },
    async AGWManageListUserConnectors() { return { code:0,data:{items:exists?[{connector_id:'123456',enabled:true}]:[],has_more:false} }; },
    async AGWManageDisconnectConnector() { exists = false; },
  };
  const req = id => { required.push(id); assert.equal(id, 777001); return { Sf:api }; };
  req.m = missing ? {} : { 777001: { toString: () => 'r.d(e,{Sf:()=>a,SI:()=>b})' } };
  if (ambiguous) req.m[777002] = req.m[777001];
  req.e = () => { assert.fail('A modern factory table must not trigger obsolete chunk 1383'); };
  const context=vm.createContext({crypto,setTimeout,clearTimeout,document:{querySelector:()=>({})},window:{
    '@flow-web/desktop:stable':{push:([,,ready])=>ready(req)},
    neotix:{taskMode:{runtime:{triggerUpdate:async()=>{}},connector:{queryLocalConnectors:async()=>({connectors:[{connectorId:'123456',enabled:true,status:'READY'}]})}},mcp:{getAllTools:async()=>({connectors:[]})}},
  }});
  return {client:{evaluate:expression=>vm.runInContext(expression,context),close(){}},created:()=>created,required:()=>required};
}

test('MCP register/list/remove discover relocated loaded modules without obsolete chunks',async()=>{
  const x=renderer();
  const registered=await registerConnector(x.client,{name:'synthetic',command:'/usr/bin/true',timeoutMs:500});
  assert.equal(registered.status,'READY');assert.equal(x.created(),1);
  assert.equal((await listConnectors(x.client))[0].connectorId,'123456');
  assert.equal((await removeConnector(x.client,'123456')).removed,true);
  assert.deepEqual(x.required(),[777001,777001,777001]);
});

test('missing or ambiguous modern MCP modules fail before remote creation without loading old chunks',async()=>{
  for(const options of [{missing:true},{ambiguous:true}]){
    const x=renderer(options);
    await assert.rejects(registerConnector(x.client,{name:'synthetic',command:'/usr/bin/true',timeoutMs:500}),/module is unavailable or ambiguous/u);
    assert.equal(x.created(),0);assert.deepEqual(x.required(),[]);
  }
});
