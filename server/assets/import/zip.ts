import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import { resolveInside } from '../../util/safePath';

export interface ZipLimits { maxBytes: number; maxEntries: number; maxPathLength: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxBytes: 16 * 1024 ** 3, maxEntries: 50_000, maxPathLength: 240 };

export class ZipSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipSafetyError';
  }
}

/** Why an archive entry name is unsafe, or null when it is fine. */
export function unsafeEntryName(name: string): string | null {
  if (name.includes('\0')) return '路径含 NUL';
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return '绝对路径';
  if (n.split('/').some((s) => s === '..')) return '路径穿越（..）';
  return null;
}

/**
 * Extract a zip into `destDir`. Rejects zip-slip, symlinks (skipped), case-colliding names, over-long paths and
 * archives whose real (not declared) uncompressed size or entry count exceeds the limits.
 */
export interface ExtractHooks { onProgress?: (done: { files: number; bytes: number; total: number }) => void; signal?: AbortSignal }

export async function extractZip(zipFile: string, destDir: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS, hooks: ExtractHooks = {}): Promise<{ files: number; bytes: number; skipped: Array<{ path: string; reason: string }> }> {
  await fs.mkdir(destDir, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, z) => (err ? reject(new ZipSafetyError(`无法读取 zip：${err.message}`)) : resolve(z)));
  });
  const skipped: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  let entries = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (e: Error) => {
      zip.close();
      reject(e instanceof ZipSafetyError ? e : new ZipSafetyError(`zip 无法处理：${e.message}`));
    };
    zip.on('error', fail);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        if (hooks.signal?.aborted) throw new ZipSafetyError('已取消');
        const name = entry.fileName;
        if (++entries > limits.maxEntries) throw new ZipSafetyError(`zip 条目数超过上限 ${limits.maxEntries}`);
        const bad = unsafeEntryName(name);
        if (bad) throw new ZipSafetyError(`zip 含不安全路径「${name}」：${bad}`);
        if (name.endsWith('/')) return zip.readEntry();
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) {
          skipped.push({ path: name, reason: '符号链接，已跳过' });
          return zip.readEntry();
        }
        const dest = resolveInside(destDir, name);
        if (!dest) throw new ZipSafetyError(`zip 含不安全路径「${name}」`);
        if (dest.length > limits.maxPathLength) throw new ZipSafetyError(`路径过长（${dest.length} 字符）：${name}`);
        const key = name.replace(/\\/g, '/').toLowerCase();
        if (seen.has(key)) throw new ZipSafetyError(`zip 内有仅大小写不同的重名文件：${name}`);
        seen.add(key);
        if (bytes + entry.uncompressedSize > limits.maxBytes) throw new ZipSafetyError(`解压总量超过上限 ${(limits.maxBytes / 1024 ** 2).toFixed(0)} MB`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
        let written = 0;
        const guard = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            written += chunk.length;
            if (bytes + written > limits.maxBytes) cb(new ZipSafetyError('解压总量超过上限（疑似 zip 炸弹）'));
            else cb(null, chunk);
          },
        });
        await pipeline(stream, guard, createWriteStream(dest));
        bytes += written;
        files++;
        hooks.onProgress?.({ files, bytes, total: zip.entryCount });
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  zip.close();
  return { files, bytes, skipped };
}
