import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// TypeScript does not remove obsolete outputs after source renames. Clean only
// this generated command layer so old .mjs/.d.mts files cannot enter a package.
rmSync(new URL('dist/command/', root), { recursive: true, force: true });
execFileSync(process.execPath, [
  fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)),
  '-p', fileURLToPath(new URL('tsconfig.json', root)),
], { cwd: fileURLToPath(root), stdio: 'inherit' });
