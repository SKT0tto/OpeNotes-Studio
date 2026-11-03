// Packs one plugin for release: release/openotes-plugin-<id>-v<version>.zip holding plugins/<id>/{plugin.json, server.mjs, web.js, README.md}
// (+ web.css when present) and nothing else. Users unzip it into the plugins/ folder of their install and restart.
// Usage: node scripts/package-plugin.mjs <id> [--out release]
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { buildPlugin } from './build-plugins.mjs';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const id = argv.find((a) => !a.startsWith('--'));
if (!id) throw new Error('usage: node scripts/package-plugin.mjs <id>');
const outDir = path.resolve(root, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'release');
const dir = path.join(root, 'plugins', id);
if (!fs.existsSync(path.join(dir, 'plugin.json'))) throw new Error(`plugins/${id}/plugin.json not found`);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
if (manifest.id !== id) throw new Error(`plugin.json id "${manifest.id}" does not match the folder "${id}"`);

await buildPlugin(id);
const wanted = ['plugin.json', manifest.server ?? 'server.mjs', manifest.web ?? 'web.js', 'README.md'].filter((f, i, a) => a.indexOf(f) === i);
if (fs.existsSync(path.join(dir, 'web.css'))) wanted.push('web.css');
for (const f of wanted) if (!fs.existsSync(path.join(dir, f))) throw new Error(`plugins/${id}/${f} is missing`);

fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `openotes-plugin-${id}-v${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });
const zip = new yazl.ZipFile();
const mtime = new Date();
for (const f of wanted) zip.addFile(path.join(dir, f), `plugins/${id}/${f}`, { mtime });
zip.end();
await pipeline(zip.outputStream, fs.createWriteStream(zipPath));
console.log(`${zipPath}  ${wanted.length} files, ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`);
