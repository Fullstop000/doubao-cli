#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REF = '3dae8b4de6910cc943bd033aedbb056c25855625';
const sourceRef = process.argv[2] || DEFAULT_REF;
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const resolvedCommit = execFileSync('git', ['rev-parse', `${sourceRef}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-cli-parser-oracle-'));
const archivePath = path.join(tempRoot, 'baseline.tar');
let parseOptions;

try {
  const archive = execFileSync('git', ['archive', '--format=tar', resolvedCommit], { cwd: repoRoot, maxBuffer: 200 * 1024 * 1024 });
  fs.writeFileSync(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', tempRoot]);
  fs.rmSync(archivePath, { force: true });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
  // Match only the test data needed by the parser. No user paths or account data.
  fs.mkdirSync(path.join(tempRoot, 'test', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'test/fixtures/automation-create.json'), '{"title":"Compatibility fixture","prompt":"Fixture prompt","timezone":"UTC"}\n');
  fs.writeFileSync(path.join(tempRoot, 'test/fixtures/automation-update.json'), '{"title":"Updated compatibility fixture"}\n');
  fs.mkdirSync(path.join(tempRoot, 'test/fixtures/workspace'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'test/fixtures/workspace-secondary'), { recursive: true });
  ({ parseOptions } = await import(pathToFileURL(path.join(tempRoot, 'src/cli.mjs')).href));

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  function withPlatform(platform, callback) {
    if (!platform) return callback();
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    try { return callback(); }
    finally { Object.defineProperty(process, 'platform', originalPlatform); }
  }
  const parse = (argv, platform) => withPlatform(platform, () => {
    const originalCwd = process.cwd();
    process.chdir(tempRoot);
    try { return { value: JSON.parse(JSON.stringify(parseOptions(argv))) }; }
    catch (error) { return { error: error.message }; }
    finally { process.chdir(originalCwd); }
  });

  const commandPaths = [
    ['help', ['help']], ['version', ['version']],
    ['skin status', ['skin', 'status']], ['status', ['status']], ['usage', ['usage']], ['profiles', ['profiles']], ['runtimes', ['runtimes']],
    ['projects list', ['projects', 'list']], ['projects create', ['projects', 'create', 'Compatibility Project']],
    ['sessions list', ['sessions', 'list']], ['sessions current', ['sessions', 'current']],
    ['sessions archive', ['sessions', 'archive', '123456789012']], ['sessions unarchive', ['sessions', 'unarchive', '123456789012']],
    ['sessions pin', ['sessions', 'pin', '123456789012']], ['sessions unpin', ['sessions', 'unpin', '123456789012']],
    ['sessions rename', ['sessions', 'rename', '123456789012', 'Compatibility title']],
    ['sessions move', ['sessions', 'move', '123456789012', 'Compatibility Project']],
    ['sessions create', ['sessions', 'create', 'Compatibility message']],
    ['sessions open', ['sessions', 'open', '123456789012']], ['sessions read', ['sessions', 'read', '123456789012']],
    ['sessions send', ['sessions', 'send', '123456789012', 'Compatibility message']],
    ['sessions status', ['sessions', 'status', '123456789012']], ['sessions wait', ['sessions', 'wait', '123456789012']],
    ['sessions stop', ['sessions', 'stop', '123456789012']],
    ['mcp register', ['mcp', 'register', 'compat-tools', '--command', '/usr/bin/node']],
    ['mcp list', ['mcp', 'list']], ['mcp remove', ['mcp', 'remove', '123456']],
    ['models', ['models']], ['model', ['model']], ['model current', ['model', 'current']],
    ['model select', ['model', 'select', 'Compatibility Model']], ['model reasoning', ['model', 'reasoning', 'medium']],
    ['cdp status', ['cdp', 'status']], ['cdp launch', ['cdp', 'launch']],
    ['update', ['update']], ['update check', ['update', 'check']], ['update auto', ['update', 'auto', 'status']], ['update notify', ['update', 'notify', 'status']],
    ['capabilities', ['capabilities']],
    ['automations list', ['automations', 'list']], ['automations get', ['automations', 'get', 'compat-job']],
    ['automations create', ['automations', 'create', '--file', 'test/fixtures/automation-create.json']],
    ['automations update', ['automations', 'update', 'compat-job', '--file', 'test/fixtures/automation-update.json']],
    ['automations delete', ['automations', 'delete', 'compat-job']],
    ['web namespace', ['web', 'sessions', 'list']], ['headless namespace', ['headless', 'sessions', 'list']],
  ];
  assert.equal(commandPaths.length, 46, 'command path inventory changed; update the requested matrix intentionally');
  const additionalActionPaths = [
    ['skin on', ['skin', 'on']], ['skin off', ['skin', 'off']],
    ['headless login', ['headless', 'login']], ['headless logout', ['headless', 'logout']],
    ['web login', ['web', 'login']], ['web logout', ['web', 'logout']],
    ['update auto on', ['update', 'auto', 'on']], ['update auto off', ['update', 'auto', 'off']],
    ['update notify on', ['update', 'notify', 'on']], ['update notify off', ['update', 'notify', 'off']],
  ];
  const matrixPaths = [...commandPaths, ...additionalActionPaths];

  const flagSpecs = [
    { flag: '--help', valid: [], missing: [], invalid: ['--help=value'], repeat: ['--help', '--help'], bool: true },
    { flag: '-h', valid: [], missing: [], invalid: ['-h=value'], repeat: ['-h', '-h'], bool: true },
    { flag: '--json', valid: [], missing: [], invalid: ['--json=true'], repeat: ['--json', '--json'], bool: true },
    { flag: '--archived', command: ['sessions', 'list'], valid: [], missing: [], invalid: ['--archived=true'], repeat: ['--archived', '--archived'], bool: true },
    { flag: '--all', command: ['sessions', 'list'], valid: [], missing: [], invalid: ['--all=true'], repeat: ['--all', '--all'], bool: true },
    { flag: '--yes', command: ['cdp', 'launch'], backend: 'work', valid: [], missing: [], invalid: ['--yes=true'], repeat: ['--yes', '--yes'], bool: true },
    { flag: '--wait', command: ['sessions', 'create', 'Compatibility message'], valid: [], missing: [], invalid: ['--wait=true'], repeat: ['--wait', '--wait'], bool: true },
    { flag: '--run', command: ['sessions', 'wait', '123456789012'], value: '123456789012', second: '123456789012', missing: [], invalid: 'invalid-run', repeat: true },
    { flag: '--app', command: ['status'], value: 'work', second: 'doubao', missing: [], invalid: 'headless', repeat: true },
    { flag: '--platform', command: ['status'], value: 'work', second: 'headless', missing: [], invalid: 'linux', repeat: true },
    { flag: '--target', command: ['status'], backend: 'doubao', value: 'target-compat', second: 'target-last', missing: [], invalid: '--help', repeat: true },
    { flag: '--file', command: ['headless', 'automations', 'create'], value: 'test/fixtures/automation-create.json', second: 'test/fixtures/automation-create.json', missing: [], invalid: '--help', repeat: true },
    { flag: '--mode', command: ['sessions', 'create', 'Compatibility message'], value: 'work', second: 'chat', missing: [], invalid: 'invalid', repeat: true },
    { flag: '--cookie-file', command: ['headless', 'login'], value: './cookies.json', second: './cookies.json', missing: [], invalid: '--json', repeat: true },
    { flag: '--profile', command: ['sessions', 'list'], backend: 'headless', value: 'compat_profile', second: 'last_profile', missing: [], invalid: 'contains space', repeat: true },
    { flag: '--timeout', command: ['headless', 'sessions', 'list'], value: '5', second: '10', missing: [], invalid: '0', repeat: true },
    { flag: '--limit', command: ['sessions', 'list'], value: '5', second: '100', missing: [], invalid: '1001', repeat: true },
    { flag: '--model', command: ['sessions', 'create', 'Compatibility message'], value: 'Model One', second: 'Model Two', missing: [], invalidArgv: ['--model=value'], repeat: true },
    { flag: '--reasoning', command: ['sessions', 'create', 'Compatibility message'], value: 'high', second: 'low', missing: [], invalidArgv: ['--reasoning=value'], repeat: true },
    { flag: '--attach', command: ['sessions', 'create', 'Compatibility message'], value: './one.txt', second: './two.txt', missing: [], invalid: '--wait', repeat: true },
    { flag: '--runtime', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work'], value: 'local', second: 'cloud', missing: [], invalid: 'remote', repeat: true },
    { flag: '--project', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work'], value: 'Compatibility Project', second: 'none', missing: [], invalid: '--json', repeat: true },
    { flag: '--enterprise-knowledge', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work'], valid: [], missing: [], invalid: ['--enterprise-knowledge=true'], repeat: ['--enterprise-knowledge', '--enterprise-knowledge'], bool: true },
    { flag: '--workspace', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work'], value: './test/fixtures/workspace', second: './test/fixtures/workspace-secondary', missing: [], invalid: '--json', repeat: true },
    { flag: '--no-skills', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work'], valid: [], missing: [], invalid: ['--no-skills=true'], repeat: ['--no-skills', '--no-skills'], bool: true },
    { flag: '--permission', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work', '--runtime', 'local'], value: 'AskOnRisk', second: 'FullAccess', missing: [], invalid: 'Unsafe', repeat: true },
    { flag: '--expect-json', command: ['sessions', 'create', 'Compatibility message', '--wait'], valid: [], missing: [], invalid: ['--expect-json=true'], repeat: ['--expect-json', '--expect-json'], bool: true },
    { flag: '--reply-schema', command: ['sessions', 'create', 'Compatibility message', '--wait'], value: './schema.json', second: './schema-2.json', missing: [], invalid: '--json', repeat: true },
    { flag: '--mcp', command: ['sessions', 'create', 'Compatibility message', '--mode', 'work', '--wait'], backend: 'headless', value: '123456', second: '789012', missing: [], invalid: 'abc', repeat: true },
    { flag: '--command', command: ['headless', 'mcp', 'register', 'compat-tools'], value: '/usr/bin/node', second: '/usr/bin/env', missing: [], invalid: '--json', repeat: true },
    { flag: '--arg', command: ['headless', 'mcp', 'register', 'compat-tools', '--command', '/usr/bin/node'], value: 'one', second: 'two', missing: [], invalidArgv: ['--arg=value'], repeat: true },
    { flag: '--env', command: ['headless', 'mcp', 'register', 'compat-tools', '--command', '/usr/bin/node'], value: 'KEY=value', second: 'SECOND=value', missing: [], invalid: 'no-equals', repeat: true },
  ];
  const booleanFlags = new Set(flagSpecs.filter(spec => spec.bool).map(spec => spec.flag));
  // Add flags that are parsed but need no value and have distinct meaning.
  assert.equal(flagSpecs.length, 32);

  const rows = [];
  const add = (name, argv, platform) => rows.push({ n: name, a: argv, ...(platform ? { p: platform } : {}), result: parse(argv, platform) });

  // Every logical command path under each explicitly selected backend.
  for (const [name, command] of matrixPaths) {
    for (const backend of ['work', 'doubao', 'headless']) {
      const argv = [...command, '--platform', backend];
      add(`command/${backend}/${name}`, argv);
    }
  }
  // Platform defaults are explicitly simulated and separately identified.
  for (const platform of ['linux', 'darwin']) {
    add(`default/${platform}/status`, ['status'], platform);
    add(`default/${platform}/sessions-create-goal`, ['sessions', 'create', 'Goal message', '--mode', 'goal'], platform);
    add(`default/${platform}/sessions-create-chat`, ['sessions', 'create', 'Chat message', '--mode', 'chat'], platform);
  }
  // Each option has valid, missing, invalid, and repeated forms. Boolean flags use
  // their meaningful no-value form as valid/missing, and malformed assignment as invalid.
  for (const spec of flagSpecs) {
    const command = spec.command || ['sessions', 'create', 'Compatibility message'];
    const backend = spec.backend || (command[0] === 'headless' || command[0] === 'web' ? undefined : 'headless');
    const prefix = backend ? [...command, '--platform', backend] : [...command];
    if (spec.bool) {
      add(`flag/${spec.flag}/valid`, [...prefix, spec.flag]);
      add(`flag/${spec.flag}/missing`, prefix);
      add(`flag/${spec.flag}/invalid`, [...prefix, ...spec.invalid]);
      add(`flag/${spec.flag}/repeat`, [...prefix, ...spec.repeat]);
    } else {
      add(`flag/${spec.flag}/valid`, [...prefix, spec.flag, spec.value]);
      add(`flag/${spec.flag}/missing`, [...prefix, spec.flag]);
      add(`flag/${spec.flag}/empty`, [...prefix, spec.flag, '']);
      add(`flag/${spec.flag}/invalid`, [...prefix, ...(spec.invalidArgv || [spec.flag, spec.invalid])]);
      add(`flag/${spec.flag}/repeat`, [...prefix, spec.flag, spec.value, spec.flag, spec.second]);
    }
  }
  // Cross every parsed option against every command path and explicit backend to freeze
  // the baseline's allowed/forbidden placement and error precedence matrix.
  for (const [name, command] of matrixPaths) {
    for (const backend of ['work', 'doubao', 'headless']) {
      for (const spec of flagSpecs) {
        const prefix = [...command, '--platform', backend];
        let operand;
        if (spec.bool) operand = [spec.flag];
        else operand = [spec.flag, spec.value ?? 'value'];
        add(`matrix/${backend}/${name}/${spec.flag}`, [...prefix, ...operand]);
      }
    }
  }
  // Version aliases, web alias, and parser edge behavior remain independent special cases.
  for (const backend of ['work', 'doubao', 'headless']) {
    add(`version/--version/${backend}`, ['--version', '--platform', backend]);
    add(`version/-v/${backend}`, ['-v', '--platform', backend]);
  }
  add('platform/web-alias', ['status', '--platform', 'web']);
  add('platform/web-app-conflict', ['status', '--platform', 'web', '--app', 'doubao']);
  for (const [name, argv] of [
    ['literal-after-delimiter', ['sessions', 'send', '123456789012', '--', '--help', '--model', 'literal']],
    ['literal-leading-option-message', ['sessions', 'create', '--', '--model means text', '--platform', 'headless']],
    ['equals-limit', ['sessions', 'list', '--limit=5', '--platform', 'headless']],
    ['equals-json', ['sessions', 'list', '--json=true', '--platform', 'headless']],
    ['short-option-bundle', ['sessions', 'list', '-jh', '--platform', 'headless']],
    ['unknown-long-flag', ['sessions', 'list', '--not-an-option', '--platform', 'headless']],
    ['missing-model-consumes-next-flag', ['sessions', 'create', 'Compatibility message', '--model', '--wait', '--platform', 'headless']],
    ['missing-profile-consumes-json', ['sessions', 'list', '--profile', '--json', '--platform', 'headless']],
    ['limit-1-boundary', ['sessions', 'list', '--limit', '1', '--platform', 'headless']],
    ['limit-100-boundary', ['sessions', 'list', '--limit', '100', '--platform', 'headless']],
    ['limit-101-command-boundary', ['sessions', 'list', '--limit', '101', '--platform', 'headless']],
    ['limit-1000-value-boundary', ['sessions', 'list', '--limit', '1000', '--platform', 'headless']],
    ['limit-1001-invalid', ['sessions', 'list', '--limit', '1001', '--platform', 'headless']],
    ['timeout-decimal', ['headless', 'sessions', 'list', '--timeout', '0.25']],
    ['timeout-zero-invalid', ['headless', 'sessions', 'list', '--timeout', '0']],
    ['timeout-infinity-invalid', ['headless', 'sessions', 'list', '--timeout', 'Infinity']],
    ['all-limit-conflict', ['sessions', 'list', '--all', '--limit', '100', '--platform', 'headless']],
    ['unknown-help-topic', ['help', 'not-a-command', '--platform', 'headless']],
    ['unknown-help-subtopic', ['help', 'sessions', 'not-a-command', '--platform', 'headless']],
    ['root-short-help', ['-h', '--platform', 'headless']],
    ['arg-consumes-json-flag', ['headless', 'mcp', 'register', 'compat-tools', '--command', '/usr/bin/node', '--arg', '--json']],
    ['arg-consumes-delimiter', ['headless', 'mcp', 'register', 'compat-tools', '--command', '/usr/bin/node', '--arg', '--']],
    ['options-before-command', ['--platform', 'headless', 'sessions', 'create', 'Compatibility message', '--model', 'Compatibility Model', '--wait']],
    ['options-interleaved-with-command', ['sessions', 'create', '--mode', 'work', '--model', 'Compatibility Model', 'Compatibility message', '--runtime', 'local', '--platform', 'headless']],
    ['literal-options-after-separator', ['sessions', 'create', 'Compatibility message', '--', '--json', '--wait', '--model']],
  ]) add(`edge/${name}`, argv);
  // A selector conflict pair is intentionally separate from the per-command matrix.
  for (const [name, argv] of [
    ['app-platform', ['status', '--app', 'work', '--platform', 'doubao']],
    ['web-platform', ['web', 'status', '--platform', 'work']],
    ['web-app', ['web', 'status', '--app', 'work']],
    ['headless-platform', ['headless', 'status', '--platform', 'doubao']],
    ['headless-app', ['headless', 'status', '--app', 'doubao']],
  ]) add(`selector-conflict/${name}`, argv);

  const defaults = {};
  for (const platform of ['linux', 'darwin']) defaults[platform] = parse([], platform).value;
  const outcomeIds = new Map();
  const outcomes = [];
  const intern = result => {
    let compact;
    if (Object.hasOwn(result, 'error')) compact = { e: result.error };
    else {
      const base = defaults.linux;
      const delta = {};
      const removed = [];
      for (const key of Object.keys(base)) if (!Object.hasOwn(result.value, key)) removed.push(key);
      for (const [key, value] of Object.entries(result.value)) {
        if (!Object.hasOwn(base, key) || JSON.stringify(value) !== JSON.stringify(base[key])) delta[key] = value;
      }
      compact = { d: delta, ...(removed.length ? { x: removed } : {}) };
    }
    const key = JSON.stringify(compact);
    if (!outcomeIds.has(key)) {
      outcomeIds.set(key, outcomes.length);
      outcomes.push(compact);
    }
    return outcomeIds.get(key);
  };
  const cases = rows.map(row => ({ n: row.n, a: row.a, ...(row.p ? { p: row.p } : {}), o: intern(row.result) }));
  const metadata = {
    sourceCommit: resolvedCommit,
    oracle: 'parseOptions loaded from an isolated git archive of sourceCommit; exact baseline imports retained',
    commandPaths: commandPaths.length,
    additionalActionPaths: additionalActionPaths.length,
    matrixPaths: matrixPaths.length,
    explicitBackends: ['work', 'doubao', 'headless'],
    parsedFlags: flagSpecs.map(spec => spec.flag),
    cases: cases.length,
    outcomes: outcomes.length,
    caseGroups: {
      commandBackendMatrix: matrixPaths.length * 3,
      simulatedPlatformDefaults: 6,
      flagForms: flagSpecs.length * 4 + flagSpecs.filter(spec => !spec.bool).length,
      optionPlacementMatrix: matrixPaths.length * 3 * flagSpecs.length,
      selectorConflicts: 5,
      versionAndParserEdges: 33,
    },
    defaultPlatform: defaults,
  };
  const output = { metadata, outcomes, cases };
  const fixturePath = path.join(repoRoot, 'test/fixtures/cli-compatibility.json');
  fs.writeFileSync(fixturePath, `${JSON.stringify(output)}\n`);
  const size = fs.statSync(fixturePath).size;
  console.log(JSON.stringify({ ...metadata, fixtureBytes: size }, null, 2));
  if (size > 2 * 1024 * 1024) throw new Error(`fixture exceeds 2 MiB: ${size} bytes`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
