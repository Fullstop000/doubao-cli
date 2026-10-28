import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseOptions } from '../src/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures/cli-compatibility.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const base = fixture.metadata.defaultPlatform.linux;

function withPlatform(platform, callback) {
  if (!platform) return callback();
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { return callback(); }
  finally { Object.defineProperty(process, 'platform', original); }
}

function compactResult(argv, platform) {
  try {
    const actual = JSON.parse(JSON.stringify(withPlatform(platform, () => parseOptions(argv))));
    const delta = {};
    const removed = [];
    for (const key of Object.keys(base)) if (!Object.hasOwn(actual, key)) removed.push(key);
    for (const [key, value] of Object.entries(actual)) {
      if (!Object.hasOwn(base, key) || JSON.stringify(value) !== JSON.stringify(base[key])) delta[key] = value;
    }
    return { d: delta, ...(removed.length ? { x: removed } : {}) };
  } catch (error) {
    return { e: error.message };
  }
}

test(`parseOptions matches ${fixture.metadata.cases} frozen baseline cases (${fixture.metadata.sourceCommit})`, () => {
  assert.equal(fixture.metadata.commandPaths, 46);
  assert.deepEqual(fixture.metadata.explicitBackends, ['work', 'doubao', 'headless']);
  assert.equal(fixture.metadata.cases, fixture.cases.length);
  assert.equal(fixture.metadata.outcomes, fixture.outcomes.length);
  assert.ok(fs.statSync(fixturePath).size <= 2 * 1024 * 1024, 'golden fixture must remain under 2 MiB');

  for (const row of fixture.cases) {
    assert.deepEqual(
      compactResult(row.a, row.p),
      fixture.outcomes[row.o],
      `baseline mismatch in ${row.n}: ${JSON.stringify(row.a)}`,
    );
  }
});
