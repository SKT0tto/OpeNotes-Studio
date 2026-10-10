import { describe, expect, it } from 'vitest';
import { parseExpressionName } from '../../shared/catalog/expressionNames';
import { parseMotionName } from '../../shared/catalog/motionNames';

describe('parseMotionName', () => {
  it.each([
    ['mtn_nod01_L', 'nod01', 'L', ''],
    ['mtn_idle01_C', 'idle01', 'C', ''],
    ['mtn_check01_R2', 'check01', 'R', '2'],
    ['mtn_look02_R_omit', 'look02', 'R', 'omit'],
    ['mtn_mal_angry01_L', 'mal_angry01', 'L', ''],
    ['mtn_haruhikage01_C%20', 'haruhikage01', 'C', ''],
    ['mtn_haruhikage01_C ', 'haruhikage01', 'C', ''],
  ])('%j -> family %s side %s', (raw, family, side, variant) => {
    expect(parseMotionName(raw)).toMatchObject({ raw, family, side, variant });
  });

  it('keeps irregular names whole with side=null', () => {
    for (const [raw, family] of [
      ['mtn_forget', 'forget'], ['mtn_ide01', 'ide01'], ['mtn_idle_01', 'idle_01'], ['mtn_play02_03_old', 'play02_03_old'],
      ['misc_tear01', 'misc_tear01'], ['exp_smile01', 'exp_smile01'], ['mtn_cry04', 'cry04'],
    ] as const) {
      expect(parseMotionName(raw)).toMatchObject({ raw, family, side: null });
    }
  });
});

describe('parseExpressionName', () => {
  it('splits family and index', () => {
    expect(parseExpressionName('exp_bsmile02')).toEqual({ raw: 'exp_bsmile02', family: 'bsmile', index: 2 });
    expect(parseExpressionName('exp_kirakira01')).toMatchObject({ family: 'kirakira', index: 1 });
    expect(parseExpressionName('exp_idle')).toMatchObject({ family: 'idle', index: null });
  });
});
