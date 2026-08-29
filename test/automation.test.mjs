import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationDeepLink } from '../src/automation.mjs';

test('builds the desktop open-url route for a conversation', () => {
  assert.equal(
    conversationDeepLink('38439138239851266'),
    'doubao://doubaoapp/open-url?url=https%3A%2F%2Fwww.doubao.com%2Fchat%2F38439138239851266',
  );
});
