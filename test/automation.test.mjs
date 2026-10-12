import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentsConfirmed,
  conversationDeepLink,
  conversationIdFromUrl,
  replyAfterLastUserMessage,
} from '../src/automation.mjs';
import { attachmentMimeType, attachmentUploadReady, resolveAttachmentFiles } from '../src/attachments.mjs';
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
