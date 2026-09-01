import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentsConfirmed,
  conversationDeepLink,
  conversationIdFromUrl,
  replyAfterLastUserMessage,
} from '../src/automation.mjs';
import { attachmentMimeType, attachmentUploadReady, resolveAttachmentFiles } from '../src/attachments.mjs';
import { modelId, normalizeModelName, resolveModelName } from '../src/models.mjs';

test('builds the desktop open-url route for a conversation', () => {
  assert.equal(
    conversationDeepLink('38439138239851266'),
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

test('normalizes documented model aliases', () => {
  assert.equal(normalizeModelName('  GPT-5.6_SOL '), 'gpt 5.6 sol');
  assert.equal(modelId('豆包 2.1 Turbo'), 'doubao-2.1-turbo');
  assert.equal(
    resolveModelName('turbo', ['自动', '豆包 2.1 Turbo', 'GPT-5.6 Sol']),
    '豆包 2.1 Turbo',
  );
  assert.equal(
    resolveModelName('gpt-5.6-sol', ['自动', '豆包 2.1 Turbo', 'GPT-5.6 Sol']),
    'GPT-5.6 Sol',
  );
});

test('rejects unavailable model names with live choices', () => {
  assert.throws(
    () => resolveModelName('missing', ['自动', 'Orange 5.0']),
    /Available models: 自动, Orange 5\.0/u,
  );
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
