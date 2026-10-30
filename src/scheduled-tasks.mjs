import { randomUUID } from 'node:crypto';

export const SCHEDULED_TASK_ROUTES = Object.freeze({
  list: '/alice/job_cron/list',
  get: '/alice/job_cron/get',
  create: '/alice/job_cron/create',
  update: '/alice/job_cron/update',
  delete: '/alice/job_cron/delete',
});

const JOB_TYPE_CRON = 1;
const SORT_ASC = 1;
const REPEAT_TYPES = new Set([1, 2, 3, 4, 5]);
const WEEKDAYS = new Set([1, 2, 3, 4, 5, 6, 7]);
const RUNTIME_TYPES = new Set([1, 2]);
const SANDBOX_AUTH_TYPES = new Set([0, 1, 2]);
const CREATE_FIELDS = new Set([
  'title', 'prompt', 'schedule', 'runtime_config', 'timezone', 'deep_think_switch', 'model_config',
  'parse_token', 'project_id', 'sandbox_auth_type', 'local_connector_tools', 'lark_connector_id', 'create_context',
]);
const UPDATE_FIELDS = new Set([
  'title', 'prompt', 'schedule', 'parse_token', 'sandbox_auth_type', 'local_connector_tools', 'lark_connector_id',
]);

function fail(message) { throw new TypeError(`scheduled task ${message}`); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.trim();
}
function assertOnlyKeys(value, allowed, name) {
  const extra = Object.keys(value).find(key => !allowed.has(key));
  if (extra) fail(`${name} contains unsupported field "${extra}"`);
}
function validateSchedule(schedule) {
  if (schedule === undefined) return;
  if (!isObject(schedule)) fail('schedule must be an object');
  if (!REPEAT_TYPES.has(schedule.repeat_type)) fail('schedule.repeat_type must be 1 (no repeat), 2 (hourly), 3 (daily), 4 (weekly), or 5 (custom)');
  if (schedule.weekdays !== undefined
    && (!Array.isArray(schedule.weekdays) || schedule.weekdays.some(day => !WEEKDAYS.has(day)))) {
    fail('schedule.weekdays must contain weekday enum values 1 through 7');
  }
}
function validateRuntime(runtime) {
  if (runtime === undefined) return;
  if (!isObject(runtime) || !RUNTIME_TYPES.has(runtime.runtime_type)) {
    fail('runtime_config.runtime_type must be 1 (cloud) or 2 (local device)');
  }
}
function validateSandboxAuth(value, field) {
  if (value !== undefined && !SANDBOX_AUTH_TYPES.has(value)) {
    fail(`${field} must be 0 (AlwaysAsk), 1 (AskOnRisk), or 2 (FullAccess)`);
  }
}
function validateParseToken(value, field) {
  if (value !== undefined) nonempty(value, field);
}
function validatePatchValue(patch, field) {
  const value = patch[field];
  if (value === undefined) return;
  if (field === 'title' || field === 'prompt') nonempty(value, field);
  if (field === 'schedule') validateSchedule(value);
  if (field === 'sandbox_auth_type') validateSandboxAuth(value, field);
  if (field === 'local_connector_tools' || field === 'lark_connector_id') {
    if (!isObject(value) || (value.value !== undefined) === (value.clear === true)
      || value.value !== undefined && (typeof value.value !== 'string' || !value.value.trim())
      || value.clear !== undefined && value.clear !== true) {
      fail(`${field} patch must contain a non-empty value or clear: true`);
    }
    assertOnlyKeys(value, new Set(['value', 'clear']), `${field} patch`);
  }
}

/** Validate and normalize JSON file content for `automations create --file`. */
export function validateScheduledTaskCreate(input) {
  if (!isObject(input)) fail('input must be a JSON object');
  assertOnlyKeys(input, CREATE_FIELDS, 'create input');
  const title = nonempty(input.title, 'title');
  const prompt = nonempty(input.prompt, 'prompt');
  validateSchedule(input.schedule);
  validateRuntime(input.runtime_config);
  nonempty(input.timezone, 'timezone');
  validateSandboxAuth(input.sandbox_auth_type, 'sandbox_auth_type');
  for (const field of ['project_id', 'parse_token', 'local_connector_tools', 'lark_connector_id']) {
    if (input[field] !== undefined) nonempty(input[field], field);
  }
  validateParseToken(input.parse_token, 'parse_token');
  if (input.schedule?.repeat_type === 5 && input.parse_token === undefined) {
    fail('parse_token is required for a custom schedule');
  }
  if (input.create_context !== undefined && !isObject(input.create_context)) fail('create_context must be an object');
  const botId = input.create_context?.bot_id === undefined
    ? '7338286299411103781'
    : nonempty(input.create_context.bot_id, 'create_context.bot_id');
  return {
    ...input,
    title,
    prompt,
    timezone: input.timezone.trim(),
    create_context: { bot_id: botId },
  };
}

/** Validate and normalize JSON file content for `automations update <id> --file`. */
export function validateScheduledTaskPatch(input) {
  if (!isObject(input)) fail('update input must be a JSON object');
  if (Object.hasOwn(input, 'patch')) assertOnlyKeys(input, new Set(['patch']), 'update input');
  const patch = input.patch === undefined ? input : input.patch;
  if (!isObject(patch)) fail('patch must be a JSON object');
  assertOnlyKeys(patch, UPDATE_FIELDS, 'update patch');
  if (!Object.keys(patch).length) fail('update patch must not be empty');
  for (const field of UPDATE_FIELDS) validatePatchValue(patch, field);
  validateParseToken(patch.parse_token, 'parse_token');
  if (patch.schedule?.repeat_type === 5 && patch.parse_token === undefined) {
    fail('parse_token is required when setting a custom schedule');
  }
  return { ...patch };
}

function resultData(response, action) {
  if (!response || (response.code !== undefined && response.code !== 0)
    || !isObject(response.data)) {
    throw new Error(`scheduled task ${action} failed: ${response?.message || response?.msg || response?.code || 'invalid response'}`);
  }
  return response.data;
}

function cronJobContent(job) { return job?.content?.cron_job ?? job?.cron_job ?? job; }
function validJob(job) {
  return isObject(job) && typeof job.job_id === 'string' && job.job_id.trim().length > 0
    && job.job_type === JOB_TYPE_CRON && isObject(job.content) && isObject(job.content.cron_job);
}
function isDeleted(job) { return cronJobContent(job)?.status === 4; }
function normalizeJob(job) {
  if (!isObject(job) || typeof job.job_id !== 'string' || !job.job_id.trim()) return job;
  const content = cronJobContent(job);
  return { ...job, id: job.job_id, ...(content?.title !== undefined ? { title: content.title } : {}),
    ...(content?.prompt !== undefined ? { prompt: content.prompt } : {}) };
}

function operationError(error, { id, operationId, status }) {
  const wrapped = new Error(error.message || String(error));
  wrapped.cause = error;
  wrapped.result = { ...(id ? { id } : {}), ...(operationId ? { operationId } : {}), status };
  return wrapped;
}

function jsonRequest(body, timeoutMs, headers) {
  return { method: 'POST', body: JSON.stringify(body), ...(timeoutMs === undefined ? {} : { timeoutMs }),
    headers: { 'content-type': 'application/json', ...headers } };
}

export function createScheduledTaskService(client, { timeoutMs, headers, uuid = randomUUID, now = Date.now } = {}) {
  if (!client || typeof client.json !== 'function') throw new TypeError('scheduled task client.json is required');
  const context = () => ({ deadline: timeoutMs === undefined ? undefined : now() + timeoutMs });
  const request = (route, body, ctx) => {
    let remaining = timeoutMs;
    if (ctx.deadline !== undefined) {
      remaining = ctx.deadline - now();
      if (remaining <= 0) throw new Error('scheduled task operation timed out');
    }
    return client.json(route, jsonRequest(body, remaining, headers));
  };

  async function get(id, ctx = context()) {
    const data = resultData(await request(SCHEDULED_TASK_ROUTES.get, { job_id: nonempty(id, 'id'), job_type: JOB_TYPE_CRON }, ctx), 'get');
    if (data.job === null || data.job === undefined) return undefined;
    if (!validJob(data.job) || data.job.job_id !== id) throw new Error('scheduled task get returned a mismatched job');
    return normalizeJob(data.job);
  }

  return {
    async list() {
      const ctx = context();
      const latest = new Map();
      const seenCursors = new Set();
      let cursor;
      do {
        const body = { size: 100, sort_order: SORT_ASC, ...(cursor === undefined ? {} : { cursor }) };
        const data = resultData(await request(SCHEDULED_TASK_ROUTES.list, body, ctx), 'list');
        if (!Array.isArray(data.jobs) || typeof data.has_more !== 'boolean') throw new Error('scheduled task list returned an invalid page');
        for (const job of data.jobs) {
          if (!validJob(job)) throw new Error('scheduled task list returned an invalid job');
          latest.set(`${job.job_type}\0${job.job_id}`, job);
        }
        if (!data.has_more) break;
        if (typeof data.next_cursor !== 'string' || !data.next_cursor.trim() || seenCursors.has(data.next_cursor)) {
          throw new Error('scheduled task list returned an invalid pagination cursor');
        }
        cursor = data.next_cursor;
        seenCursors.add(cursor);
      } while (true);
      return [...latest.values()].filter(job => !isDeleted(job)).map(normalizeJob);
    },
    get,
    async create(input) {
      const values = validateScheduledTaskCreate(input);
      const operationId = uuid();
      const ctx = context();
      const payload = { ...values, create_context: { ...values.create_context, local_job_id: operationId } };
      let data;
      try {
        data = resultData(await request(SCHEDULED_TASK_ROUTES.create, payload, ctx), 'create');
      } catch (error) {
        throw operationError(error, { operationId, status: 'unknown' });
      }
      const id = data.job?.job_id ?? data.job_id;
      if (typeof id !== 'string' || !id.trim()) {
        throw operationError(new Error('scheduled task create response did not include a job ID'), { operationId, status: 'unknown' });
      }
      try {
        const job = await get(id, ctx);
        if (!job || isDeleted(job)) throw new Error('created job was not present in readback');
        verifySubmitted(job, values);
        return { ...normalizeJob(job), operationId, verified: true };
      } catch (error) {
        throw operationError(error, { id, operationId, status: 'readback_failed' });
      }
    },
    async update(id, input) {
      id = nonempty(id, 'id');
      const patch = validateScheduledTaskPatch(input);
      const operationId = uuid();
      const ctx = context();
      try {
        resultData(await request(SCHEDULED_TASK_ROUTES.update, { job_id: id, job_type: JOB_TYPE_CRON, patch }, ctx), 'update');
      } catch (error) {
        throw operationError(error, { id, operationId, status: 'unknown' });
      }
      try {
        const job = await get(id, ctx);
        if (!job || isDeleted(job)) throw new Error('updated job was not present in readback');
        verifyPatch(job, patch);
        return { ...normalizeJob(job), operationId, verified: true };
      } catch (error) {
        throw operationError(error, { id, operationId, status: 'readback_failed' });
      }
    },
    async delete(id) {
      id = nonempty(id, 'id');
      const operationId = uuid();
      const ctx = context();
      try {
        const data = resultData(await request(SCHEDULED_TASK_ROUTES.delete, { job_id: id, job_type: JOB_TYPE_CRON }, ctx), 'delete');
        if (data.success !== true) throw new Error('scheduled task delete was not confirmed');
      } catch (error) {
        throw operationError(error, { id, operationId, status: 'unknown' });
      }
      try {
        const job = await get(id, ctx);
        if (job && !isDeleted(job)) throw new Error('deleted job remains present in readback');
        return { id, deleted: true, operationId, verified: true };
      } catch (error) {
        throw operationError(error, { id, operationId, status: 'readback_failed' });
      }
    },
  };
}

function sameValue(actual, expected, { subset = false } = {}) {
  if (actual === expected) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((value, index) => sameValue(value, expected[index], { subset }));
  }
  if (!isObject(actual) || !isObject(expected)) return false;
  const a = Object.keys(actual).sort();
  const e = Object.keys(expected).sort();
  return (subset ? e.every(key => a.includes(key)) : a.length === e.length && a.every((key, index) => key === e[index]))
    && e.every(key => sameValue(actual[key], expected[key], { subset }));
}

function normalizedSchedule(schedule) {
  if (!isObject(schedule) || typeof schedule.execute_at !== 'string') return schedule;
  // The service returns execute_at in the job timezone at whole-second precision.
  // Compare explicit ISO instants, while retaining exact checks for all other fields.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(schedule.execute_at)) return schedule;
  const milliseconds = Date.parse(schedule.execute_at);
  return Number.isFinite(milliseconds) ? { ...schedule, execute_at: Math.floor(milliseconds / 1000) } : schedule;
}

function verifyFields(job, fields) {
  const content = cronJobContent(job);
  for (const [field, expected] of Object.entries(fields)) {
    const actualField = field === 'schedule' ? 'schedule_config' : field;
    const actual = field === 'schedule' ? normalizedSchedule(content?.[actualField]) : content?.[actualField];
    const submitted = field === 'schedule' ? normalizedSchedule(expected) : expected;
    if (!sameValue(actual, submitted, { subset: isObject(expected) || Array.isArray(expected) })) {
      throw new Error(`scheduled task readback did not match ${field}`);
    }
  }
}

function verifySubmitted(job, input) {
  const fields = {};
  for (const field of ['title', 'prompt', 'schedule', 'runtime_config', 'timezone', 'deep_think_switch', 'model_config',
    'project_id', 'sandbox_auth_type', 'local_connector_tools', 'lark_connector_id']) {
    if (input[field] !== undefined) fields[field] = input[field];
  }
  verifyFields(job, fields);
}

function verifyPatch(job, patch) {
  const fields = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'parse_token') continue;
    if (field === 'local_connector_tools' || field === 'lark_connector_id') {
      const current = cronJobContent(job)?.[field];
      fields[field] = value.clear ? undefined : value.value;
      if (value.clear) {
        if (current !== undefined && current !== null && current !== '') throw new Error(`scheduled task readback did not clear ${field}`);
      } else if (current !== value.value) throw new Error(`scheduled task readback did not match ${field}`);
    } else fields[field] = value;
  }
  verifyFields(job, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
}
