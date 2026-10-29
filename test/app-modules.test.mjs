import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from '../src/app-modules.mjs';

function runtime(sources, exports = {}) {
  const calls = [];
  const req = id => { calls.push(id); assert.ok(sources[id]); return exports[id] || { id }; };
  req.m = Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, { toString: () => source }]));
  return { req, calls };
}

test('attachments discovery selects the state implementation instead of its re-export barrel', () => {
  const implementation = 'function(e,t,r){r.d(t,{getAttachmentActions:()=>A,attachmentStatesSelector:()=>B});const state=store("attachmentsStore").attachmentsMap;}';
  const barrel = 'function(e,t,r){r.d(t,{getAttachmentActions:()=>a.getAttachmentActions,attachmentStatesSelector:()=>a.attachmentStatesSelector});const state=store("attachmentsStore").attachmentsMap;}';
  const { req, calls } = runtime({ 100: implementation, 200: barrel });
  assert.equal(appModule(req, 'attachments').id, 100);
  assert.deepEqual(calls, [100]);
  req.m[300] = { toString: () => implementation };
  assert.throws(() => appModule(req, 'attachments'), /unavailable or ambiguous/u);
  assert.deepEqual(calls, [100], 'ambiguous discovery must not require either candidate');
});

test('attachment formatter discovery requires its exported S, not a nested component property', () => {
  const { req, calls } = runtime({
    100: 'function(e,t,r){r.d(t,{S:()=>format});const x={transform:()=>0,attachmentStates:[],type:"BLOCK_ATTACHMENT"};}',
    200: 'function(e,t,r){r.d(t,{createDesktopRightPanelPluginProviders:()=>p});const x={S:1,transform:0,attachmentStates:[],type:"BLOCK_ATTACHMENT"};}',
  });
  assert.equal(appModule(req, 'attachmentBlock').id, 100);
  assert.deepEqual(calls, [100]);
});

test('skills discovery adapts the named authenticated facade and retains the old export contract', () => {
  const api = { AGWListUserAndFeaturedSkills() {}, AGWManageCreatePersonalConnector() {} };
  const tasks = { AGWTaskTerminate() {} };
  const current = runtime({ 100: 'function(e,t,r){r.d(t,{skillsFacadeApiService:()=>api,flowAgentGeneralApiService:()=>tasks});}' },
    { 100: { skillsFacadeApiService: api, flowAgentGeneralApiService: tasks } });
  assert.equal(appModule(current.req, 'skills').Sf, api);
  assert.equal(appModule(current.req, 'skills').iv, tasks);
  const old = runtime({ 200: 'function(e,t,r){r.d(t,{Sf:()=>api,SI:()=>state});}' }, { 200: { Sf: api, iv: tasks } });
  assert.equal(appModule(old.req, 'skills').Sf, api);
  assert.equal(appModule(old.req, 'skills').iv, tasks);
  const decoy = runtime({ 300: 'function(e,t,r){r.d(t,{other:()=>x});const x={Sf:1,SI:2};}' });
  assert.throws(() => appModule(decoy.req, 'skills'), /unavailable or ambiguous/u);
  assert.deepEqual(decoy.calls, []);
});

test('project device discovery uses the verified creation helper when duplicate helpers are bundled', () => {
  const helper = 'function(e,t,r){r.d(t,{U:()=>device});const device=async()=>{await bridge.getDeviceInfo();return "project_shared_get_device_error";};}';
  const { req, calls } = runtime({ 310092: helper, 898504: helper });
  assert.equal(appModule(req, 'projectDevice').id, 310092);
  req.m[310092] = { toString: () => 'function(e,t,r){r.d(t,{unrelated:()=>x});}' };
  assert.equal(appModule(req, 'projectDevice').id, 898504);
  assert.deepEqual(calls, [310092, 898504], 'changed known ID must never be required');
});
