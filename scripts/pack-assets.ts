/**
 * npm run pack-assets -- --out <path-to.zip> [--root <asset library>]
 * Packs the library (models/, backgrounds/, media/, manifest.json) into a zip with an openotes-pack.json at its root.
 * The zip must not be written inside this repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writePackZip } from '../server/assets/pack';
import { loadConfig } from '../server/config';
import { loadDotEnv } from '../server/settings/store';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

loadDotEnv('.env');
const root = path.resolve(arg('root') ?? loadConfig().assetRoot);
const outArg = arg('out');
if (!outArg) {
  console.error('usage: npm run pack-assets -- --out <path\\to\\openotes-assets.zip> [--root <asset library>]');
  process.exit(2);
}
const out = path.resolve(outArg);
const repo = process.cwd();
if (out === repo || out.startsWith(repo + path.sep)) {
  console.error(`refusing to write the pack inside the repository (${repo}); choose another folder`);
  process.exit(2);
}
if (!fs.existsSync(root)) {
  console.error(`asset library not found: ${root}`);
  process.exit(2);
}
if (fs.existsSync(out)) {
  console.error(`output already exists: ${out}`);
  process.exit(2);
}
fs.mkdirSync(path.dirname(out), { recursive: true });

let last = 0;
const pack = await writePackZip(root, out, (phase, done, total) => {
  const now = Date.now();
  if (now - last > 1000 || done === total) {
    last = now;
    process.stdout.write(`\r${phase} ${done}/${total}   `);
  }
});
console.log(`\npack written: ${out}`);
console.log(`models ${pack.counts.models}, backgrounds ${pack.counts.backgrounds}, media ${pack.counts.media}, ${(pack.totalBytes / 1024 ** 2).toFixed(1)} MB, ${pack.files?.length ?? 0} files hashed`);
