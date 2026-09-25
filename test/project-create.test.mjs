import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { currentApp } from '../src/app.mjs';
import { parseOptions } from '../src/cli.mjs';
import { createProject, projectCreationInput } from '../src/context.mjs';

function clientFor({ deviceId = 'current', mutate, readback } = {}) {
  const calls = [];
  let project;
  const req = id => {
    if (id === 101) return { th: () => ({ createProject: async (input, options) => {
      calls.push(JSON.parse(JSON.stringify({ input, options })));
      if (mutate) return mutate(input, options);
      project = { project_id: '123', name: input.name, status: 1, folders: input.folders?.map(f => ({
        folder_name: f.folderName, workspace: f.workspace, folder_device_id: f.folderDeviceId,
        folder_device_name: f.folderDeviceName, is_primary: f.isPrimary,
      })) };
      return { projectId: '123', operationId: options.operationId };
    } }) };
    if (id === 102) return { U: async () => ({ deviceId, deviceName: 'This Mac' }) };
    throw new Error('Unexpected module ' + id);
  };
  req.m = {
    101: { toString: () => 'th: IM_PROJECT_SERVICE_UNAVAILABLE async createProject(' },
    102: { toString: () => 'U: project_shared_get_device_error getDeviceInfo()' },
  };
  const context = vm.createContext({ URL, crypto, setTimeout, clearTimeout, AbortSignal,
    performance: { getEntriesByType: () => [{ name: `https://www.doubao.com/im/project/list?aid=${currentApp().aid}&device_id=current` }] },
    window: { '@flow-web/desktop:stable': { push: ([,,fn]) => fn(req) }, neotix: { taskMode: { runtime: {
      queryRuntimeInfo: async () => ({ status: 'READY', env: { environmentId: 'env' } }),
    } } } },
    fetch: async (url, options) => {
      assert.match(url, /\/im\/project\/list\?/);
      assert.equal(JSON.parse(options.body).cmd, 4605);
      return readback ? readback(project) : Response.json({ downlink_body: { list_projects_downlink_body: { projects: [project] } } });
    },
  });
  return { calls, evaluate: expression => vm.runInContext(expression, context), close() {} };
}

test('project input validates official weighted name limit and existing directories before connecting', () => {
  assert.equal(projectCreationInput('  demo  ').name, 'demo');
  assert.equal(projectCreationInput('中'.repeat(20)).name.length, 20);
  assert.equal(projectCreationInput('a'.repeat(40)).name.length, 40);
  for (const name of ['', '  ', 'a'.repeat(41), '中'.repeat(21), '😀'.repeat(21)]) {
    assert.throws(() => projectCreationInput(name));
  }
  assert.throws(() => projectCreationInput('demo', '/does-not-exist-doubao-project'), /not a directory/);
  assert.throws(() => projectCreationInput('demo', import.meta.filename), /not a directory/);
  assert.equal(projectCreationInput('demo', '.').workspace, process.cwd());
  assert.throws(() => parseOptions(['projects', 'create']), /requires a project name/);
  assert.throws(() => parseOptions(['projects', 'create', '--help']), /Run "doubao help"/);
  assert.throws(() => parseOptions(['projects', 'create', 'demo', '--workspce', '.']), /Unknown projects create option/);
  assert.deepEqual(parseOptions(['projects', 'create', '--', '--a-name']).args, ['projects', 'create', '--a-name']);
  assert.throws(() => parseOptions(['projects', 'create', 'demo', '--workspace']), /requires a directory/);
  for (const flags of [['--attach', '/tmp/a'], ['--wait'], ['--model', 'auto'], ['--no-skills'], ['--runtime', 'local'], ['--project', 'demo'], ['--enterprise-knowledge']]) {
    assert.throws(() => parseOptions(['projects', 'create', 'demo', ...flags]));
  }
  assert.equal(parseOptions(['projects', 'create', 'demo', '--workspace', '.', '--json']).workspace, '.');
});

test('folderless creation uses the official service once and verifies its exact id', async () => {
  const client = clientFor();
  const result = await createProject(client, { name: '  demo  ' });
  assert.equal(result.id, '123'); assert.equal(result.name, 'demo'); assert.deepEqual(result.folders, []);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].input, { name: 'demo' });
  assert.equal(client.calls[0].options.operationId, result.operationId);
  assert.match(result.operationId, /^[0-9a-f-]{36}$/);
});

test('workspace creation binds the current app device and verifies the primary folder', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-project-'));
  try {
    const client = clientFor();
    const result = await createProject(client, { name: 'folder', workspace });
    assert.deepEqual(result.folders, [{ name: path.basename(workspace), path: workspace, deviceId: 'current', deviceName: 'This Mac', primary: true }]);
    assert.equal(client.calls[0].input.folders[0].folderDeviceId, 'current');
    for (const deviceId of ['', 'other']) {
      const wrong = clientFor({ deviceId });
      await assert.rejects(createProject(wrong, { name: 'folder', workspace }), /device identity/);
      assert.equal(wrong.calls.length, 0);
    }
    const mismatch = clientFor({ readback: project => {
      project.folders[0].folder_device_id = 'other';
      return Response.json({ downlink_body: { list_projects_downlink_body: { projects: [project] } } });
    } });
    await assert.rejects(createProject(mismatch, { name: 'folder', workspace }), e => e.code === 'project_readback_failed' && e.result.id === '123');
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('uncertain creation preserves operation id and never retries the mutation', async () => {
  for (const mutate of [async () => { throw new Error('connection lost'); }, async () => ({})]) {
    const client = clientFor({ mutate });
    await assert.rejects(createProject(client, { name: 'demo' }), error => {
      assert.equal(error.code, 'project_create_unconfirmed');
      assert.equal(error.result.operationId, client.calls[0].options.operationId);
      assert.equal(error.result.status, 'unknown'); assert.equal(error.result.verified, false);
      assert.match(error.message, /before repeating create/);
      return true;
    });
    assert.equal(client.calls.length, 1);
  }
});

test('readback failures preserve the created id without creating a second project', async () => {
  for (const readback of [async () => { throw new Error('offline'); }, async project => {
    project.name = 'different';
    return Response.json({ downlink_body: { list_projects_downlink_body: { projects: [project] } } });
  }]) {
    const client = clientFor({ readback });
    await assert.rejects(createProject(client, { name: 'demo' }), error => {
      assert.equal(error.code, 'project_readback_failed');
      assert.equal(error.result.id, '123'); assert.equal(error.result.status, 'created');
      assert.equal(error.result.verified, false); return true;
    });
    assert.equal(client.calls.length, 1);
  }
});
