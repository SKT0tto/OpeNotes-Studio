import { describe, expect, it } from 'vitest';
import { checkMoc3Header, normalizeModel3, refBasename } from '../../server/assets/import/normalizeModel3';

const present = (...files: string[]) => (ref: string) => files.find((f) => f.endsWith(refBasename(ref))) ?? null;

const siteModel = (motions: string[]) => ({
  Version: 3,
  Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: [] }],
  FileReferences: {
    Moc: 'model.moc3',
    Textures: ['/runtime/intl/unity/Assets/a/texture_00--Texture2D-1.png', 'https://example.invalid/x/texture_01--Texture2D-2.png'],
    Physics: 'physics3.json',
    Expressions: [{ Name: 'exp_smile01', File: 'expressions/exp_smile01.exp3.json' }],
    Motions: { Motion: motions.map((m) => ({ File: `motions/${m}.motion3.json`, FadeInTime: 1 })) },
  },
});

describe('normalizeModel3', () => {
  const files = ['model.moc3', 'physics3.json', 'texture_00--Texture2D-1.png', 'texture_01--Texture2D-2.png', 'exp_smile01.exp3.json', 'a.motion3.json', 'b.motion3.json', 'c%20d.motion3.json'];

  it('rewrites site textures to textures/<basename> and splits the single Motion group', () => {
    const r = normalizeModel3(siteModel(['a', 'b', 'c%20d']), present(...files));
    expect(r.errors).toEqual([]);
    expect(r.changed).toBe(true);
    const refs = (r.json as { FileReferences: Record<string, unknown> }).FileReferences;
    expect(refs.Textures).toEqual(['textures/texture_00--Texture2D-1.png', 'textures/texture_01--Texture2D-2.png']);
    expect(Object.keys(refs.Motions as object)).toEqual(['a', 'b', 'c d']);
    expect(r.counts).toEqual({ textures: 2, motions: 3, expressions: 1 });
    expect((r.json as { Groups: unknown[] }).Groups).toHaveLength(1);
    expect(r.files.map((f) => f.dest)).toContain('motions/c%20d.motion3.json');
  });

  it('keeps irregular existing single-entry group names untouched', () => {
    const input = {
      FileReferences: { Moc: 'model.moc3', Textures: ['textures/t.png'], Motions: { 'mtn_haruhikage01_C%20': [{ File: 'motions/mtn_haruhikage01_C .motion3.json' }] } },
    };
    const r = normalizeModel3(input, () => 'x');
    expect(Object.keys((r.json as { FileReferences: { Motions: object } }).FileReferences.Motions)).toEqual(['mtn_haruhikage01_C%20']);
    expect(r.changed).toBe(false);
  });

  it('reports a missing texture as an error and a missing motion as a warning', () => {
    const r = normalizeModel3(siteModel(['a', 'zzz']), present('model.moc3', 'a.motion3.json', 'texture_00--Texture2D-1.png'));
    expect(r.errors.some((e) => e.includes('texture_01'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('zzz'))).toBe(true);
  });

  it('rejects non-objects and a model without Moc', () => {
    expect(normalizeModel3('x', () => null).errors).toHaveLength(1);
    expect(normalizeModel3({ FileReferences: { Textures: [] } }, () => null).errors.length).toBeGreaterThan(0);
  });

  it('makes colliding destination names unique', () => {
    const input = { FileReferences: { Moc: 'm.moc3', Textures: ['a/t.png', 'b/t.png'], Motions: {} } };
    const r = normalizeModel3(input, (ref) => ref);
    expect((r.json as { FileReferences: { Textures: string[] } }).FileReferences.Textures).toEqual(['textures/t.png', 'textures/t_2.png']);
  });
});

describe('checkMoc3Header', () => {
  it('accepts MOC3 and reads the version byte', () => {
    expect(checkMoc3Header(Buffer.from([0x4d, 0x4f, 0x43, 0x33, 5]))).toEqual({ ok: true, version: 5 });
    expect(checkMoc3Header(Buffer.from('nope!')).ok).toBe(false);
  });
});
