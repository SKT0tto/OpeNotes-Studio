import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CUBISM_CORE_URL } from '../../server/config';
import { validateCoreFile as serverValidate } from '../../server/setup/routes';

// plain-Node script of the release package (no TypeScript, no dependencies)
const mod = (await import(pathToFileURL(path.resolve('scripts', 'fetch-core.mjs')).href)) as {
  OFFICIAL_CORE_URL: string;
  LOCAL_CORE_URL: string;
  validateCoreFile: (b: Buffer) => string | null;
  resolvePaths: (env: Record<string, string | undefined>, cwd: string) => { configFile: string; vendorFile: string; setupFile: string };
  hasLocalCore: (p: { vendorFile: string }) => boolean;
  installCore: (p: ReturnType<typeof mod.resolvePaths>, o: { fetchImpl: typeof fetch; log: (m: string) => void }) => Promise<boolean>;
  main: (argv: string[], env: Record<string, string | undefined>, cwd: string) => Promise<number>;
};

const goodCore = Buffer.from('/*! Live2D Cubism Core */ function csmGetLatestMocVersion(){}');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchcore-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('fetch-core.mjs', () => {
  it('uses the same official URL and validation as the server', () => {
    expect(mod.OFFICIAL_CORE_URL).toBe(DEFAULT_CUBISM_CORE_URL);
    for (const buf of [goodCore, Buffer.from('nope'), Buffer.alloc(0), Buffer.from('Live2D Cubism Core only')]) {
      expect(mod.validateCoreFile(buf) === null).toBe(serverValidate(buf) === null);
    }
  });

  it('downloads from the official URL only, records the licence and activates the local copy', async () => {
    const paths = mod.resolvePaths({}, dir);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(goodCore);
    }) as unknown as typeof fetch;
    expect(await mod.installCore(paths, { fetchImpl, log: () => {} })).toBe(true);
    expect(urls).toEqual([DEFAULT_CUBISM_CORE_URL]);
    expect(mod.hasLocalCore(paths)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).cubismCoreUrl).toBe('/vendor/live2dcubismcore.min.js');
    expect(JSON.parse(fs.readFileSync(paths.setupFile, 'utf8')).coreLicenseAcceptedAt).toBeTruthy();
  });

  it('keeps the licence confirmation but installs nothing when the download is not a Core', async () => {
    const paths = mod.resolvePaths({}, dir);
    const fetchImpl = (async () => new Response('<html>blocked</html>')) as unknown as typeof fetch;
    expect(await mod.installCore(paths, { fetchImpl, log: () => {} })).toBe(false);
    expect(fs.existsSync(paths.vendorFile)).toBe(false);
    expect(fs.existsSync(paths.configFile)).toBe(false);
    expect(fs.existsSync(paths.setupFile)).toBe(true);
  });

  it('--no-core and a missing terminal skip without touching anything', async () => {
    expect(await mod.main(['--no-core'], {}, dir)).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await mod.main([], {}, dir)).toBe(0); // test runners have no TTY on stdin
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
