import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmHeadlessFullAccess, createHeadlessApproval } from '../src/headless-approval.mjs';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, readOutput: () => output.read()?.toString('utf8') || '' };
}

test('FullAccess requires an explicit yes from a TTY and explains its reach', async () => {
  const { input, output, readOutput } = streams();
  const pending = confirmHeadlessFullAccess({ input, output, interactive: true, workspace: '/tmp/private-workspace' });
  input.write('yes\n');
  assert.equal(await pending, true);
  const prompt = readOutput();
  assert.match(prompt, /Enable FullAccess for this turn\?/u);
  assert.match(prompt, /inherit environment credentials/u);
  assert.match(prompt, /send tool results to Doubao/u);
  assert.match(prompt, /cwd \/tmp\/private-workspace/u);
  assert.match(prompt, /\[y\/N\]/u);
  input.destroy();
  output.destroy();
});

test('FullAccess denies no, EOF, and non-TTY requests', async () => {
  const no = streams();
  const noPending = confirmHeadlessFullAccess({ ...no, interactive: true });
  no.input.write('no\n');
  assert.equal(await noPending, false);
  no.input.destroy();
  no.output.destroy();

  const eof = streams();
  const eofPending = confirmHeadlessFullAccess({ ...eof, interactive: true });
  eof.input.end();
  assert.equal(await eofPending, false);
  eof.output.destroy();

  const nonTty = streams();
  assert.equal(await confirmHeadlessFullAccess({ ...nonTty, interactive: false }), false);
  assert.equal(nonTty.readOutput(), '');
  nonTty.input.destroy();
  nonTty.output.destroy();
});

test('TTY approval shows a bounded command and working directory while stripping ANSI escapes', async () => {
  const { input, output, readOutput } = streams();
  const approve = createHeadlessApproval({ input, output, interactive: true, workspace: '/tmp/headless-project' });
  const longCommand = `git status --short && printf '\u001b[31m${'x'.repeat(500)}\u001b[0m'`;
  const pending = approve({ toolName: 'Bash', input: { command: longCommand }, permission: 'AskOnRisk',
    risk: 'mutation-or-command' });
  input.write('yes\n');
  assert.equal(await pending, true);
  const prompt = readOutput();
  assert.match(prompt, /Bash: command: git status --short/u);
  assert.match(prompt, /\/tmp\/headless-project/u);
  assert.match(prompt, /cwd \/tmp\/headless-project/u);
  assert.match(prompt, /\[y\/N\]/u);
  assert.doesNotMatch(prompt, /\u001b|\[31m|\[0m/u);
  const shownCommand = prompt.match(/command: ([^;]*?)(?:; cwd)/u)?.[1] || '';
  assert.ok(shownCommand.length <= 401, `bounded command display length was ${shownCommand.length}`);
  assert.match(shownCommand, /…$/u);
  input.destroy();
  output.destroy();
});

test('TTY approval denies no, EOF, and noninteractive requests', async () => {
  const rejectedStreams = streams();
  const reject = createHeadlessApproval({ ...rejectedStreams, interactive: true, workspace: '/tmp/project' });
  const answer = reject({ toolName: 'Write', input: { file_path: '/tmp/project/.env', content: 'secret' },
    permission: 'AlwaysAsk', risk: 'always-ask' });
  rejectedStreams.input.write('n\n');
  assert.equal(await answer, false);
  const prompt = rejectedStreams.readOutput();
  assert.match(prompt, /Write: resource \.env/u);
  assert.doesNotMatch(prompt, /secret/u);
  rejectedStreams.input.destroy();
  rejectedStreams.output.destroy();

  const eofStreams = streams();
  const eofApproval = createHeadlessApproval({ ...eofStreams, interactive: true });
  const eof = eofApproval({ toolName: 'Bash' });
  eofStreams.input.end();
  assert.equal(await eof, false);
  eofStreams.output.destroy();

  const noninteractiveStreams = streams();
  const batchApproval = createHeadlessApproval({ ...noninteractiveStreams, interactive: false });
  assert.equal(await batchApproval({ toolName: 'Bash' }), false);
  assert.equal(noninteractiveStreams.readOutput(), '');
  noninteractiveStreams.input.destroy();
  noninteractiveStreams.output.destroy();
});

test('outside-workspace file approval shows the full requested path, and MCP approval shows tool identity', async () => {
  const fileStreams = streams();
  const fileApproval = createHeadlessApproval({ ...fileStreams, interactive: true, workspace: '/tmp/project' });
  const filePending = fileApproval({ toolName: 'Read', input: { file_path: '../private/config.json' },
    permission: 'AskOnRisk', risk: 'outside-workspace' });
  fileStreams.input.write('n\n');
  assert.equal(await filePending, false);
  assert.match(fileStreams.readOutput(), /resource \/tmp\/private\/config\.json/u);
  fileStreams.input.destroy();
  fileStreams.output.destroy();

  const mcpStreams = streams();
  const mcpApproval = createHeadlessApproval({ ...mcpStreams, interactive: true, workspace: '/tmp/project' });
  const mcpPending = mcpApproval({ toolName: 'connector.call', input: { connector_id: 'conn-1',
    remote_tool_name: 'search', raw_arguments: '{"query":"public docs"}' }, permission: 'AlwaysAsk', risk: 'always-ask' });
  mcpStreams.input.write('n\n');
  assert.equal(await mcpPending, false);
  const mcpPrompt = mcpStreams.readOutput();
  assert.match(mcpPrompt, /connector conn-1 \/ search; args: \{"query":"public docs"\}/u);
  mcpStreams.input.destroy();
  mcpStreams.output.destroy();
});

test('abort cancels a pending TTY question and denies approval', async () => {
  const { input, output, readOutput } = streams();
  const controller = new AbortController();
  const approve = createHeadlessApproval({ input, output, interactive: true, workspace: '/tmp/project' });
  const pending = approve({ toolName: 'local.workspace.apply', input: { type: 'write_file', path: 'agents.md', content: 'x' },
    permission: 'AlwaysAsk', risk: 'workspace-write', signal: controller.signal });
  controller.abort(new Error('runtime stopped'));
  assert.equal(await pending, false);
  assert.match(readOutput(), /write_file \(agents\.md\)/u);
  input.destroy();
  output.destroy();
});
