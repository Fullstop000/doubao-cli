import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { main } from '../src/cli.mjs';
import { CdpClient } from '../src/cdp.mjs';
import { prepareToolSandbox } from '../src/mcp.mjs';
import { conversationExt, modelProtocol } from '../src/protocol.mjs';

test('invalid permissions cannot fall back to FullAccess at either protocol boundary', async () => {
  assert.throws(() => conversationExt(modelProtocol('auto'), 'message', '/tmp/ws', { permission: 'typo' }), /unknown permission/u);
  await assert.rejects(prepareToolSandbox({
    evaluate() { assert.fail('invalid permission must not reach the app'); },
  }, { workspace: '/tmp/ws', permission: 'typo' }), /unknown permission/u);
});

test('MCP CLI forwards permissions through preparation, requests, and follow-up changes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-permissions-'));
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    DOUBAO_APP: path.join(directory, 'Absent.app'),
    DOUBAO_DATA_DIR: directory,
    DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1',
    DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:19925',
  });
  fs.writeFileSync(path.join(directory, 'Local State'), JSON.stringify({
    profile: { last_used: 'Default', info_cache: { Default: { name: 'Test' } } },
  }));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const prepared = [];
  const requests = [];
  const bindings = [];
  const output = [];
  const conversationId = '38439138239851266';
  const connectorId = '369247068674';
  const requireModule = (id) => {
    if (id === 987391) return { H: async (args) => {
      prepared.push(args);
      return { sandboxId: `sandbox-${prepared.length}`, resolvedSharedFolders: [directory] };
    } };
    if (id === 763283) return { _: () => ({ invoke: async (method, args) => {
      bindings.push({ method, ...args });
      return { ok: true };
    } }) };
    throw new Error(`unexpected app module: ${id}`);
  };
  const context = vm.createContext({
    crypto, AbortController, TextDecoder, setTimeout, clearTimeout,
    window: {
      '@flow-web/desktop:stable': { push: ([, , callback]) => callback(requireModule) },
      neotix: {
        taskMode: { runtime: { queryRuntimeInfo: async () => ({ env: { environmentId: 'test-env' } }) } },
        mcp: { getAllTools: async () => ({ connectors: [{ connectorId, toolsJson: JSON.stringify([
          { name: 'ping', inputSchema: { type: 'object' } },
        ]) }] }) },
      },
    },
    fetch: async (url, options) => {
      assert.match(url, /\/chat\/completion\?/u);
      requests.push(JSON.parse(options.body));
      return new Response(
        `event: SSE_ACK\ndata: ${JSON.stringify({ ack_client_meta: { conversation_id: conversationId } })}\n\n`
        + 'event: SSE_REPLY_END\ndata: {"end_type":3}\n\n',
      );
    },
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:19925\/json\/(version|list)$/u);
    return Response.json(url.endsWith('/version') ? { Browser: 'Test' } : [{
      type: 'page', url: 'doubao://doubao-chat/chat', webSocketDebuggerUrl: 'ws://test',
    }]);
  });
  t.mock.method(CdpClient.prototype, 'connect', async function () { return this; });
  t.mock.method(CdpClient.prototype, 'close', () => {});
  t.mock.method(CdpClient.prototype, 'evaluate', (expression) => vm.runInContext(expression, context));
  t.mock.method(console, 'log', (value) => output.push(JSON.parse(value)));

  // Includes value 0 and transitions from approval modes back to the default.
  const turns = [
    ['create', undefined, 2], ['send', 'AlwaysAsk', 0], ['send', 'AskOnRisk', 1],
    ['send', 'FullAccess', 2], ['send', 'AlwaysAsk', 0], ['send', undefined, 2],
    ['create', 'AlwaysAsk', 0], ['create', 'AskOnRisk', 1],
  ];
  for (const [command, mode, expected] of turns) {
    await main(['sessions', command, ...(command === 'send' ? [conversationId] : []), 'ping',
      '--mcp', connectorId, '--workspace', directory, '--no-skills', '--wait', '--json',
      ...(mode ? ['--permission', mode] : []),
    ]);
    const prepare = prepared.at(-1);
    const request = requests.at(-1);
    const params = JSON.parse(request.ext.general_task_param);
    assert.equal(prepare.sandboxAuthType, expected);
    assert.equal(params.client_option.sandbox_auth_type, expected);
    assert.equal(params.agent_task_param.sandbox_auth_type, expected);
    assert.equal(params.client_option.sandbox_id, `sandbox-${prepared.length}`);
    assert.equal(params.agent_task_param_change.sandbox_auth_type_changed, command === 'send');
    assert.equal(params.need_modify_conversation, command === 'send');
    assert.equal(JSON.parse(params.task_input_json).localConnectors[0].connectorId, connectorId);
    assert.deepEqual(params.client_option.agent_workspace.local_skill_paths, []);
    assert.equal(prepare.sendContext.conversationId, command === 'send' ? conversationId : undefined);
    assert.equal(bindings.at(-1).instanceId, params.client_option.sandbox_id);
    assert.equal(bindings.at(-1).conversationId, conversationId);
    assert.equal(output.at(-1).conversationId, conversationId);
  }
  assert.equal(prepared.length, turns.length);
  assert.equal(requests.length, turns.length);
  assert.equal(bindings.length, turns.length);
});
