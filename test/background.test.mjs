import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { resolveApp, withApp } from '../src/app.mjs';
import { readConversation, sendMessage, setConversationReasoning } from '../src/automation.mjs';

for (const appId of ['work', 'doubao']) {
  for (const [name, run] of [
    ['read', () => readConversation('38439138239851266')],
    ['reasoning', () => setConversationReasoning('38439138239851266', 'low')],
    ['send attachment', () => sendMessage('38439138239851266', 'test', { attachments: [{ name: 'test.txt' }] })],
  ]) {
    test(`${appId} ${name} fails without opening the app when its chat window is closed`, async t => {
      const app = resolveApp(appId, {});
      t.mock.method(globalThis, 'fetch', async url => Response.json(
        String(url).endsWith('/json/version')
          ? { Browser: 'test', 'Protocol-Version': '1.3' }
          : [{ type: 'page', url: `chrome://${app.scheme}-background/`, webSocketDebuggerUrl: 'ws://unused' }],
      ));
      let now = Date.now();
      t.mock.method(Date, 'now', () => (now += 6000));
      const spawnSync = t.mock.method(childProcess, 'spawnSync', () => { throw new Error('unexpected app activation'); });
      const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected focus watcher'); });
      syncBuiltinESMExports();
      try {
        await withApp(app, () => assert.rejects(run, error => {
          assert.match(error.message, /no Doubao chat page found/);
          assert.ok(error.message.includes(`open a chat window in ${app.name} explicitly`));
          return true;
        }));
        assert.equal(spawnSync.mock.callCount(), 0);
        assert.equal(spawn.mock.callCount(), 0);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
}
