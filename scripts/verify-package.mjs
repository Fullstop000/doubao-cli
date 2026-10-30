#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doubao-cli-package-'));
const env = { ...process.env, DOUBAO_CLI_CONFIG_DIR: path.join(root, 'config'),
  DOUBAO_DATA_DIR: path.join(root, 'missing-desktop'), DOUBAO_CDP_ENDPOINT: 'http://127.0.0.1:1',
  DOUBAO_HEADLESS_COOKIE: '', DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1' };
let child;
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  assert(!packed.files.some(item => /^dist\/command\/.*\.(?:mjs|mts)$/.test(item.path)),
    'package contains stale command outputs from the former .mts build');
  for (const file of ['bin/doubao.mjs', 'src/cli.mjs', 'src/cli-validation.mjs', 'src/headless-worker.mjs',
    'dist/command/parser.js', 'dist/command/help.js', 'dist/command/options.js', 'dist/command/commands.js']) {
    assert(packed.files.some(item => item.path === file), `package is missing ${file}`);
  }
  for (const name of ['parser', 'help', 'options', 'commands']) {
    assert(packed.files.some(item => item.path === `dist/command/${name}.d.ts`),
      `package is missing command declarations for ${name}`);
  }
  const prefix = path.join(root, 'installed');
  execFileSync('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(root, packed.filename)],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const packageRoot = path.join(prefix, 'node_modules/doubao-cli');
  const bin = path.join(prefix, 'node_modules/.bin/doubao');
  const invoke = args => execFileSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(invoke(['--version']).trim(), packed.version);
  const { commands } = await import(pathToFileURL(path.join(packageRoot, 'dist/command/commands.js')));
  let helps = 0;
  for (const platform of ['work', 'doubao', 'headless']) {
    const backend = platform === 'headless' ? 'headless' : 'desktop';
    for (const command of commands.filter(item => item[backend] !== undefined)) {
      const result = invoke(['--platform', platform, ...command.path.split(' '), '--help']);
      assert.match(result, /^Usage:/);
      assert(result.includes(`doubao${backend === 'headless' ? ' headless' : ''} ${command.path}`));
      helps++;
    }
  }
  const { parseOptions } = await import(pathToFileURL(path.join(packageRoot, 'src/cli.mjs')));
  assert.deepEqual(parseOptions(['web', 'sessions', 'list', '--all']), parseOptions(['headless', 'sessions', 'list', '--all']));
  const { startHeadlessWorker } = await import(pathToFileURL(path.join(packageRoot, 'src/headless-worker.mjs')));
  const worker = await startHeadlessWorker({ profile: 'package_check', conversationId: '1234567890123456', runId: '2345678901234567',
    timeoutSeconds: 1, configDir: env.DOUBAO_CLI_CONFIG_DIR, env });
  child = worker.child;
  child.ref();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('packaged worker did not exit')), 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 1);
  assert.match(await fs.readFile(worker.logPath, 'utf8'), /login is required/);
  console.log(JSON.stringify({ node: process.version, packageVersion: packed.version, integrity: packed.integrity,
    isolatedInstall: true, runtimeDevDependenciesRequired: false, helpCommands: helps, compatibilityAliases: true,
    detachedWorker: 'started and reached expected isolated login_required' }, null, 2));
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await fs.rm(root, { recursive: true, force: true });
}
