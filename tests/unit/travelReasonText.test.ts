import { describe, expect, it } from 'vitest';
import { travelReasonText } from '../../shared/catalog/labels';

describe('travelReasonText', () => {
  it('drops a leading 运镜： / 运镜决定： so the panel label does not repeat it', () => {
    expect(travelReasonText('运镜：推近强调，向右')).toBe('推近强调，向右');
    expect(travelReasonText('运镜决定：横移')).toBe('横移');
    expect(travelReasonText('硬切：空镜/插入')).toBe('硬切：空镜/插入');
    expect(travelReasonText('收势：场首轻推后运镜：稳定')).toBe('收势：场首轻推后运镜：稳定');
  });
});
