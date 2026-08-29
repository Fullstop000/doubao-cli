import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionSnapshot } from '../src/storage.mjs';

function record(id, title, marker = 0x63) {
  const key = Buffer.from(`conversation_id\x22\x11${id}\x22\x04name`, 'latin1');
  const value = marker === 0x63 ? Buffer.from(title, 'utf16le') : Buffer.from(title, 'utf8');
  return Buffer.concat([key, Buffer.from([marker, value.length]), value, Buffer.from('pinned_time')]);
}

test('parses UTF-16LE session names from a structured-clone snapshot', () => {
  const buffer = Buffer.concat([
    Buffer.from('pull_recent_conv_chain_downlink_body'),
    record('38439138239851266', '对话主题'),
    record('38439029209786114', '询问车辆类型'),
  ]);
  assert.deepEqual(parseSessionSnapshot(buffer), [
    { id: '38439138239851266', title: '对话主题' },
    { id: '38439029209786114', title: '询问车辆类型' },
  ]);
});

test('parses one-byte session names and ignores duplicate ids', () => {
  const buffer = Buffer.concat([
    record('38439138239851266', 'TCS OpenAPI', 0x22),
    record('38439138239851266', 'duplicate', 0x22),
  ]);
  assert.deepEqual(parseSessionSnapshot(buffer), [
    { id: '38439138239851266', title: 'TCS OpenAPI' },
  ]);
});
