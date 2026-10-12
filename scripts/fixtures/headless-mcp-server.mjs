#!/usr/bin/env node
// Synthetic stdio MCP server for scripts/headless-e2e.mjs. The marker is read
// only from this process environment and is returned by one read-only tool.
import readline from 'node:readline';

const marker = process.env.DOUBAO_HEADLESS_E2E_MARKER;
if (typeof marker !== 'string' || !/^HEADLESS_E2E_[A-F0-9]{32}$/u.test(marker)) process.exit(2);

for await (const line of readline.createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'headless-e2e-fixture', version: '1.0.0' } };
  } else if (request.method === 'ping') {
    result = {};
  } else if (request.method === 'tools/list') {
    result = { tools: [{
      name: 'doubao_headless_e2e_marker',
      description: 'Return the synthetic test marker configured for this fixture. No external effects.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }] };
  } else if (request.method === 'tools/call' && request.params?.name === 'doubao_headless_e2e_marker') {
    result = { content: [{ type: 'text', text: JSON.stringify({ marker }) }] };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'Unknown method' } })}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
