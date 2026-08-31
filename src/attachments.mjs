import fs from 'node:fs/promises';
import path from 'node:path';

const DROP_AREA = '[data-testid="file_drop_area"]';
const ATTACHMENT_ITEM = '[data-testid="attachment_area"] [data-testid="attachment_file_item"]';
const MAX_FILE_COUNT = 50;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 384 * 1024;

const MIME_TYPES = new Map([
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.epub', 'application/epub+zip'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mobi', 'application/x-mobipocket-ebook'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function attachmentMimeType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLocaleLowerCase('en-US')) || 'application/octet-stream';
}

export async function resolveAttachmentFiles(filePaths) {
  if (!Array.isArray(filePaths) || !filePaths.length) return [];
  if (filePaths.length > MAX_FILE_COUNT) throw new Error(`at most ${MAX_FILE_COUNT} attachments can be uploaded at once`);

  const files = [];
  for (const input of filePaths) {
    const resolvedPath = path.resolve(input);
    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      throw new Error(`attachment does not exist: ${resolvedPath}`);
    }
    if (!stat.isFile()) throw new Error(`attachment is not a regular file: ${resolvedPath}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`attachment exceeds the 100 MiB CLI limit: ${resolvedPath}`);
    files.push({
      path: resolvedPath,
      name: path.basename(resolvedPath),
      size: stat.size,
      type: attachmentMimeType(resolvedPath),
      lastModified: Math.trunc(stat.mtimeMs),
    });
  }
  return files;
}

async function stageFiles(client, files, stateKey) {
  await client.evaluate(`globalThis[${JSON.stringify(stateKey)}] = []`);
  for (const [index, file] of files.entries()) {
    await client.evaluate(`globalThis[${JSON.stringify(stateKey)}].push({
      name: ${JSON.stringify(file.name)},
      type: ${JSON.stringify(file.type)},
      lastModified: ${file.lastModified},
      chunks: [],
    })`);
    const bytes = await fs.readFile(file.path);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const base64 = bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64');
      await client.evaluate(`globalThis[${JSON.stringify(stateKey)}][${index}].chunks.push(
        Uint8Array.from(atob(${JSON.stringify(base64)}), (character) => character.charCodeAt(0)),
      )`);
    }
  }
}

async function dispatchDrop(client, stateKey) {
  return client.evaluate(`(() => {
    const records = globalThis[${JSON.stringify(stateKey)}];
    const target = document.querySelector(${JSON.stringify(DROP_AREA)})?.parentElement;
    if (!target) throw new Error('Doubao attachment drop target was not found');
    const transfer = new DataTransfer();
    for (const record of records) {
      transfer.items.add(new File(record.chunks, record.name, {
        type: record.type,
        lastModified: record.lastModified,
      }));
    }
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return [...transfer.files].map((file) => ({ name: file.name, size: file.size, type: file.type }));
  })()`);
}

async function waitForUploads(client, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => {
      const items = [...document.querySelectorAll(${JSON.stringify(ATTACHMENT_ITEM)})].slice(-${expectedCount});
      return items.map((item) => ({
        available: item.getAttribute('data-available') === 'true',
        name: (item.querySelector('[data-testid="message_nested_content_file_name"]')?.innerText || '').trim(),
        status: (item.querySelector('[data-testid="message_nested_content_file_subtitle"]')?.innerText || '').trim(),
      }));
    })()`);
    if (state.length === expectedCount && state.every((item) => item.available)) return state;
    const failed = state.find((item) => /(?:失败|不支持|超出|error|failed)/iu.test(item.status));
    if (failed) throw new Error(`Doubao failed to upload attachment ${failed.name || ''}: ${failed.status}`.trim());
    await delay(250);
  }
  throw new Error(`Doubao attachments did not finish uploading within ${timeoutMs} ms`);
}

async function clearComposerAttachments(client) {
  await client.evaluate(`(() => {
    for (const item of document.querySelectorAll(${JSON.stringify(ATTACHMENT_ITEM)})) {
      item.querySelector('[data-testid="message_nested_content_file_delete"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  })()`);
}

export async function uploadAttachmentsFromClient(client, filePaths, options = {}) {
  const files = await resolveAttachmentFiles(filePaths);
  if (!files.length) return [];
  const existingAttachmentCount = await client.evaluate(`document.querySelectorAll(${JSON.stringify(ATTACHMENT_ITEM)}).length`);
  if (existingAttachmentCount) {
    throw new Error('Doubao composer already contains draft attachments; remove them before using --attach');
  }
  const timeoutMs = options.timeoutMs || 60_000;
  const stateKey = `__doubaoCliUpload_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    await stageFiles(client, files, stateKey);
    const dropped = await dispatchDrop(client, stateKey);
    if (dropped.length !== files.length) throw new Error('Doubao did not accept every attachment from the drop event');
    let uploaded;
    try {
      uploaded = await waitForUploads(client, files.length, timeoutMs);
    } catch (error) {
      await clearComposerAttachments(client).catch(() => {});
      throw error;
    }
    return uploaded.map((item, index) => ({
      name: item.name || files[index].name,
      path: files[index].path,
      size: files[index].size,
      type: files[index].type,
    }));
  } finally {
    await client.evaluate(`delete globalThis[${JSON.stringify(stateKey)}]`).catch(() => {});
  }
}
