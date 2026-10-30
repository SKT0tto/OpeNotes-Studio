import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HUB_BG_MAX_BYTES, hubBackgroundRoutes, sniffImage } from '../../server/hub/routes';
import type { StudioConfig } from '../../server/config';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64, 3)]);

let tmp: string;
let server: Server;
let base: string;
const put = (body: Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/hub/background`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(body) });
const hubFiles = () => fs.readdir(path.join(tmp, 'hub')).catch(() => [] as string[]);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-bg-'));
  const app = express();
  app.use(hubBackgroundRoutes({ dataDir: tmp } as StudioConfig));
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('sniffImage', () => {
  it('reads the magic bytes, not names', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPG)).toBe('jpg');
    expect(sniffImage(WEBP)).toBe('webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF....WAVE'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('hub background routes', () => {
  it('starts empty: info says none, image is 404', async () => {
    expect(await (await fetch(`${base}/api/hub/background`)).json()).toEqual({ exists: false });
    expect((await fetch(`${base}/api/hub/background/image`)).status).toBe(404);
  });

  it('rejects non-images (even with an image content type or file name) and writes nothing', async () => {
    for (const body of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('MZ-not-an-image'), Buffer.from('GIF89a1234')]) {
      const r = await put(body, { 'Content-Type': 'image/png', 'X-Filename': 'evil.png' });
      expect(r.status).toBe(400);
    }
    expect((await put(Buffer.alloc(0))).status).toBe(400);
    expect(await hubFiles()).toEqual([]);
  });

  it('rejects an upload over the size limit with 413 and writes nothing', async () => {
    const r = await put(Buffer.concat([PNG, Buffer.alloc(HUB_BG_MAX_BYTES)]));
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toContain('20 MB');
    expect(await hubFiles()).toEqual([]);
  });

  it('stores a png under the data dir only, serves it with its real type, and ignores file-name tricks', async () => {
    const r = await put(PNG, { 'X-Filename': '../../../evil.png' });
    expect(r.status).toBe(200);
    const info = (await r.json()) as { exists: boolean; ext: string; bytes: number; version: string };
    expect(info).toMatchObject({ exists: true, ext: 'png', bytes: PNG.length });
    expect(await hubFiles()).toEqual(['background.png']);
    const img = await fetch(`${base}/api/hub/background/image?v=${info.version}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    expect(await fs.readdir(tmp)).toEqual(['hub']);
  });

  it('replacing with another format leaves exactly one file', async () => {
    expect((await put(JPG)).status).toBe(200);
    expect(await hubFiles()).toEqual(['background.jpg']);
    expect((await fetch(`${base}/api/hub/background/image`)).headers.get('content-type')).toBe('image/jpeg');
    expect((await put(WEBP)).status).toBe(200);
    expect(await hubFiles()).toEqual(['background.webp']);
  });

  it('delete removes it, and a second delete is fine', async () => {
    expect(await (await fetch(`${base}/api/hub/background`, { method: 'DELETE' })).json()).toEqual({ exists: false });
    expect(await hubFiles()).toEqual([]);
    expect((await fetch(`${base}/api/hub/background`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/api/hub/background/image`)).status).toBe(404);
  });
});
