import test from 'node:test';
import assert from 'node:assert/strict';

import { uploadHeadlessAttachments } from '../src/headless-attachments.mjs';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function fixtureClient({ uploadHost = 'imagex.example.test', storageHost = 'tos.example.test', finishKey = 'normalized/object-uri', statusOverride } = {}) {
  const calls = [];
  const client = {
    async account(options) { calls.push({ kind: 'account', options }); return { accountId: '123456789' }; },
    async json(route, options) {
      calls.push({ kind: 'api', route, options });
      return { code: 0, data: { service_id: 'service-id', upload_path_prefix: 'unused', upload_host: uploadHost,
        upload_auth_token: { access_key: 'access-key', secret_key: 'secret-key', session_token: 'session-token',
          expired_time: 'future', current_time: 'now' } } };
    },
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      calls.push({ kind: 'storage', url: parsed, options });
      assert.equal(Object.keys(options.headers).some(name => name.toLowerCase() === 'cookie'), false);
      assert.equal(Object.keys(options.headers).some(name => name.toLowerCase() === 'x-tt-passport-csrf-token'), false);
      if (statusOverride) return statusOverride(url, options);
      if (parsed.hostname === 'www.doubao.com' && parsed.pathname === '/top/v1' && options.method === 'GET') {
        assert.equal(parsed.searchParams.get('Action'), 'ApplyImageUpload');
        assert.equal(parsed.searchParams.get('ServiceId'), 'service-id');
        assert.match(parsed.searchParams.get('FileExtension'), /^\.[a-z0-9]+$/iu);
        assert.ok(options.headers.Authorization.startsWith('AWS4-HMAC-SHA256 Credential=access-key/'));
        return response({ Result: { UploadAddress: {
          UploadHosts: [storageHost], SessionKey: 'session-key', UploadHeader: {},
          StoreInfos: [{ Auth: 'store-signature', StoreUri: 'object-uri', UploadID: 'vendor-upload-id' }],
        } } });
      }
      if (parsed.hostname === 'www.doubao.com' && parsed.pathname === '/top/v1' && parsed.searchParams.get('Action') === 'CommitImageUpload') {
        assert.ok(options.headers.Authorization.startsWith('AWS4-HMAC-SHA256 Credential=access-key/'));
        assert.deepEqual(JSON.parse(options.body), { SessionKey: 'session-key' });
        return response({ Result: { Results: [{ Uri: 'committed-uri' }] } });
      }
      assert.equal(parsed.hostname, storageHost);
      if (parsed.searchParams.get('phase') === 'init') {
        assert.equal(options.headers.Authorization, 'store-signature');
        assert.equal(options.headers['X-Storage-U'], '123456789');
        return response({ code: 2000, data: { uploadid: 'multipart-id' } });
      }
      if (parsed.searchParams.get('phase') === 'transfer') {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'store-signature');
        assert.equal(options.headers['X-Storage-U'], '123456789');
        assert.match(options.headers['Content-CRC32'], /^[a-f0-9]{8}$/u);
        return response({ code: 2000, data: {} });
      }
      if (parsed.searchParams.get('phase') === 'finish') {
        assert.equal(options.body, '1:352441c2'); // CRC32 of "abc".
        return response({ code: 2000, data: { key: finishKey } });
      }
      assert.fail(`unexpected upload request ${parsed.href}`);
    },
  };
  return { client, calls };
}

test('uploads a file through imagex/TOS and returns the native attachment block', async () => {
  const { client, calls } = fixtureClient();
  const blocks = await uploadHeadlessAttachments(client, [{ name: 'hello.txt', size: 3, type: 'text/plain', bytes: Buffer.from('abc') }]);
  assert.equal(calls[1].route, '/alice/resource/prepare_upload');
  assert.deepEqual(JSON.parse(calls[1].options.body), { tenant_id: '5', scene_id: '5', resource_type: 1 });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].block_type, 10052);
  const [attachment] = blocks[0].content.attachment_block.attachments;
  assert.equal(attachment.type, 3);
  assert.equal(attachment.file.uri, 'committed-uri');
  assert.equal(attachment.file.name, 'hello.txt');
  assert.equal(attachment.file.size, 3);
  assert.equal(attachment.upload_status, 1);
  assert.equal(calls.filter(call => call.kind === 'storage').length, 5);
  assert.equal(calls[2].url.hostname, 'www.doubao.com');
  assert.equal(calls[2].url.pathname, '/top/v1');
  assert.equal(calls[3].url.hostname, 'tos.example.test');
});

test('accepts a server-normalized TOS key and gates ImageX commit on finish confirmation', async () => {
  const { client, calls } = fixtureClient({ finishKey: 'workspace/normalized/object-uri' });
  const [block] = await uploadHeadlessAttachments(client, [{ name: 'hello.txt', bytes: Buffer.from('abc') }]);
  assert.equal(block.content.attachment_block.attachments[0].file.uri, 'committed-uri');
  assert.ok(calls.some(call => call.kind === 'storage' && call.url.searchParams.get('phase') === 'finish'));
  assert.ok(calls.some(call => call.kind === 'storage' && call.url.searchParams.get('Action') === 'CommitImageUpload'));
});

test('refuses to commit when TOS finish omits its confirmed key', async () => {
  const { client, calls } = fixtureClient({ finishKey: '' });
  await assert.rejects(uploadHeadlessAttachments(client, [{ name: 'hello.txt', bytes: Buffer.from('abc') }]), /did not confirm the completed object/u);
  assert.equal(calls.some(call => call.kind === 'storage' && call.url.searchParams.get('Action') === 'CommitImageUpload'), false);
});

test('uses image resource enum and native image attachment schema', async () => {
  const { client, calls } = fixtureClient();
  const [block] = await uploadHeadlessAttachments(client, [{ name: 'pixel.png', size: 3, type: 'image/png', bytes: Buffer.from('abc') }]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { tenant_id: '5', scene_id: '5', resource_type: 2 });
  const [attachment] = block.content.attachment_block.attachments;
  assert.equal(attachment.type, 1);
  assert.equal(attachment.image.uri, 'committed-uri');
  assert.equal(attachment.image.name, 'pixel.png');
  assert.deepEqual(attachment.image.image_ori, { url: '', width: 0, height: 0, format: 'png', url_formats: {} });
});

test('matches the app formatter by grouping mixed uploads into one attachment block', async () => {
  const { client } = fixtureClient();
  const blocks = await uploadHeadlessAttachments(client, [
    { name: 'one.txt', size: 3, type: 'text/plain', bytes: Buffer.from('abc') },
    { name: 'two.png', size: 3, type: 'image/png', bytes: Buffer.from('abc') },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].block_type, 10052);
  const attachments = blocks[0].content.attachment_block.attachments;
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments.map(item => item.type), [3, 1]);
  assert.deepEqual(attachments.map(item => item.file?.name || item.image?.name), ['one.txt', 'two.png']);
});

test('uses only the server-issued storage host and refuses redirects', async () => {
  const { client } = fixtureClient({ statusOverride(url) {
    if (new URL(url).hostname === 'tos.example.test') return response({}, 302);
    return response({ Result: { UploadAddress: { UploadHosts: ['tos.example.test'], SessionKey: 's',
      UploadHeader: {}, StoreInfos: [{ Auth: 'sig', StoreUri: 'oid', UploadID: 'vendor-id' }] } } });
  } });
  await assert.rejects(uploadHeadlessAttachments(client, [{ name: 'a.txt', bytes: Buffer.from('a') }]), /redirected/u);
});

test('rejects invalid resource authorization before any storage upload', async () => {
  const { client, calls } = fixtureClient();
  client.json = async () => ({ code: 710010202, msg: 'invalid' });
  await assert.rejects(uploadHeadlessAttachments(client, [{ name: 'a.txt', bytes: Buffer.from('a') }]), /authorization was unavailable/u);
  assert.equal(calls.filter(call => call.kind === 'storage').length, 0);
});

test('does not upload empty or changed local files', async () => {
  const { client, calls } = fixtureClient();
  await assert.rejects(uploadHeadlessAttachments(client, [{ name: 'empty.txt', bytes: Buffer.alloc(0) }]), /empty/u);
  await assert.rejects(uploadHeadlessAttachments(client, [{ name: 'changed.txt', size: 2, bytes: Buffer.from('a') }]), /changed/u);
  assert.equal(calls.filter(call => call.kind === 'api').length, 0);
});

test('one upload deadline prevents the next multipart request after expiry', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const { client, calls } = fixtureClient();
    const fetch = client.fetchImpl;
    client.fetchImpl = async (url, options) => {
      const result = await fetch(url, options);
      const parsed = new URL(url);
      if (parsed.hostname === 'tos.example.test' && parsed.searchParams.get('phase') === 'init') now += 1000;
      return result;
    };

    await assert.rejects(uploadHeadlessAttachments(client, [
      { name: 'hello.txt', bytes: Buffer.from('abc') },
    ], 1000), error => error.code === 'timeout');
    assert.equal(calls.filter(call => call.kind === 'api').length, 1);
    assert.deepEqual(calls.filter(call => call.kind === 'storage').map(call => call.url.searchParams.get('phase') || call.url.searchParams.get('Action')),
      ['ApplyImageUpload', 'init']);
  } finally { Date.now = originalNow; }
});

test('one deadline spans all files and prevents preparing another after a completed upload', async () => {
  const originalNow = Date.now;
  let now = 20_000;
  Date.now = () => now;
  try {
    const { client, calls } = fixtureClient();
    const fetch = client.fetchImpl;
    client.fetchImpl = async (url, options) => {
      const result = await fetch(url, options);
      const parsed = new URL(url);
      if (parsed.searchParams.get('Action') === 'CommitImageUpload') now += 1000;
      return result;
    };

    await assert.rejects(uploadHeadlessAttachments(client, [
      { name: 'first.txt', bytes: Buffer.from('abc') },
      { name: 'second.txt', bytes: Buffer.from('abc') },
    ], 1000), error => error.code === 'timeout');
    assert.equal(calls.filter(call => call.kind === 'api').length, 1);
    assert.equal(calls.filter(call => call.kind === 'storage' && call.url.searchParams.get('Action') === 'CommitImageUpload').length, 1);
  } finally { Date.now = originalNow; }
});
