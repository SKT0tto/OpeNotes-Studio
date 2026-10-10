import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { LIVE2D_LICENSE_URL, LIVE2D_SDK_DOWNLOAD_URL, REPO_URL } from '../../shared/meta';
import { DEFAULT_CUBISM_CORE_URL, updateFileConfig, type StudioConfig } from '../config';

export const LOCAL_CORE_URL = '/vendor/live2dcubismcore.min.js';
const CORE_FILE = 'live2dcubismcore.min.js';
const MAX_CORE_BYTES = 2 * 1024 * 1024;

/** `data/setup.local.json`: what the user has confirmed (Core licence, source disclaimers). Gitignored. */
export interface SetupState {
  coreLicenseAcceptedAt?: string;
  sources?: Record<string, { disclaimerAcceptedVersion: string; acceptedAt: string }>;
}

export class SetupStore {
  constructor(private readonly file: string) {}

  read(): SetupState {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as SetupState;
    } catch {
      return {};
    }
  }

  update(fn: (s: SetupState) => SetupState): SetupState {
    const next = fn(this.read());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return next;
  }
}

/** Only features of an official Core file: a size cap, the Live2D header text and the version entry point. */
export function validateCoreFile(buf: Buffer): string | null {
  if (buf.length === 0 || buf.length > MAX_CORE_BYTES) return `文件大小不合理（${buf.length} 字节；Core 约 200 KB，上限 2 MB）`;
  const head = buf.subarray(0, 4096).toString('utf8');
  if (!/Live2D Cubism Core/i.test(head) && !/Live2D Cubism Core/i.test(buf.toString('latin1'))) return '不是 Live2D Cubism Core（缺少 “Live2D Cubism Core” 声明）';
  if (!buf.toString('latin1').includes('csmGetLatestMocVersion')) return '不是 Live2D Cubism Core（缺少 csmGetLatestMocVersion）';
  return null;
}

export function setupRoutes(config: StudioConfig, store: SetupStore, fetchImpl: typeof fetch = fetch): Router {
  const r = Router();
  const vendorFile = () => path.join(config.vendorDir, CORE_FILE);

  const stateBody = () => {
    const st = store.read();
    return {
      licenseAccepted: Boolean(st.coreLicenseAcceptedAt),
      licenseUrl: LIVE2D_LICENSE_URL,
      downloadPageUrl: LIVE2D_SDK_DOWNLOAD_URL,
      officialUrl: DEFAULT_CUBISM_CORE_URL,
      cubismCoreUrl: config.cubismCoreUrl,
      local: config.cubismCoreUrl === LOCAL_CORE_URL,
      localFileExists: fs.existsSync(vendorFile()),
    };
  };

  r.get('/api/setup/core', (_req, res) => res.json(stateBody()));

  r.post('/api/setup/core/accept-license', (_req, res) => {
    store.update((s) => ({ ...s, coreLicenseAcceptedAt: new Date().toISOString() }));
    res.json(stateBody());
  });

  const requireLicense = (res: express.Response): boolean => {
    if (store.read().coreLicenseAcceptedAt) return true;
    res.status(403).json({ code: 'license_required', error: '请先阅读并确认 Live2D 专有软件许可协议' });
    return false;
  };

  const install = (buf: Buffer, res: express.Response): void => {
    const bad = validateCoreFile(buf);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    fs.mkdirSync(config.vendorDir, { recursive: true });
    const tmp = `${vendorFile()}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, vendorFile());
    const previous = config.cubismCoreUrl;
    updateFileConfig(config.configFile, { cubismCoreUrl: LOCAL_CORE_URL });
    config.cubismCoreUrl = LOCAL_CORE_URL;
    res.json({ ...stateBody(), previousUrl: previous });
  };

  // official download: only the Live2D URL, never a mirror
  r.post('/api/setup/core/fetch', async (_req, res) => {
    if (!requireLicense(res)) return;
    try {
      const resp = await fetchImpl(DEFAULT_CUBISM_CORE_URL, { headers: { 'user-agent': `OpeNotesStudio (+${REPO_URL})` }, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      install(Buffer.from(await resp.arrayBuffer()), res);
    } catch (e) {
      res.status(502).json({ code: 'official_unavailable', error: `无法从 Live2D 官方地址获取：${(e as Error).message}。可从官网下载 Cubism SDK for Web 后选择其中的 live2dcubismcore.min.js。` });
    }
  });

  r.post('/api/setup/core/upload', express.raw({ type: '*/*', limit: MAX_CORE_BYTES }), (req, res) => {
    if (!requireLicense(res)) return;
    install(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), res);
  });

  // forget the local copy / go back to the official URL
  r.post('/api/setup/core/reset', (_req, res) => {
    updateFileConfig(config.configFile, { cubismCoreUrl: null });
    config.cubismCoreUrl = DEFAULT_CUBISM_CORE_URL;
    res.json(stateBody());
  });

  r.use('/vendor', express.static(config.vendorDir, { fallthrough: true, index: false }));
  return r;
}
