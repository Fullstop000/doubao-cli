import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeDeliveryProbe } from '../src/desktop-mcp-delivery.mjs';

const at = new Date();
at.setMilliseconds(0);
const startedAt = at.getTime() - 1000;
const two = n => String(n).padStart(2, '0');
const stamp = date => `${two(date.getMonth() + 1)}${two(date.getDate())}/${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}.000000`;
const line = (meta, event = 'local_file_tool_v2_trace', date = at, worker = '123') =>
  `[${worker}:456:${stamp(date)}:INFO:FRONTEND(0)] [neotix] "Event: ${event} ${JSON.stringify(meta)}", source:  (0)\n`;
async function fixture(t, content = '') {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-delivery-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, 'sdk_storage', 'log');
  await fs.mkdir(dir, { recursive: true });
  const name = `saman_frontend_${at.getFullYear()}.${two(at.getMonth() + 1)}${two(at.getDate())}.0.log`;
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return { dir, file, detect: nativeDeliveryProbe({ dataDir, sandboxId: 'own-sandbox', startedAt }) };
}
const ingress = (sandbox_id = 'own-sandbox', commandID = 'command-1', date = at, worker) => line({ sandbox_id, commandID }, 'multi_env_command_received', date, worker);
const delivery = (delivery = 'dispatcher', commandID = 'command-1', date = at, worker) => line({ delivery, commandID }, 'multi_env_queue_lifecycle', date, worker);

test('native exact sandbox evidence and real frontend command correlation', async t => {
  const f = await fixture(t, ingress() + delivery());
  assert.equal(await f.detect(), 'dispatcher');
  const s = await fixture(t, line({ sandboxId: 'own-sandbox', delivery: 'sse' }));
  assert.equal(await s.detect(), 'sse');
});
test('ignores substring, stale, unrelated sandbox and untrusted event text', async t => {
  const stale = new Date(startedAt - 1000);
  const f = await fixture(t, line({ sandbox_id: 'prefix-own-sandbox', delivery: 'dispatcher' })
    + line({ sandbox_id: 'own-sandbox', delivery: 'sse' }, undefined, stale)
    + ingress('another') + delivery() + line({ sandbox_id: 'own-sandbox', delivery: 'dispatcher' }, 'user_message'));
  assert.equal(await f.detect(), null);
});
test('correlation cannot cross stale record, worker or command identity', async t => {
  for (const content of [ingress('own-sandbox', 'command-1', new Date(startedAt - 1000)) + delivery(),
    ingress() + delivery('dispatcher', 'other'), ingress() + delivery('dispatcher', 'command-1', at, '999'),
    ingress() + ingress('other') + delivery()]) {
    const f = await fixture(t, content); assert.equal(await f.detect(), null);
  }
});
test('conflicting routes remain fail closed on later polls', async t => {
  const f = await fixture(t, ingress() + delivery());
  assert.equal(await f.detect(), 'dispatcher');
  await fs.appendFile(f.file, line({ sandbox_id: 'own-sandbox', delivery: 'sse' }));
  assert.equal(await f.detect(), null);
  assert.equal(await f.detect(), null);
});
test('partial line and truncated file do not authorize execution', async t => {
  const content = ingress() + delivery();
  const f = await fixture(t, content.slice(0, -1));
  assert.equal(await f.detect(), null);
  await fs.appendFile(f.file, '\n');assert.equal(await f.detect(), 'dispatcher');
  await fs.writeFile(f.file, ingress());assert.equal(await f.detect(), null);
});
test('rotation can correlate bounded fresh records in separate log files', async t => {
  const f = await fixture(t, ingress());
  assert.equal(await f.detect(), null);
  const next = f.file.replace('.0.log', '.1.log');
  await fs.writeFile(next, delivery());
  assert.equal(await f.detect(), 'dispatcher');
});
test('bounded window fails closed when fresh records have fallen out of tail', async t => {
  const f = await fixture(t, ingress() + line({ sandbox_id: 'other', padding: 'x'.repeat(2000) }).repeat(150) + delivery());
  assert.equal(await f.detect(), null);
});
test('missing, malformed and symlink logs fail closed', async t => {
  assert.equal(await nativeDeliveryProbe({ dataDir: '/does-not-exist', sandboxId: 'x', startedAt })(), null);
  const f = await fixture(t, line({ sandbox_id: 'own-sandbox', delivery: 'dispatcher' }).replace('"dispatcher"', 'undefined'));
  assert.equal(await f.detect(), null);
  await fs.symlink(f.file, f.file.replace('.0.log', '.1.log'));
  assert.equal(await f.detect(), null);
});
test('large unrelated C++ saman log cannot suppress frontend routing evidence', async t => {
  const f = await fixture(t, ingress() + delivery());
  const main = path.join(f.dir, path.basename(f.file).replace('saman_frontend_', 'saman_'));
  await fs.writeFile(main, `[123:456:${stamp(at)}:INFO:native/component/file.cc(1)] C++ diagnostic\n`.repeat(10000));
  assert.equal(await f.detect(), 'dispatcher');
});
test('tail boundary uses timestamp even when first frontend row is not a routing Event', async t => {
  const old = new Date(startedAt - 2000);
  const unrelated = `[123:456:${stamp(old)}:INFO:FRONTEND(0)] non-event frontend diagnostic\n`;
  const f = await fixture(t, unrelated.repeat(6000) + ingress() + delivery());
  assert.equal(await f.detect(), 'dispatcher');
});
