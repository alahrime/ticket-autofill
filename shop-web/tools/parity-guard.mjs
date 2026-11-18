// Fails when the Python server files change without shop-web being updated.
//   node tools/parity-guard.mjs            check against PARITY
//   node tools/parity-guard.mjs --update   rewrite PARITY from the current files
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const parityFile = join(here, '..', 'PARITY');
const repoRoot = join(here, '..', '..');
const files = ['shop.py', 'tickets.py', 'accounts.py', 'pinweb.py'];

// Git blob hash of the working-tree file (line endings as git sees them).
const blobHash = (file) =>
  execFileSync('git', ['hash-object', '--', file], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

const current = Object.fromEntries(files.map((f) => [f, blobHash(f)]));

if (process.argv.includes('--update')) {
  writeFileSync(
    parityFile,
    files.map((f) => `${current[f]} ${f}\n`).join(''),
  );
  console.log('PARITY updated.');
  process.exit(0);
}

const recorded = {};
for (const line of readFileSync(parityFile, 'utf8').split(/\r?\n/)) {
  const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
  if (m) recorded[m[2]] = m[1];
}

const changed = files.filter((f) => recorded[f] !== current[f]);
if (changed.length > 0) {
  console.error(
    `Python server changed: ${changed.join(', ')}. ` +
      'Port the change to shop-web, then run: node tools/parity-guard.mjs --update',
  );
  process.exit(1);
}
console.log('Parity OK.');
