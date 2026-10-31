// Builds the download package: release/OpeNotes-Studio-<tag>.zip (+ release/RELEASE_NOTES.md from CHANGELOG.md).
// Run `npm run build` first (the release workflow does). Usage: node scripts/package-release.mjs [--tag v0.1.3] [--out release]
// The package holds the built app (dist/), the start scripts and the docs; never node_modules, tests, the website, assets,
// the Cubism Core, .env or data/.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = opt('--tag') ?? `v${pkg.version}`;
const version = tag.replace(/^v/, '');
if (version !== pkg.version) throw new Error(`tag ${tag} does not match package.json version ${pkg.version}`);
const outDir = path.resolve(root, opt('--out') ?? 'release');
const name = `OpeNotes-Studio-${tag}`;

/** [source relative to the repo, destination inside the package]. Directories are copied recursively. */
const ENTRIES = [
  ['dist', 'dist'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['scripts/fetch-core.mjs', 'scripts/fetch-core.mjs'],
  ['scripts/launch.mjs', 'scripts/launch.mjs'],
  ['scripts/release/Start-Windows.cmd', 'Start-Windows.cmd'],
  ['scripts/release/start.sh', 'start.sh'],
  ['scripts/update.mjs', 'scripts/update.mjs'],
  ['scripts/release/Update-Windows.cmd', 'Update-Windows.cmd'],
  ['scripts/release/update.sh', 'update.sh'],
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE'],
  ['THIRD_PARTY.md', 'THIRD_PARTY.md'],
  ['README.md', 'README.md'],
  ['CHANGELOG.md', 'CHANGELOG.md'],
  ['docs/GUIDE_ASSETS.md', 'docs/GUIDE_ASSETS.md'],
  ['asset-labels', 'asset-labels'],
  ['examples', 'examples'],
  ['studio.config.example.json', 'studio.config.example.json'],
  ['.env.example', '.env.example'],
];
// Defence in depth: nothing that must never ship, whatever ENTRIES grows into.
const FORBIDDEN = /^assets(\/|$)|(^|\/)(node_modules|tests|site|\.github|\.git|data|data-test|vendor|\.verify|dev-notes)(\/|$)|(^|\/)\.env$|\.(moc3|model3\.json|motion3\.json|exp3\.json|physics3\.json)$|live2dcubismcore/i;

function walk(abs, dest, out) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(abs).sort()) walk(path.join(abs, f), `${dest}/${f}`, out);
  } else {
    out.push([abs, dest]);
  }
}

const files = [];
for (const [src, dest] of ENTRIES) {
  const abs = path.join(root, src);
  if (!fs.existsSync(abs)) throw new Error(`missing ${src}${src.startsWith('dist') ? ' (run npm run build first)' : ''}`);
  walk(abs, dest, files);
}
for (const [, dest] of files) if (FORBIDDEN.test(dest)) throw new Error(`refusing to package ${dest}`);
if (!files.some(([, d]) => d === 'dist/web/index.html') || !files.some(([, d]) => d === 'dist/server/index.mjs')) throw new Error('dist/web or dist/server is incomplete (run npm run build)');

fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `${name}.zip`);
fs.rmSync(zipPath, { force: true });
const zip = new yazl.ZipFile();
const mtime = new Date();
for (const [abs, dest] of files) {
  const entry = `${name}/${dest}`;
  if (dest.endsWith('.cmd')) {
    zip.addBuffer(Buffer.from(fs.readFileSync(abs, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8'), entry, { mtime });
  } else if (dest.endsWith('.sh')) {
    zip.addBuffer(Buffer.from(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'), 'utf8'), entry, { mtime, mode: 0o100755 });
  } else {
    zip.addFile(abs, entry, { mtime });
  }
}
zip.end();
await pipeline(zip.outputStream, fs.createWriteStream(zipPath));

// release notes = the CHANGELOG section of this version
const lines = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end < 0) end = lines.length;
fs.writeFileSync(path.join(outDir, "RELEASE_NOTES.md"), `${lines.slice(start + 1, end).join("\n").trim()}\n`);

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`${zipPath}  ${files.length} files, ${mb} MB`);
