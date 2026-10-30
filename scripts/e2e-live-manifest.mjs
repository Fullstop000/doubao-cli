import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// Cache reuse is valid only for the exact installed runtime and explicit inputs.
// A pre-existing directory without this manifest is never adopted as evidence.
export async function bindLiveManifest(output, inputs) {
  const cli = await fs.realpath(inputs.cli);
  const config = await fs.realpath(inputs.config);
  for (const standard of [path.join(os.homedir(),'Library','Application Support','doubao-cli'),path.join(os.homedir(),'.config','doubao-cli')]) {
    let canonical=standard;try{canonical=await fs.realpath(standard);}catch{}
    if(config===canonical)throw new Error('Live E2E requires an isolated config directory');
  }
  const root = path.dirname(path.dirname(cli));
  const digest = createHash('sha256');
  async function add(relative) {
    const file = path.join(root, relative);
    let stat; try { stat = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(file)).sort()) await add(path.join(relative, child));
    } else if (relative.endsWith('.mjs') || relative === 'package.json') {
      digest.update(relative); digest.update('\0'); digest.update(await fs.readFile(file)); digest.update('\0');
    }
  }
  for (const folder of ['bin', 'dist', 'src', 'package.json']) await add(folder);
  const manifest = { version: 1, ...inputs, cli, config, runtimeSha256: digest.digest('hex') };
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const file = path.join(output, 'manifest.json');
  let previous;
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('Evidence manifest mismatch; choose a fresh output directory');
  } else {
    if ((await fs.readdir(output)).length) throw new Error('Existing evidence has no manifest; refusing cached results');
    await fs.writeFile(file, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  }
  return manifest;
}
