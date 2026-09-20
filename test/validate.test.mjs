import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReply } from '../src/validate.mjs';

test('accepts valid JSON without a schema', () => {
  assert.deepEqual(validateReply('{"a": 1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(validateReply('[1, 2]'), { ok: true, value: [1, 2] });
});

test('rejects non-JSON replies', () => {
  const result = validateReply('好的，没问题');

  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not valid JSON/u);
});

test('checks required properties and types', () => {
  const schema = {
    type: 'object',
    required: ['name', 'age'],
    properties: { name: { type: 'string' }, age: { type: 'integer' } },
  };

  assert.equal(validateReply('{"name": "豆包", "age": 3}', schema).ok, true);
  assert.equal(validateReply('{"name": "豆包"}', schema).ok, false);
  assert.equal(validateReply('{"name": "豆包", "age": 3.5}', schema).ok, false);
  assert.equal(validateReply('{"name": 1, "age": 3}', schema).ok, false);
});

test('checks enum values', () => {
  const schema = { properties: { level: { enum: ['low', 'high'] } } };

  assert.equal(validateReply('{"level": "low"}', schema).ok, true);
  assert.equal(validateReply('{"level": "middle"}', schema).ok, false);
});

test('checks array items', () => {
  const schema = { type: 'array', items: { type: 'object', required: ['id'] } };

  assert.equal(validateReply('[{"id": 1}, {"id": 2}]', schema).ok, true);
  const result = validateReply('[{"id": 1}, {}]', schema);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /\$\[1\]\.id/u);
});
