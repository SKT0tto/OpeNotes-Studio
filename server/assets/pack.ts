/** Builds a native-layout asset pack (zip + openotes-pack.json) from an asset library. Used by `npm run pack-assets`. */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { PACK_FILE, type Pack } from '../../shared/schema/pack';
import { sha256File } from './import/plan';

const STORED = new Set(['.png', '.mp3', '.ogg', '.m4a', '.aac', '.opus', '.flac', '.zip']);

export interface PackFile { path: string; abs: string; bytes: number }

/** models/**, backgrounds/**, media/** and manifest.json under `root` (hidden folders such as .import-tmp are skipped). */
export async function listPackFiles(root: string): Promise<PackFile[]> {
  const out: PackFile[] = [];
  const walk = async (dirAbs: string, dirRel: string) => {
    for (const d of await fs.readdir(dirAbs, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const rel = `${dirRel}/${d.name}`;
      if (d.isDirectory()) await walk(path.join(dirAbs, d.name), rel);
      else if (d.isFile()) out.push({ path: rel, abs: path.join(dirAbs, d.name), bytes: (await fs.stat(path.join(dirAbs, d.name))).size });
    }
  };
  for (const top of ['models', 'backgrounds', 'media']) await walk(path.join(root, top), top).catch(() => {});
  const mf = path.join(root, 'manifest.json');
  const st = await fs.stat(mf).catch(() => null);
  if (st?.isFile()) out.push({ path: 'manifest.json', abs: mf, bytes: st.size });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function describePack(files: PackFile[], onProgress?: (done: number, total: number) => void): Promise<Pack> {
  const listed: NonNullable<Pack['files']> = [];
  let done = 0;
  for (const f of files) {
    listed.push({ path: f.path, bytes: f.bytes, sha256: await sha256File(f.abs) });
    onProgress?.(++done, files.length);
  }
  return {
    format: 'openotes-pack',
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: 'openotes-studio pack-assets',
    counts: {
      models: files.filter((f) => /^models\/[^/]+\/model3\.json$/i.test(f.path)).length,
      backgrounds: files.filter((f) => /^backgrounds\/[^/]+\.png$/i.test(f.path)).length,
      media: files.filter((f) => f.path.startsWith('media/')).length,
    },
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    files: listed,
  };
}

export async function writePackZip(root: string, outZip: string, onProgress?: (phase: string, done: number, total: number) => void): Promise<Pack> {
  const files = await listPackFiles(root);
  const pack = await describePack(files, (d, t) => onProgress?.('hash', d, t));
  const zip = new yazl.ZipFile();
  const sink = pipeline(zip.outputStream, createWriteStream(outZip));
  zip.addBuffer(Buffer.from(JSON.stringify(pack, null, 2)), PACK_FILE);
  let done = 0;
  for (const f of files) {
    zip.addFile(f.abs, f.path, { compress: !STORED.has(path.extname(f.path).toLowerCase()) }); // opened lazily, one at a time
    onProgress?.('zip', ++done, files.length);
  }
  zip.end();
  await sink;
  return pack;
}
