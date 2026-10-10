import { describe, expect, it } from 'vitest';
import { filterBackgrounds } from '../../shared/catalog/search';
import type { BackgroundEntry } from '../../shared/schema/assets';

const bg = (id: string, over: Partial<BackgroundEntry>): BackgroundEntry => ({
  id, url: `/assets/backgrounds/${id}.png`, width: 2048, height: 1119, name: id, aliases: [], kind: 'scene', location: null,
  category: null, setting: '室内', time: '日间', weather: null, description: null, tags: [], ...over,
});
const list = [
  bg('1', { name: 'RiNG 咖啡厅 · 日间', aliases: ['RiNG Cafe'], time: '日间' }),
  bg('2', { name: 'RiNG 外观', time: '夜间', setting: '室外' }),
  bg('3', { name: '天台', time: '夜间', setting: '室外', description: '学校屋顶', kind: 'insert' }),
];

describe('filterBackgrounds', () => {
  it('requires every term, across name and structured fields', () => {
    expect(filterBackgrounds(list, { query: 'RiNG 夜间' }).map((b) => b.id)).toEqual(['2']);
    expect(filterBackgrounds(list, { query: 'ring' }).map((b) => b.id)).toEqual(['1', '2']);
    expect(filterBackgrounds(list, { query: '屋顶' }).map((b) => b.id)).toEqual(['3']);
    expect(filterBackgrounds(list, { query: 'cafe' }).map((b) => b.id)).toEqual(['1']);
  });
  it('combines select filters with the query', () => {
    expect(filterBackgrounds(list, { time: '夜间' }).map((b) => b.id)).toEqual(['2', '3']);
    expect(filterBackgrounds(list, { time: '夜间', kind: 'insert' }).map((b) => b.id)).toEqual(['3']);
    expect(filterBackgrounds(list, { setting: '室内', query: '天台' })).toEqual([]);
  });
  it('returns everything for an empty filter', () => {
    expect(filterBackgrounds(list, { query: '  ' })).toHaveLength(3);
  });
});
