#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real npm registry integration check. All npm global state is redirected into
// this temporary directory; no account config or machine-wide CLI is touched.
const source = fileURLToPath(new URL('../../', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-cli-update-install-'));
const prefix = path.join(root, 'prefix');
const config = path.join(root, 'npm-config');
const env = {
  ...process.env,
  NPM_CONFIG_PREFIX: prefix,
  NPM_CONFIG_USERCONFIG: path.join(config, 'user.npmrc'),
  NPM_CONFIG_GLOBALCONFIG: path.join(config, 'global.npmrc'),
  NPM_CONFIG_CACHE: path.join(root, 'cache'),
  DOUBAO_CLI_CONFIG_DIR: path.join(root, 'doubao-config'),
};

try {
  await fs.mkdir(config, { recursive: true });
  const packageMetadata = JSON.parse(execFileSync('npm', ['view', 'doubao-cli@0.21.0', 'version', 'dist.tarball', '--json'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(packageMetadata.version, '0.21.0');

  // Start from the real published old package in the isolated global prefix.
  execFileSync('npm', ['install', '--global', 'doubao-cli@0.21.0', '--registry=https://registry.npmjs.org', '--replace-registry-host=never', '--no-audit', '--no-fund'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const npmRoot = execFileSync('npm', ['root', '--global'], { cwd: root, env, encoding: 'utf8' }).trim();
  assert.equal(path.relative(prefix, npmRoot).startsWith('..'), false, 'npm global root must stay under the isolated prefix');
  const installedPackage = path.join(npmRoot, 'doubao-cli', 'package.json');
  assert.equal(JSON.parse(await fs.readFile(installedPackage, 'utf8')).version, '0.21.0');

  const candidateVersion = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version;
  assert.equal(candidateVersion, '0.22.0');

  // Run the candidate CLI's actual `update` command from an isolated copy.
  // Its package metadata is set to 0.21.0 so the candidate sees an older
  // installed version; the target installed by npm remains the real registry
  // package. This is a version metadata fixture, not the published old CLI.
  const candidateCopy = path.join(root, 'candidate-cli');
  await fs.mkdir(candidateCopy, { recursive: true });
  for (const directory of ['bin', 'dist', 'src']) {
    await fs.cp(path.join(source, directory), path.join(candidateCopy, directory), { recursive: true });
  }
  await fs.copyFile(path.join(source, 'package.json'), path.join(candidateCopy, 'package.json'));
  await fs.symlink(path.join(source, 'node_modules'), path.join(candidateCopy, 'node_modules'), 'dir');
  const candidatePackagePath = path.join(candidateCopy, 'package.json');
  const candidatePackage = JSON.parse(await fs.readFile(candidatePackagePath, 'utf8'));
  candidatePackage.version = '0.21.0';
  await fs.writeFile(candidatePackagePath, `${JSON.stringify(candidatePackage, null, 2)}\n`);
  const commandOutput = execFileSync(process.execPath, [path.join(candidateCopy, 'bin/doubao.mjs'), '--json', 'update'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const update = JSON.parse(commandOutput);
  assert.equal(update.currentVersion, '0.21.0');
  assert.equal(update.latestVersion, candidateVersion);
  assert.equal(update.updateAvailable, true);
  assert.equal(update.updated, true);
  const installed = JSON.parse(await fs.readFile(installedPackage, 'utf8'));
  assert.equal(installed.version, '0.22.0');
  const installedBinary = path.join(prefix, 'bin', 'doubao');
  const binaryVersion = execFileSync(process.execPath, [installedBinary, '--version'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(binaryVersion, '0.22.0');

  console.log(JSON.stringify({
    evidence: 'real npm registry tarballs; isolated prefix and npm config/cache',
    candidateSource: 'workspace candidate CLI copy; package version metadata fixture set to 0.21.0',
    initialInstalledPackage: { version: '0.21.0', tarball: packageMetadata['dist.tarball'] },
    candidateUpdateCommand: update,
    finalInstalledPackage: { version: installed.version, binaryVersion },
    isolatedNpmGlobalRoot: true,
    currentCandidateToNewerRegistryBranch: 'not taken: candidate 0.22.0 already equals registry latest',
    machineGlobalPrefixTouched: false,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
