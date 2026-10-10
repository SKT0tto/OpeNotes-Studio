import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSET_ROOT, DEFAULT_CUBISM_CORE_URL, DEFAULT_PORT, resolveConfig } from '../../server/config';
import { resolveInside } from '../../server/util/safePath';

describe('resolveConfig', () => {
  it('uses defaults when nothing is set', () => {
    const c = resolveConfig({}, {}, 'C:\\proj');
    expect(c.assetRoot).toBe(path.resolve(DEFAULT_ASSET_ROOT));
    expect(c.cubismCoreUrl).toBe(DEFAULT_CUBISM_CORE_URL);
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.audioRoots).toEqual([]);
    expect(c.dataDir).toBe(path.resolve('C:\\proj', 'data'));
  });

  it('config file overrides defaults, environment overrides the file', () => {
    const file = { assetRoot: 'C:\\file\\assets', port: 6000, audioRoots: ['C:\\a'] };
    expect(resolveConfig({}, file).assetRoot).toBe(path.resolve('C:\\file\\assets'));
    expect(resolveConfig({}, file).port).toBe(6000);
    const c = resolveConfig({ ASSET_ROOT: 'C:\\env\\assets', API_PORT: '7000', AUDIO_ROOTS: 'C:\\x;C:\\y' }, file);
    expect(c.assetRoot).toBe(path.resolve('C:\\env\\assets'));
    expect(c.port).toBe(7000);
    expect(c.audioRoots).toEqual([path.resolve('C:\\x'), path.resolve('C:\\y')]);
  });

  it('treats empty environment variables as unset', () => {
    const c = resolveConfig({ ASSET_ROOT: '  ', AUDIO_ROOTS: '', API_PORT: '' }, { assetRoot: 'C:\\file', audioRoots: ['C:\\a'] });
    expect(c.assetRoot).toBe(path.resolve('C:\\file'));
    expect(c.audioRoots).toEqual([path.resolve('C:\\a')]);
    expect(c.port).toBe(DEFAULT_PORT);
  });

  it('rejects an invalid port', () => {
    expect(() => resolveConfig({ API_PORT: 'abc' })).toThrow(/PORT/);
    expect(() => resolveConfig({ API_PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('resolveInside', () => {
  const root = path.resolve('C:\\lib\\assets');
  it('resolves normal relative paths', () => {
    expect(resolveInside(root, 'models/a/model3.json')).toBe(path.join(root, 'models', 'a', 'model3.json'));
    expect(resolveInside(root, 'models/../backgrounds/1.png')).toBe(path.join(root, 'backgrounds', '1.png'));
    expect(resolveInside(root, '')).toBe(root);
  });
  it('rejects traversal in every spelling', () => {
    for (const bad of ['../package.json', 'models/../../x', '..\\x', 'a/..\\..\\x', '/etc/passwd', 'C:\\Windows\\win.ini', 'D:/x', 'a\0b']) {
      expect(resolveInside(root, bad), bad).toBeNull();
    }
  });
  it('does not confuse sibling directories sharing a prefix', () => {
    expect(resolveInside(root, '../assets2/x')).toBeNull();
  });
});
