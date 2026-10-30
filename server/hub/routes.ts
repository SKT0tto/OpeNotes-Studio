import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router, type ErrorRequestHandler } from 'express';
import type { StudioConfig } from '../config';

/**
 * The title-screen (hub) custom background picture: one user image under `<dataDir>/hub/`, never in the repo and never in the
 * project background catalogue (it is a personal wallpaper, not story material). Every file name is built from constants.
 */
export const HUB_BG_MAX_BYTES = 20 * 1024 * 1024;
export const HUB_BG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const;
export type HubBgExt = keyof typeof HUB_BG_TYPES;

/** What the bytes really are, by magic number (the Content-Type header and file name are ignored). */
export function sniffImage(b: Buffer): HubBgExt | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export interface HubBgInfo {
  exists: boolean;
  ext?: HubBgExt;
  bytes?: number;
  /** Changes whenever the picture is replaced: use it to bust the browser cache. */
  version?: string;
}

export function hubBackgroundRoutes(config: StudioConfig): Router {
  const dir = path.join(config.dataDir, 'hub');
  const fileFor = (ext: HubBgExt) => path.join(dir, `background.${ext}`);
  const exts = Object.keys(HUB_BG_TYPES) as HubBgExt[];
  const find = async (): Promise<(HubBgInfo & { ext: HubBgExt }) | null> => {
    for (const ext of exts) {
      const st = await fs.stat(fileFor(ext)).catch(() => null);
      if (st?.isFile()) return { exists: true, ext, bytes: st.size, version: String(Math.round(st.mtimeMs)) };
    }
    return null;
  };
  const r = Router();

  r.get('/api/hub/background', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json((await find()) ?? { exists: false });
  });

  r.get('/api/hub/background/image', async (_req, res) => {
    const f = await find();
    if (!f) return void res.status(404).json({ error: 'no custom background' });
    res.set({ 'Content-Type': HUB_BG_TYPES[f.ext], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=0, must-revalidate' });
    res.sendFile(fileFor(f.ext), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'no custom background' });
    });
  });

  r.put('/api/hub/background', express.raw({ type: () => true, limit: HUB_BG_MAX_BYTES }), async (req, res) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: '没有收到图片' });
    const ext = sniffImage(body);
    if (!ext) return void res.status(400).json({ error: '不是有效的图片：只支持 PNG / JPG / WebP' });
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `background.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, fileFor(ext));
    for (const other of exts) if (other !== ext) await fs.rm(fileFor(other), { force: true });
    res.json(await find());
  });

  r.delete('/api/hub/background', async (_req, res) => {
    for (const ext of exts) await fs.rm(fileFor(ext), { force: true });
    res.json({ exists: false });
  });

  const tooBig: ErrorRequestHandler = (err: { type?: string; status?: number }, _req, res, next) => {
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: `图片超过大小上限 ${HUB_BG_MAX_BYTES / 1024 ** 2} MB` });
    next(err);
  };
  r.use(tooBig);
  return r;
}
