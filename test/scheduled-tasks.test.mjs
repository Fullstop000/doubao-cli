import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScheduledTaskService,
  validateScheduledTaskCreate,
  validateScheduledTaskPatch,
} from '../src/scheduled-tasks.mjs';

const job = (id, patch = {}) => ({ job_id: id, job_type: 1, update_version: '2', create_time: '1', update_time: '2',
  content: { cron_job: { title: 'Daily review', prompt: 'Review updates', status: 1, ...patch } } });
const response = data => ({ code: 0, data });
const createInput = { title: 'Daily review', prompt: 'Review updates', timezone: 'Asia/Shanghai',
  schedule: { repeat_type: 3 }, runtime_config: { runtime_type: 1 }, create_context: { bot_id: '7338286299411103781' } };

function fixture(handler) {
  const calls = [];
  const client = { async json(route, options) {
    const call = { route, options, body: JSON.parse(options.body) };
    calls.push(call);
    return handler(call, calls.length);
  } };
  return { calls, service: createScheduledTaskService(client, { timeoutMs: 4321, headers: { 'x-test': 'yes' }, uuid: () => 'local-id', now: () => 1000 }) };
}

test('create input matches the supported scheduled task schema and rejects unsupported fields', () => {
  assert.deepEqual(validateScheduledTaskCreate(createInput), { ...createInput, title: 'Daily review', prompt: 'Review updates', timezone: 'Asia/Shanghai',
    create_context: { bot_id: '7338286299411103781' } });
  assert.throws(() => validateScheduledTaskCreate({ ...createInput, account_id: 'someone-else' }), /unsupported field/u);
  assert.throws(() => validateScheduledTaskCreate({ ...createInput, schedule: { repeat_type: 8 } }), /repeat_type/u);
  assert.throws(() => validateScheduledTaskCreate({ ...createInput, schedule: { repeat_type: 5 } }), /parse_token/u);
  assert.throws(() => validateScheduledTaskCreate({ ...createInput, runtime_config: { runtime_type: 3 } }), /runtime_type/u);
  assert.throws(() => validateScheduledTaskCreate({ ...createInput, sandbox_auth_type: 'Unknown' }), /sandbox_auth_type/u);
  assert.equal(validateScheduledTaskCreate({ ...createInput, sandbox_auth_type: 2 }).sandbox_auth_type, 2);
  assert.equal(validateScheduledTaskCreate({ ...createInput, create_context: {} }).create_context.bot_id,
    '7338286299411103781');
  assert.equal(validateScheduledTaskCreate({ title: 'T', prompt: 'P', timezone: 'UTC' }).create_context.bot_id,
    '7338286299411103781');
  assert.throws(() => validateScheduledTaskCreate({ ...createInput, parse_token: 12 }), /parse_token/u);
});

test('update patches allow only editable fields and validate clear/value wrappers', () => {
  assert.deepEqual(validateScheduledTaskPatch({ title: 'New title', schedule: { repeat_type: 4, weekdays: [1, 3] } }),
    { title: 'New title', schedule: { repeat_type: 4, weekdays: [1, 3] } });
  assert.deepEqual(validateScheduledTaskPatch({ patch: { local_connector_tools: { clear: true } } }),
    { local_connector_tools: { clear: true } });
  assert.throws(() => validateScheduledTaskPatch({ status: 4 }), /unsupported field/u);
  assert.throws(() => validateScheduledTaskPatch({ prompt: '  ' }), /prompt/u);
  assert.throws(() => validateScheduledTaskPatch({ schedule: { repeat_type: 5 } }), /parse_token/u);
  assert.throws(() => validateScheduledTaskPatch({ lark_connector_id: { value: 'id', clear: true } }), /patch must/u);
  assert.throws(() => validateScheduledTaskPatch({ patch: { title: 'A' }, job_type: 2 }), /unsupported field/u);
  assert.throws(() => validateScheduledTaskPatch({ parse_token: 12 }), /parse_token/u);
  assert.throws(() => validateScheduledTaskPatch({}), /must not be empty/u);
});

test('list follows cursor pages and excludes deleted delta entries', async () => {
  const { service, calls } = fixture((call, index) => index === 1
    ? response({ jobs: [job('101'), job('102')], has_more: true, next_cursor: 'next' })
    : response({ jobs: [job('101', { title: 'Updated' }), job('102', { status: 4 }), job('103')], has_more: false }));
  assert.deepEqual(await service.list(), [
    { ...job('101', { title: 'Updated' }), id: '101', title: 'Updated', prompt: 'Review updates' },
    { ...job('103'), id: '103', title: 'Daily review', prompt: 'Review updates' },
  ]);
  assert.deepEqual(calls.map(call => call.route), ['/alice/job_cron/list', '/alice/job_cron/list']);
  assert.deepEqual(calls[0].body, { size: 100, sort_order: 1 });
  assert.deepEqual(calls[1].body, { size: 100, sort_order: 1, cursor: 'next' });
  assert.equal(calls[0].options.timeoutMs, 4321);
  assert.deepEqual(calls[0].options.headers, { 'content-type': 'application/json', 'x-test': 'yes' });
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
});

test('list and get reject jobs with the wrong discriminator', async () => {
  const listed = fixture(() => response({ jobs: [{ ...job('111'), job_type: 3 }], has_more: false }));
  await assert.rejects(listed.service.list(), /invalid job/u);
  const fetched = fixture(() => response({ job: { ...job('112'), job_type: 2 } }));
  await assert.rejects(fetched.service.get('112'), /mismatched job/u);
});

test('list rejects repeated or missing next cursors rather than looping', async () => {
  const { service } = fixture(() => response({ jobs: [], has_more: true, next_cursor: 'same' }));
  await assert.rejects(service.list(), /invalid pagination cursor/u);
});

test('one absolute deadline covers the full pagination chain', async () => {
  let now = 100;
  let calls = 0;
  const service = createScheduledTaskService({ async json() {
    calls += 1;
    now += 6;
    return response({ jobs: [], has_more: true, next_cursor: calls === 1 ? 'next' : 'last' });
  } }, { timeoutMs: 10, now: () => now });
  await assert.rejects(service.list(), /timed out/u);
  assert.equal(calls, 2);
});

test('get uses CronJob type and returns the raw job with a stable id alias', async () => {
  const { service, calls } = fixture(() => response({ job: job('123') }));
  assert.equal((await service.get('123')).id, '123');
  assert.deepEqual(calls[0].body, { job_id: '123', job_type: 1 });
});

test('create sends one request with UUID context then reads the created job back', async () => {
  const { service, calls } = fixture((call, index) => index === 1
    ? response({ job: { job_id: '201' } })
    : response({ job: job('201', { schedule_config: createInput.schedule, runtime_config: createInput.runtime_config, timezone: createInput.timezone }) }));
  const created = await service.create(createInput);
  assert.equal(created.id, '201');
  assert.equal(created.verified, true);
  assert.equal(created.operationId, 'local-id');
  assert.deepEqual(calls.map(call => call.route), ['/alice/job_cron/create', '/alice/job_cron/get']);
  assert.deepEqual(calls[0].body.create_context, { bot_id: '7338286299411103781', local_job_id: 'local-id' });
  assert.equal(calls[1].body.job_type, 1);
});

test('create readback failure reports the operation id and never resends create', async () => {
  const { service, calls } = fixture((call, index) => index === 1
    ? response({ job_id: '202' })
    : response({ job: null }));
  await assert.rejects(service.create(createInput), error => {
    assert.deepEqual(error.result, { id: '202', operationId: 'local-id', status: 'readback_failed' });
    return true;
  });
  assert.deepEqual(calls.map(call => call.route), ['/alice/job_cron/create', '/alice/job_cron/get']);
});

test('schedule readback compares ISO instants at server second precision for create and update', async t => {
  for (const action of ['create', 'update']) {
    for (const [name, actual, passes] of [
      ['timezone and fractional-second normalization', { repeat_type: 1, execute_at: '2027-01-27T11:30:40+08:00' }, true],
      ['different second', { repeat_type: 1, execute_at: '2027-01-27T11:30:41+08:00' }, false],
      ['different timezone instant', { repeat_type: 1, execute_at: '2027-01-27T03:30:40+08:00' }, false],
      ['different repeat type', { repeat_type: 3, execute_at: '2027-01-27T11:30:40+08:00' }, false],
      ['timezone absent', { repeat_type: 1, execute_at: '2027-01-27T03:30:40' }, false],
    ]) await t.test(`${action}: ${name}`, async () => {
      const schedule = { repeat_type: 1, execute_at: '2027-01-27T03:30:40.987Z' };
      const { service, calls } = fixture((call, index) => index === 1
        ? response({ job_id: '205' })
        : response({ job: job('205', { schedule_config: actual, runtime_config: createInput.runtime_config, timezone: createInput.timezone }) }));
      const result = action === 'create' ? service.create({ ...createInput, schedule }) : service.update('205', { schedule });
      if (passes) assert.equal((await result).verified, true);
      else await assert.rejects(result, /readback did not match schedule/u);
      assert.equal(calls.length, 2, 'one mutation and one readback, never retry the mutation');
    });
  }
});

test('update sends only editable patch fields and returns verified readback', async () => {
  const { service, calls } = fixture((call, index) => index === 1
    ? response({ job: job('301') })
    : response({ job: job('301', { title: 'Changed' }) }));
  const updated = await service.update('301', { title: 'Changed' });
  assert.equal(updated.title, 'Changed');
  assert.equal(updated.verified, true);
  assert.equal(updated.operationId, 'local-id');
  assert.deepEqual(calls[0].body, { job_id: '301', job_type: 1, patch: { title: 'Changed' } });
  assert.deepEqual(calls.map(call => call.route), ['/alice/job_cron/update', '/alice/job_cron/get']);
});

test('update readback compares nested schedule arrays and mutable connector values', async () => {
  const patch = { schedule: { repeat_type: 4, weekdays: [1, 3] }, local_connector_tools: { value: 'connector-1' } };
  const { service } = fixture((call, index) => index === 1
    ? response({ job: job('302') })
    : response({ job: job('302', { schedule_config: { ...patch.schedule, display_frequency: 'weekly' }, local_connector_tools: 'connector-1' }) }));
  const updated = await service.update('302', patch);
  assert.equal(updated.verified, true);
});

test('delete requires API confirmation and readback absence or deleted tombstone', async t => {
  await t.test('absent after delete', async () => {
    const { service, calls } = fixture((call, index) => index === 1
      ? response({ success: true })
      : response({ job: null }));
    assert.deepEqual(await service.delete('401'), { id: '401', deleted: true, operationId: 'local-id', verified: true });
    assert.deepEqual(calls.map(call => call.route), ['/alice/job_cron/delete', '/alice/job_cron/get']);
  });
  await t.test('deleted tombstone after delete', async () => {
    const { service } = fixture((call, index) => index === 1
      ? response({ success: true })
      : response({ job: job('402', { status: 4 }) }));
    assert.deepEqual(await service.delete('402'), { id: '402', deleted: true, operationId: 'local-id', verified: true });
  });
  await t.test('still active after delete', async () => {
    const { service, calls } = fixture((call, index) => index === 1
      ? response({ success: true })
      : response({ job: job('403') }));
    await assert.rejects(service.delete('403'), error => {
      assert.deepEqual(error.result, { id: '403', operationId: 'local-id', status: 'readback_failed' });
      return true;
    });
    assert.equal(calls.filter(call => call.route.endsWith('/delete')).length, 1);
  });
  await t.test('unconfirmed response does not trigger readback or retry', async () => {
    const { service, calls } = fixture(() => response({ success: false }));
    await assert.rejects(service.delete('404'), error => {
      assert.deepEqual(error.result, { id: '404', operationId: 'local-id', status: 'unknown' });
      return true;
    });
    assert.equal(calls.length, 1);
  });
});

test('mutation transport failures preserve identifiers and remain explicitly unknown', async () => {
  const { service, calls } = fixture(() => { throw new Error('connection reset'); });
  await assert.rejects(service.update('501', { prompt: 'New prompt' }), error => {
    assert.deepEqual(error.result, { id: '501', operationId: 'local-id', status: 'unknown' });
    return true;
  });
  assert.equal(calls.length, 1);
});

test('create and update readback mismatches are reported as failed verification', async t => {
  await t.test('create mismatch', async () => {
    const { service } = fixture((call, index) => index === 1
      ? response({ job_id: '601' })
      : response({ job: job('601', { schedule_config: createInput.schedule, runtime_config: createInput.runtime_config, timezone: 'UTC' }) }));
    await assert.rejects(service.create(createInput), error => {
      assert.deepEqual(error.result, { id: '601', operationId: 'local-id', status: 'readback_failed' });
      assert.match(error.message, /did not match timezone/u);
      return true;
    });
  });
  await t.test('update mismatch', async () => {
    const { service } = fixture((call, index) => index === 1
      ? response({ job: job('602') })
      : response({ job: job('602', { prompt: 'Old prompt' }) }));
    await assert.rejects(service.update('602', { prompt: 'New prompt' }), error => {
      assert.deepEqual(error.result, { id: '602', operationId: 'local-id', status: 'readback_failed' });
      assert.match(error.message, /did not match prompt/u);
      return true;
    });
  });
});
