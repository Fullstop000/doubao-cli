import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentsConfirmed,
  conversationDeepLink,
  conversationIdFromUrl,
  replyAfterLastUserMessage,
} from '../src/automation.mjs';
import {
  attachmentMimeType,
  attachmentUploadReady,
  clearUploadedAttachments,
  removeAttachmentsByUploadKey,
  resolveAttachmentFiles,
} from '../src/attachments.mjs';
import { resolveModelName, resolveReasoningEffort } from '../src/models.mjs';

test('builds the desktop open-url route for a conversation', () => {
  assert.equal(
    conversationDeepLink('38439138239851266', { scheme: 'doubao' }),
    'doubao://doubaoapp/open-url?url=https%3A%2F%2Fwww.doubao.com%2Fchat%2F38439138239851266',
  );
});

test('extracts persisted conversation ids and rejects the blank route', () => {
  assert.equal(conversationIdFromUrl('chrome://doubao-chat/chat/38439138239851266'), '38439138239851266');
  assert.equal(conversationIdFromUrl('doubao://doubao-chat/chat'), null);
});

test('resolves regular attachment files without reading their contents', async () => {
  const licensePath = new URL('../LICENSE', import.meta.url).pathname;
  const [file] = await resolveAttachmentFiles([licensePath]);

  assert.equal(file.name, 'LICENSE');
  assert.equal(file.path, licensePath);
  assert.ok(file.size > 0);
  assert.equal(attachmentMimeType('report.pdf'), 'application/pdf');
});

test('rejects missing attachments', async () => {
  await assert.rejects(() => resolveAttachmentFiles(['/tmp/doubao-cli-file-that-does-not-exist']), /does not exist/u);
});

test('confirms every newly sent attachment, including duplicate names', () => {
  const before = [{ role: 'user', text: '', attachments: ['report.pdf'] }];
  const after = [
    ...before,
    { role: 'user', text: '', attachments: ['report.pdf', 'report.pdf', 'notes.md'] },
  ];

  assert.equal(attachmentsConfirmed(before, after, [
    { name: 'report.pdf' },
    { name: 'report.pdf' },
    { name: 'notes.md' },
  ]), true);
  assert.equal(attachmentsConfirmed(before, after, [
    { name: 'report.pdf' },
    { name: 'report.pdf' },
    { name: 'report.pdf' },
  ]), false);
});

test('confirms sent images by new image message count', () => {
  const before = [{ role: 'user', text: '', images: 1 }];
  const after = [...before, { role: 'user', text: '', images: 2 }];
  const images = [
    { name: 'one.png', type: 'image/png' },
    { name: 'two.png', type: 'image/png' },
  ];

  assert.equal(attachmentsConfirmed(before, after, images), true);
  assert.equal(attachmentsConfirmed(before, before, images), false);
});

test('waits for image preview loading and upload progress completion', () => {
  const expected = { files: 0, images: 1 };

  assert.equal(attachmentUploadReady({
    files: [], images: [{ loaded: true }], progressing: true,
  }, expected), false);
  assert.equal(attachmentUploadReady({
    files: [], images: [{ loaded: true }], progressing: false,
  }, expected), true);
});

test('cleans rehydrated uploads by stable fileKey and waits for durable readback', async () => {
  const imageKey = 'tos-cn/example/image.png';
  const preSendLocalKey = 'pre-send:random-upload-id';
  const chatId = 'accepted';
  const params = { chatId, skillType: 'default' };
  const attachments = [
    { localKey: `input-draft:account:conversation:${chatId}:primary:default:0:${imageKey}`, fileKey: imageKey, fileName: 'same.png' },
    { localKey: `input-draft:account:conversation:${chatId}:primary:default:1:${imageKey}`, fileKey: imageKey, fileName: 'same.png' },
    { localKey: 'user-draft:separate-image', fileKey: 'tos-cn/other/image.png', fileName: 'same.png' },
  ];
  let durable = attachments.map(({ fileKey }) => fileKey);
  let readbacks = 0;
  const removed = [];
  const list = () => attachments.map((attachment, index) => ({ ...attachment, index, params }));
  await removeAttachmentsByUploadKey({
    list,
    remove: async (record) => {
      removed.push(record.localKey);
      attachments.splice(attachments.findIndex((item) => item.localKey === record.localKey), 1);
      if (attachments.length === 1) setTimeout(() => { durable = attachments.map(({ fileKey }) => fileKey); }, 8);
    },
    readDurable: async () => { readbacks += 1; return durable; },
  }, [imageKey, imageKey], { timeoutMs: 100, intervalMs: 1 });

  assert.notEqual(preSendLocalKey, removed[0]);
  assert.deepEqual(removed, [
    `input-draft:account:conversation:${chatId}:primary:default:1:${imageKey}`,
    `input-draft:account:conversation:${chatId}:primary:default:0:${imageKey}`,
  ]);
  assert.deepEqual(attachments.map(({ fileKey, fileName }) => ({ fileKey, fileName })), [
    { fileKey: 'tos-cn/other/image.png', fileName: 'same.png' },
  ]);
  assert.deepEqual(durable, ['tos-cn/other/image.png']);
  assert.ok(readbacks > 1);
});

test('does not remove a stable upload identity when duplicate ownership is ambiguous', async () => {
  const records = [0, 1, 2].map((index) => ({
    fileKey: 'remote-image', localKey: `rehydrated:${index}`, index,
    params: { chatId: 'accepted', skillType: 'default' },
  }));
  await assert.rejects(() => removeAttachmentsByUploadKey({
    list: async () => records,
    remove: async () => assert.fail('ambiguous records must be preserved'),
    readDurable: async () => ['remote-image'],
  }, ['remote-image', 'remote-image'], { timeoutMs: 10, intervalMs: 1 }), /identity is ambiguous/u);
  assert.equal(records.length, 3);
});

test('fails cleanup when the native draft repository still contains the uploaded key', async () => {
  let record = { fileKey: 'owned', localKey: 'rehydrated', index: 0, params: { chatId: 'accepted', skillType: 'default' } };
  await assert.rejects(() => removeAttachmentsByUploadKey({
    list: async () => record ? [record] : [],
    remove: async () => { record = undefined; },
    readDurable: async () => ['owned'],
  }, ['owned'], { timeoutMs: 40, intervalMs: 1 }), /native draft repository/u);
});

test('fails cleanup when the native attachment record remains after deletion', async () => {
  const record = { fileKey: 'owned', localKey: 'rehydrated', index: 0, params: { chatId: 'accepted', skillType: 'default' } };
  await assert.rejects(() => removeAttachmentsByUploadKey({
    list: async () => [record],
    remove: async () => {},
    readDurable: async () => ['owned'],
  }, ['owned'], { timeoutMs: 40, intervalMs: 1 }), /native draft repository/u);
});

test('executes attachment cleanup in origin scope and confirms durable removal by stable identity', async () => {
  const ownedKey = 'tos-cn/owned/image.png';
  const unrelatedKey = 'tos-cn/unrelated/image.png';
  const groups = {
    origin: { _default: [{ localKey: 'random-upload-id', fileName: 'same.png', file: { size: 10 } }] },
    accepted: { _default: [{ localKey: 'other-user-draft', fileName: 'same.png', file: { size: 10 } }] },
  };
  const keys = { origin: [ownedKey], accepted: [unrelatedKey] };
  let durable = [
    { address: { accountScope: 'user-1', conversationScope: 'conversation:origin', inputId: 'primary' }, units: { 'input.attachments': { payload: { items: [{ fileKey: ownedKey }] } } } },
    { address: { accountScope: 'user-1', conversationScope: 'conversation:accepted', inputId: 'primary' }, units: { 'input.attachments': { payload: { items: [{ fileKey: unrelatedKey }] } } } },
    { address: { accountScope: 'user-1', conversationScope: 'guidance:new-office-task', inputId: 'primary' }, units: { 'surface-attachments': { payload: { items: [{ fileKey: 'tos-cn/surface/other.png' }] } } } },
  ];
  const attachmentsApi = {
    getAttachmentsKeys: ({ chatId }) => keys[chatId] || [],
    getAttachmentActions: ({ chatId }) => ({ deleteAttachment: async ({ index }) => {
      groups[chatId]._default.splice(index, 1);
      keys[chatId].splice(index, 1);
      setTimeout(() => { durable = durable.filter(record => !Object.values(record.units).flatMap(unit => unit.payload?.items || []).some(item => item.fileKey === ownedKey)); }, 10);
    } }),
  };
  const stores = { Wp: (name) => ({
    getState: () => name === 'attachmentsStore' ? { attachmentsMap: groups } : { preprocessTaskMap: {} },
  }) };
  const exports = { 1: stores, 2: attachmentsApi };
  const req = (id) => exports[id];
  req.m = {
    1: function storesFactory() { /* Wp: chat-ioc-manager: store */ },
    2: function attachmentsFactory() { /* getAttachmentActions: attachmentStatesSelector: */ },
    3: function draftFactory() { /* WebInputDraftRepository: createInputAttachmentDraftUnit: */ },
  };
  req.m[1].toString = () => 'Wp: chat-ioc-manager: store';
  req.m[2].toString = () => 'getAttachmentActions: attachmentStatesSelector:';
  req.m[3].toString = () => 'WebInputDraftRepository: createInputAttachmentDraftUnit:';
  class WebInputDraftRepository {
    constructor() { this.memory = { snapshotAccountRecords: (accountScope) => durable.filter(record => record.address.accountScope === accountScope) }; }
    async get() { return undefined; }
  }
  exports[3] = { WebInputDraftRepository };
  const window = { '@flow-web/desktop:stable': { push: ([, , callback]) => callback(req) } };
  const client = { evaluate: async (expression) => Function('window', 'localStorage', `return ${expression}`)(window, { getItem: () => 'user-1' }) };

  await clearUploadedAttachments(client, { params: { chatId: 'origin', skillType: 'default' }, fileKeys: [ownedKey] }, 'accepted');

  assert.deepEqual(groups.origin._default, []);
  assert.equal(groups.accepted._default[0].localKey, 'other-user-draft');
  assert.deepEqual(durable.flatMap(record => Object.values(record.units).flatMap(unit => unit.payload.items.map(item => item.fileKey))), [unrelatedKey, 'tos-cn/surface/other.png']);
});

test('keeps blank-origin cleanup scoped and rejects memory fallback as durable proof', async () => {
  const ownedKey = 'tos-cn/owned/blank-origin.png';
  const groups = { '': { _default: [{ localKey: 'random-upload', fileName: 'owned.png', file: { size: 4 } }] } };
  const keys = { '': [ownedKey] };
  const attachmentsApi = {
    getAttachmentsKeys: ({ chatId }) => keys[chatId] || [],
    getAttachmentActions: ({ chatId }) => ({ deleteAttachment: async ({ index }) => {
      groups[chatId]._default.splice(index, 1);
      keys[chatId].splice(index, 1);
    } }),
  };
  const stores = { Wp: name => ({ getState: () => name === 'attachmentsStore' ? { attachmentsMap: groups } : { preprocessTaskMap: {} } }) };
  const exports = { 1: stores, 2: attachmentsApi };
  const req = id => exports[id];
  req.m = { 1: function() {}, 2: function() {}, 3: function() {} };
  req.m[1].toString = () => 'Wp: chat-ioc-manager: store';
  req.m[2].toString = () => 'getAttachmentActions: attachmentStatesSelector:';
  req.m[3].toString = () => 'WebInputDraftRepository: createInputAttachmentDraftUnit:';
  class WebInputDraftRepository {
    constructor() {
      this.memoryOnlyAccounts = new Set(['user-1']);
      this.memory = { snapshotAccountRecords: () => [] };
    }
    async get() {}
  }
  exports[3] = { WebInputDraftRepository };
  const window = { '@flow-web/desktop:stable': { push: ([, , callback]) => callback(req) } };
  const client = { evaluate: async expression => Function('window', 'localStorage', `return ${expression}`)(window, { getItem: () => 'user-1' }) };

  await assert.rejects(() => clearUploadedAttachments(client, {
    params: { chatId: '', skillType: 'default' }, fileKeys: [ownedKey],
  }), /memory fallback cannot confirm durable cleanup/u);

  assert.deepEqual(groups['']._default, []);
});

test('accepts live model names unchanged without a static model table', () => {
  const available = ['自动', '豆包 2.1 Turbo', 'Orange 5.0', 'Orange 5.5', 'GPT-6 Astra'];
  for (const name of available) assert.equal(resolveModelName(name, available), name);
});

test('rejects unavailable model names with live choices', () => {
  assert.throws(
    () => resolveModelName('missing', ['自动', 'Orange 5.0']),
    /Available models: 自动, Orange 5\.0/u,
  );
});

test('rejects aliases, model IDs and altered display names', () => {
  const available = ['自动', '豆包 2.1 Turbo', '豆包 2.1 Pro', 'Orange 5.5', 'GPT-6 Astra'];
  for (const value of ['auto', 'turbo', 'pro', 'orange', 'orange-5.5', '5255447810', 'ORANGE_5.5', 'orange 5.5', ' Orange 5.5 ']) {
    assert.throws(() => resolveModelName(value, available), /unknown model/u, value);
  }
  assert.throws(() => resolveModelName('Orange 5.0', available), /unknown model/u);
});

test('resolves reasoning effort names, aliases, and raw values', () => {
  assert.deepEqual(resolveReasoningEffort('low'), { effort: '3', name: 'low' });
  assert.deepEqual(resolveReasoningEffort('medium'), { effort: '4', name: 'medium' });
  assert.deepEqual(resolveReasoningEffort('高'), { effort: '5', name: 'high' });
  assert.deepEqual(resolveReasoningEffort('极高'), { effort: '6', name: 'xhigh' });
  assert.deepEqual(resolveReasoningEffort('MAX'), { effort: '7', name: 'max' });
  assert.deepEqual(resolveReasoningEffort('7'), { effort: '7', name: 'max' });
  assert.throws(() => resolveReasoningEffort('extreme'), /unknown reasoning effort/u);
});

test('finds a reply after the latest matching user message in a virtualized list', () => {
  const messages = [
    { role: 'assistant', text: 'older reply' },
    { role: 'user', text: 'repeatable prompt' },
    { role: 'assistant', text: 'current reply' },
  ];

  assert.deepEqual(replyAfterLastUserMessage(messages, 'repeatable prompt'), {
    role: 'assistant',
    text: 'current reply',
  });
});
