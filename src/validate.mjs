// Minimal JSON schema subset validator (type, required, properties, enum,
// items) so reply validation works without a runtime dependency.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function check(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.enum) {
    const matched = schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value));
    if (!matched) errors.push(`${path}: value is not one of the enum values`);
    return;
  }
  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === 'integer'
      ? actual === 'number' && Number.isInteger(value)
      : actual === schema.type;
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return;
    }
  }
  if (typeOf(value) === 'object' && (schema.required || schema.properties)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        check(value[key], subschema, `${path}.${key}`, errors);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => check(item, schema.items, `${path}[${index}]`, errors));
  }
}

// Validates a model reply as JSON, optionally against a schema. Returns
// { ok, value } or { ok: false, errors }.
export function validateReply(text, schema) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`reply is not valid JSON: ${error.message}`] };
  }
  if (!schema) return { ok: true, value };
  const errors = [];
  check(value, schema, '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
