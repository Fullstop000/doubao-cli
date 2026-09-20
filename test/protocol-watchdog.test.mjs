import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { evaluateWithWatchdog } from '../src/protocol.mjs';

test('settled page evaluations let the CLI exit without waiting for the deadline', () => {
  const moduleUrl = new URL('../src/protocol.mjs', import.meta.url).href;
  for (const rejects of [false, true]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { evaluateWithWatchdog } from ${JSON.stringify(moduleUrl)};
      const client = {
        evaluate: async () => { ${rejects ? "throw new Error('bridge failed');" : "return 'complete';"} },
        close: () => { throw new Error('settled client must not be closed'); },
      };
      try { console.log(await evaluateWithWatchdog(client, 'test', 60_000)); }
      catch (error) { console.log(error.message); }
    `], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), rejects ? 'bridge failed' : 'complete');
  }
});

test('a pending page evaluation still times out and closes its client', async () => {
  let closed = 0;
  await assert.rejects(evaluateWithWatchdog({
    evaluate: () => new Promise(() => {}),
    close: () => { closed++; },
  }, 'test', 5), { code: 'timeout' });
  assert.equal(closed, 1);
});
