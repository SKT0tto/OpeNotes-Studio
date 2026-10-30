import { describe, expect, it } from 'vitest';
import { parseSceneNo, routeIntent, type Intent } from '../../web/editor/panels/ai/intent';

const ctx = { sceneCount: 5, hasPrevious: true };
const route = (t: string, c = ctx) => routeIntent(t, c);

describe('typed commands that mean exactly one generation action', () => {
  const yes: Array<[string, Intent]> = [
    ['重新生成这一场', { kind: 'scene' }],
    ['生成这一场', { kind: 'scene' }],
    ['请帮我重新生成一下这一场。', { kind: 'scene' }],
    ['  重新生成本场！ ', { kind: 'scene' }],
    ['生成当前场景', { kind: 'scene' }],
    ['生成第3场', { kind: 'sceneNo', no: 3 }],
    ['请重新生成第二场～', { kind: 'sceneNo', no: 2 }],
    ['生成全部场景', { kind: 'all' }],
    ['重新生成所有场景的演出', { kind: 'all' }],
    ['换一版', { kind: 'fresh' }],
  ];
  it.each(yes)('routes 「%s」', (text, want) => {
    expect(route(text)).toEqual(want);
  });
  it('has exactly the ten positive sentences of the spec', () => {
    expect(yes).toHaveLength(10);
  });

  const no = [
    '重新生成这一场，节奏慢一点',
    '重新生成这一场的镜头',
    '这一场多用双人镜头',
    '生成第十场', // does not exist (5 scenes)
    '生成第0场',
    '生成第二场并且多用双人',
    '生成全部场景，去掉特效',
    '生成还没生成的场景',
    '换一版镜头',
    '再换一版',
    '把第二场重新生成一下然后节奏慢一点',
    '第二场节奏慢一点',
    '生成',
    '生成第场',
    '不要重新生成这一场',
    '',
    '   。',
  ];
  it.each(no)('does not route 「%s」', (text) => {
    expect(route(text)).toBeNull();
  });
  it('has at least fifteen negative sentences', () => {
    expect(no.length).toBeGreaterThanOrEqual(15);
  });
  it('「换一版」 needs an earlier generation to repeat; otherwise it goes to the assistant', () => {
    expect(route('换一版', { sceneCount: 5, hasPrevious: false })).toBeNull();
  });
  it('scene numbers: digits and Chinese numerals, only existing scenes', () => {
    expect(parseSceneNo('三')).toBe(3);
    expect(parseSceneNo('十')).toBe(10);
    expect(parseSceneNo('十二')).toBe(12);
    expect(parseSceneNo('二十一')).toBe(21);
    expect(parseSceneNo('12')).toBe(12);
    expect(Number.isNaN(parseSceneNo('三十三三'))).toBe(true);
    expect(route('生成第12场', { sceneCount: 12, hasPrevious: false })).toEqual({ kind: 'sceneNo', no: 12 });
    expect(route('生成第12场')).toBeNull();
  });
});
