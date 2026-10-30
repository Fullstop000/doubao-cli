import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmHeadlessFullAccess, createHeadlessApproval } from '../src/headless-approval.mjs';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, readOutput: () => {
    const chunks = [];
    for (let value; (value = output.read()) !== null;) chunks.push(value.toString('utf8'));
    return chunks.join('');
  } };
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

const tick = () => new Promise(resolve => setImmediate(resolve));

test('separate approval instances serialize prompts and one answer resolves only the active request', async () => {
  const io = streams();
  const first = createHeadlessApproval({ ...io, interactive: true });
  const second = createHeadlessApproval({ ...io, interactive: true });
  const a = first({ toolName: 'Bash', input: { command: 'first' } });
  let secondSettled = false;
  const b = second({ toolName: 'Bash', input: { command: 'second' } }).then(value => { secondSettled = true; return value; });
  const initial = io.readOutput();
  assert.match(initial, /command: first/u);
  assert.doesNotMatch(initial, /command: second/u);
  io.input.write('y\n');
  assert.equal(await a, true);
  await tick();
  assert.equal(secondSettled, false);
  assert.match(io.readOutput(), /command: second/u);
  io.input.write('n\n');
  assert.equal(await b, false);
  assert.match(io.readOutput(), /n\r?\n/u, 'raw-terminal input must be echoed with a newline');
  io.input.destroy();
  io.output.destroy();
});

test('queued abort resolves without displaying or consuming an answer, across FullAccess and tools', async () => {
  const io = streams();
  const controller = new AbortController();
  const a = confirmHeadlessFullAccess({ ...io, interactive: true });
  const approve = createHeadlessApproval({ ...io, interactive: true });
  const aborted = approve({ toolName: 'Write', input: { file_path: 'must-not-show' }, signal: controller.signal });
  const c = approve({ toolName: 'Read', input: { file_path: 'third' } });
  controller.abort();
  assert.equal(await aborted, false);
  const initial = io.readOutput();
  assert.match(initial, /Enable FullAccess/u);
  assert.doesNotMatch(initial, /must-not-show|third/u);
  io.input.write('n\n');
  assert.equal(await a, false);
  await tick();
  const next = io.readOutput();
  assert.match(next, /third/u);
  assert.doesNotMatch(next, /must-not-show/u);
  io.input.write('y\n');
  assert.equal(await c, true);
  io.input.destroy();
  io.output.destroy();
});

test('active abort closes its reader before the next prompt and queued EOF denies without another prompt', async () => {
  const io = streams();
  const controller = new AbortController();
  const approve = createHeadlessApproval({ ...io, interactive: true });
  const a = approve({ toolName: 'Read', input: { file_path: 'first' }, signal: controller.signal });
  const b = approve({ toolName: 'Read', input: { file_path: 'second' } });
  io.readOutput();
  controller.abort();
  assert.equal(await a, false);
  await tick();
  assert.match(io.readOutput(), /second/u);
  io.input.write('n\n');
  assert.equal(await b, false);
  const c = approve({ toolName: 'Read', input: { file_path: 'third' } });
  const d = approve({ toolName: 'Read', input: { file_path: 'fourth' } });
  io.readOutput();
  io.input.end();
  assert.equal(await c, false);
  assert.equal(await d, false);
  assert.doesNotMatch(io.readOutput(), /fourth/u);
  io.output.destroy();
});

test('one input chunk cannot approve several queued requests', async () => {
  const io = streams();
  const approve = createHeadlessApproval({ ...io, interactive: true });
  const a = approve({ toolName: 'Read', input: { file_path: 'first' } });
  let secondSettled = false;
  const b = approve({ toolName: 'Read', input: { file_path: 'second' } }).then(value => { secondSettled = true; return value; });
  io.input.write('y\ny\n');
  assert.equal(await a, true);
  await tick();
  assert.equal(secondSettled, false);
  io.input.write('n\n');
  assert.equal(await b, false);
  io.input.destroy();
  io.output.destroy();
});

test('independent input streams do not block each other', async () => {
  const first = streams();
  const second = streams();
  const a = createHeadlessApproval({ ...first, interactive: true })({ toolName: 'Read' });
  const b = createHeadlessApproval({ ...second, interactive: true })({ toolName: 'Read' });
  assert.match(first.readOutput(), /Approve/u);
  assert.match(second.readOutput(), /Approve/u);
  second.input.write('y\n');
  assert.equal(await b, true);
  first.input.write('n\n');
  assert.equal(await a, false);
  first.input.destroy();
  first.output.destroy();
  second.input.destroy();
  second.output.destroy();
});
