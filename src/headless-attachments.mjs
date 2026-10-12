import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const RESOURCE_ENDPOINT = '/alice/resource/prepare_upload';
// The bundled UploaderService passes its server-issued upload_host through an
// adapter that resolves to this first-party ImageX proxy endpoint.
const IMAGE_API_URL = 'https://www.doubao.com/top/v1';
const TENANT_ID = '5';
const SCENE_ID = '5';
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const PART_BYTES = 5 * 1024 * 1024;
const BLOCK_ATTACHMENT = 10052;
const FILE_ATTACHMENT = 3;
const IMAGE_ATTACHMENT = 1;
const MIME_TYPES = new Map([
  ['.csv', 'text/csv'], ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.epub', 'application/epub+zip'], ['.gif', 'image/gif'], ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'], ['.json', 'application/json'], ['.md', 'text/markdown'],
  ['.mobi', 'application/x-mobipocket-ebook'], ['.pdf', 'application/pdf'], ['.png', 'image/png'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.txt', 'text/plain'], ['.webp', 'image/webp'], ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
  return Object.keys(params).sort().flatMap(key => {
    const values = Array.isArray(params[key]) ? [...params[key]].map(String).sort() : [String(params[key])];
    return values.map(value => `${rfc3986(key)}=${rfc3986(value)}`);
  }).join('&');
}

function signImageX(method, url, params, body, credentials, date = new Date()) {
  const urlObj = new URL(url);
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const dateStamp = timestamp.slice(0, 8);
  const bodyHash = body === undefined ? undefined : sha256(body);
  const headers = {
    'x-amz-date': timestamp,
    'x-amz-security-token': credentials.sessionToken,
    ...(bodyHash ? { 'x-amz-content-sha256': bodyHash } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(name => `${name}:${String(headers[name]).trim().replace(/\s+/gu, ' ')}\n`).join('');
  const canonicalRequest = [method.toUpperCase(), urlObj.pathname, canonicalQuery(params), canonicalHeaders,
    signedHeaders, bodyHash || sha256('')].join('\n');
  const scope = `${dateStamp}/cn-north-1/imagex/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, 'cn-north-1');
  const serviceKey = hmac(regionKey, 'imagex');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function hostOrigin(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) throw new Error(`Doubao returned an invalid ${label}`);
  const input = /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `https://${value}`;
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Doubao returned an invalid ${label}`);
  }
  return url.origin;
}

function nativeFileExtension(name) {
  const suffix = path.extname(name);
  return suffix && suffix.length <= 8 ? suffix : '';
}

function uploadHeaders(record, userId, extra = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(record.UploadHeader || {})) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/u.test(key) || typeof value !== 'string' || /[\r\n]/u.test(value)) continue;
    if (/^(?:authorization|cookie|host|x-storage-u)$/iu.test(key)) continue;
    headers[key] = value;
  }
  return { ...headers, ...extra, Authorization: record.Auth, 'X-Storage-U': encodeURIComponent(userId) };
}

async function rawJson(fetchImpl, url, { method, headers, body, timeoutMs }) {
  const response = await fetchImpl(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  });
  if (response.status >= 300 && response.status < 400) throw new Error('The upload host redirected the request; refusing to forward upload credentials');
  if (!response.ok) throw new Error(`Doubao upload host rejected the request (${response.status})`);
  try { return await response.json(); } catch { throw new Error('Doubao upload host returned invalid JSON'); }
}

function assertVendorSuccess(response, label) {
  if (response?.ResponseMetadata?.Error) {
    const error = response.ResponseMetadata.Error;
    throw new Error(`Doubao ${label} failed (${String(error.Code || error.CodeN || 'unknown')})`);
  }
  return response?.Result;
}

function assertTosSuccess(response, label) {
  if (response?.code !== 2000 || !response.data || typeof response.data !== 'object') {
    throw new Error(`Doubao storage ${label} failed (${response?.code ?? 'invalid response'})`);
  }
  return response.data;
}

async function prepareResource(client, resourceType, remaining) {
  const response = await client.json(RESOURCE_ENDPOINT, {
    method: 'POST', timeoutMs: remaining(),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_ID, scene_id: SCENE_ID, resource_type: resourceType }),
  });
  const data = response?.data;
  const token = data?.upload_auth_token;
  if (response?.code !== 0 || !data?.service_id || !data.upload_host
    || !token?.access_key || !token?.secret_key || !token?.session_token) {
    throw new Error(`Doubao attachment upload authorization was unavailable (${response?.code ?? 'invalid response'})`);
  }
  return {
    serviceId: String(data.service_id),
    // ResourcePrepareUpload returns upload_host, but the packaged
    // UploaderService routes ImageX Apply/Commit through its fixed /top/v1
    // adapter. The storage data host comes from ApplyImageUpload instead.
    imageApiUrl: IMAGE_API_URL,
    credentials: { accessKeyId: token.access_key, secretAccessKey: token.secret_key, sessionToken: token.session_token },
  };
}

async function applyImageUpload(fetchImpl, resource, file, userId, remaining) {
  const params = {
    Action: 'ApplyImageUpload',
    FileSize: String(file.bytes.length),
    NeedFallback: 'true',
    ServiceId: resource.serviceId,
    Version: '2018-08-01',
    s: Math.random().toString(36).slice(2),
    ...(nativeFileExtension(file.name) ? { FileExtension: nativeFileExtension(file.name) } : {}),
  };
  const url = `${resource.imageApiUrl}?${canonicalQuery(params)}`;
  const headers = signImageX('GET', url, params, undefined, resource.credentials);
  const response = await rawJson(fetchImpl, url, { method: 'GET', headers, timeoutMs: remaining() });
  const result = assertVendorSuccess(response, 'upload preparation');
  const address = result?.UploadAddress;
  const store = address?.StoreInfos?.[0];
  const tosOrigin = hostOrigin(address?.UploadHosts?.[0], 'TOS upload host');
  if (!store?.Auth || !store?.StoreUri || !store.UploadID || !address.SessionKey || /[\r\n]/u.test(store.Auth)) {
    throw new Error('Doubao returned an incomplete attachment upload session');
  }
  return {
    tosOrigin,
    record: { Auth: store.Auth, StoreUri: String(store.StoreUri), UploadID: String(store.UploadID),
      SessionKey: String(address.SessionKey), UploadHeader: address.UploadHeader || {} },
  };
}

async function uploadTos(fetchImpl, session, bytes, userId, remaining) {
  const { tosOrigin, record } = session;
  const base = `${tosOrigin}/upload/v1/${encodeURIComponent(record.StoreUri)}`;
  const init = await rawJson(fetchImpl, `${base}?uploadmode=part&phase=init`, {
    method: 'POST', headers: uploadHeaders(record, userId), timeoutMs: remaining(),
  });
  const uploadId = assertTosSuccess(init, 'multipart initialization').uploadid;
  if (typeof uploadId !== 'string' || !uploadId) throw new Error('Doubao storage returned no multipart upload id');

  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
    const part = bytes.subarray(offset, Math.min(offset + PART_BYTES, bytes.length));
    const checksum = crc32(part);
    const partNumber = parts.length + 1;
    const url = `${base}?uploadid=${encodeURIComponent(uploadId)}&part_number=${partNumber}&phase=transfer`;
    const response = await rawJson(fetchImpl, url, {
      method: 'POST', headers: uploadHeaders(record, userId, { 'Content-CRC32': checksum }), body: part, timeoutMs: remaining(),
    });
    assertTosSuccess(response, `multipart part ${partNumber}`);
    parts.push(checksum);
  }

  const finishUrl = `${base}?uploadmode=part&phase=finish&uploadid=${encodeURIComponent(uploadId)}`;
  const finish = await rawJson(fetchImpl, finishUrl, {
    method: 'POST', headers: uploadHeaders(record, userId), body: parts.map((checksum, index) => `${index + 1}:${checksum}`).join(','), timeoutMs: remaining(),
  });
  const result = assertTosSuccess(finish, 'multipart completion');
  // Native ImageX SDK gates merge success on code===2000 and a nonempty
  // data.key; TOS may return a normalized/prefixed key that differs from the
  // requested StoreUri. Keep the server-confirmed key with the session and
  // require it before committing the corresponding ImageX SessionKey.
  if (typeof result.key !== 'string' || !result.key || /[\r\n]/u.test(result.key)) {
    throw new Error('Doubao storage did not confirm the completed object');
  }
  return { ...session, uploadId, storageKey: result.key };
}

async function commitImageUpload(fetchImpl, resource, session, remaining) {
  if (typeof session.storageKey !== 'string' || !session.storageKey) {
    throw new Error('Doubao storage did not confirm the completed object');
  }
  const params = { Action: 'CommitImageUpload', ServiceId: resource.serviceId, Version: '2018-08-01' };
  const body = JSON.stringify({ SessionKey: session.record.SessionKey });
  const url = `${resource.imageApiUrl}?${canonicalQuery(params)}`;
  const headers = signImageX('POST', url, params, body, resource.credentials);
  const response = await rawJson(fetchImpl, url, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body, timeoutMs: remaining(),
  });
  const result = assertVendorSuccess(response, 'upload commit');
  const uri = result?.Results?.[0]?.Uri;
  if (typeof uri !== 'string' || !uri) throw new Error('Doubao did not return the committed attachment URI');
  return uri;
}

async function readFile(file) {
  const name = path.basename(String(file?.name || (file?.path && path.basename(file.path)) || ''));
  if (!name || /[\r\n]/u.test(name)) throw new Error('Attachment must have a valid file name');
  let bytes;
  if (Buffer.isBuffer(file?.bytes) || file?.bytes instanceof Uint8Array) bytes = Buffer.from(file.bytes);
  else if (typeof file?.path === 'string') bytes = await fs.readFile(file.path);
  else throw new Error('Attachment must provide a local path or bytes');
  if (!bytes.length) throw new Error(`Attachment is empty: ${name}`);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Attachment exceeds the 100 MiB CLI limit: ${name}`);
  if (file.size !== undefined && Number(file.size) !== bytes.length) throw new Error(`Attachment changed while being prepared: ${name}`);
  const extension = path.extname(name).toLowerCase();
  return { name, bytes, type: MIME_TYPES.get(extension) || 'application/octet-stream', image: (file.type || MIME_TYPES.get(extension) || '').startsWith('image/') };
}

function attachmentRecord(file, uri) {
  const localKey = randomUUID();
  return file.image
    ? { type: IMAGE_ATTACHMENT, identifier: localKey,
      image: { name: file.name, uri, image_ori: { url: '', width: 0, height: 0,
        format: path.extname(file.name).slice(1).toLowerCase(), url_formats: {} } },
      parse_state: 0, review_state: 0, upload_status: 1, progress: 100, src: '' }
    : { type: FILE_ATTACHMENT, identifier: localKey,
      file: { uri, url: '', file_type: 0, name: file.name, size: file.bytes.length },
      parse_state: 0, review_state: 0, upload_status: 1, progress: 100, src: '' };
}

function attachmentBlock(attachments) {
  return { block_type: BLOCK_ATTACHMENT, content: { attachment_block: { attachments }, pc_event_block: '' },
    block_id: randomUUID(), parent_id: '', meta_info: [], append_fields: [] };
}

/** Upload local files through the packaged Doubao imagex/TOS protocol and return native attachment blocks. */
export async function uploadHeadlessAttachments(client, files, timeoutMs = 60_000) {
  if (typeof client?.json !== 'function' || typeof client?.fetchImpl !== 'function') {
    throw new TypeError('Headless attachment client must provide json() and fetchImpl');
  }
  if (!Array.isArray(files) || !files.length) return [];
  if (files.length > 50) throw new Error('at most 50 attachments can be uploaded at once');
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw Object.assign(new Error('Headless request timed out'), { code: 'timeout' });
    return value;
  };
  const account = await client.account({ timeoutMs: remaining() });
  const prepared = [];
  for (const input of files) {
    remaining();
    prepared.push(await readFile(input));
    remaining();
  }
  const attachments = [];
  for (const file of prepared) {
    const resource = await prepareResource(client, file.image ? 2 : 1, remaining);
    const session = await applyImageUpload(client.fetchImpl, resource, file, account.accountId, remaining);
    const completedSession = await uploadTos(client.fetchImpl, session, file.bytes, account.accountId, remaining);
    const uri = await commitImageUpload(client.fetchImpl, resource, completedSession, remaining);
    attachments.push(attachmentRecord(file, uri));
  }
  return [attachmentBlock(attachments)];
}
