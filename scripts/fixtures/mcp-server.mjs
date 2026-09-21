import fs from 'node:fs';
import readline from 'node:readline';

const log = event => fs.appendFileSync(process.env.DOUBAO_E2E_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n');
log({ event: 'start', args: process.argv.slice(2), marker: process.env.DOUBAO_E2E_MARKER });
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'doubao-cli-e2e', version: '1.0.0' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'doubao_e2e_ping', description: 'Echo a synthetic test marker. No network or filesystem changes except the test log.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, annotations: { readOnlyHint: true, destructiveHint: false } }] };
  } else if (request.method === 'tools/call' && request.params.name === 'doubao_e2e_ping') {
    const text = `pong: ${request.params.arguments.message}`;
    log({ event: 'call', message: request.params.arguments.message, result: text });
    result = { content: [{ type: 'text', text }] };
  } else if (request.method === 'ping') result = {};
  else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
