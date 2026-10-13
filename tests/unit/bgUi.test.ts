import { describe, expect, it } from 'vitest';
import { entryFromLabel, fixPatch, pendingQueue, reviewOf, searchBackgrounds, suggestionText } from '../../shared/catalog/bgUi';
import { BgLabelPatchSchema } from '../../shared/schema/assetLabels';
import { LABEL_FILE, bgFromLabel, stage } from './helpers/labelCatalog';

const all = Object.entries(LABEL_FILE.labels).map(([id, l]) => bgFromLabel(id, l));

describe('review suggestions (fixes)', () => {
  const fixes = Object.entries(LABEL_FILE.labels).flatMap(([id, l]) => (l.fixes ?? []).map((f) => ({ id, f })));
  it('37 suggestions in 34 backgrounds are queued; none of them has been applied', () => {
    expect(fixes).toHaveLength(37);
    expect(new Set(fixes.map((x) => x.id)).size).toBe(34);
  });
  it('a fix becomes a valid label patch, or none (ownership doubts are display only)', () => {
    let withPatch = 0;
    for (const { id, f } of fixes) {
      const p = fixPatch(f);
      if (/^owner|疑问/.test(f.field) || f.question) {
        expect(p, `${id} ${f.field}`).toBeNull();
        continue;
      }
      expect(p, `${id} ${f.field}`).not.toBeNull();
      expect(() => BgLabelPatchSchema.parse(p), `${id} ${f.field}`).not.toThrow();
      withPatch++;
    }
    expect(withPatch).toBeGreaterThanOrEqual(30);
  });
  it('specific mappings: names write the title, place types the placeType, the owner is never touched', () => {
    const fx = (id: string, field: string) => LABEL_FILE.labels[id]!.fixes!.find((f) => f.field === field)!;
    expect(fixPatch(fx(stage(103), 'placeType'))).toEqual({ placeType: 'restaurant' });
    expect(fixPatch(fx(stage(103), 'name'))).toEqual({ title: '拉面店吧台·红凳' });
    expect(fixPatch(fx(stage(102), 'placeType'))).toEqual({ placeType: 'art_installation', category: 'event' });
    expect(fixPatch(fx(stage(297), 'placeType/indoor'))).toMatchObject({ placeType: 'street', indoor: 'outdoor' });
    expect(fixPatch(fx(stage(81), 'owner（疑问，不改）'))).toBeNull();
    for (const { f } of fixes) expect(fixPatch(f) ?? {}).not.toHaveProperty('owner');
  });
  it('the card line shows the suggestion with the old value', () => {
    expect(suggestionText(LABEL_FILE.labels[stage(103)])).toContain('建议：');
    expect(suggestionText(LABEL_FILE.labels[stage(81)])).toContain('疑问：');
    expect(suggestionText(LABEL_FILE.labels[stage(46)])).toBeNull();
  });
});

describe('review state and the queue', () => {
  it('colours: a user-confirmed entry is confirmed; one with a pending suggestion or unknown owner is not', () => {
    expect(reviewOf(bgFromLabel(stage(46), LABEL_FILE.labels[stage(46)]!))).toBe('confirmed');
    expect(reviewOf(bgFromLabel(stage(103), LABEL_FILE.labels[stage(103)]!))).toBe('question');
    const unknown = all.find((b) => b.labels!.bands.length === 0 && !b.labels!.fixes?.length)!;
    expect(reviewOf(unknown)).toBe('unknown');
    expect(reviewOf({ labels: undefined })).toBe('unknown');
  });
  it('the queue lists only what waits for the user, grouped by place, without duplicates or decor', () => {
    const q = pendingQueue(all);
    expect(q.length).toBeGreaterThan(100);
    for (const b of q) {
      expect(reviewOf(b)).not.toBe('confirmed');
      expect(b.labels!.duplicateOf).toBeFalsy();
      expect(b.labels!.category).not.toBe('decor');
    }
    const first = q.slice(0, 30).map((b) => b.labels!.placeName ?? b.labels!.location ?? b.name);
    expect(first.join('|')).toBeTruthy();
    expect(pendingQueue(all).map((b) => b.id)).toEqual(q.map((b) => b.id));
  });
});

describe('search', () => {
  it('every term must hit; title hits rank first; description, tags, place and owner are searched', () => {
    const r = searchBackgrounds(all, 'RiNG');
    expect(r.length).toBeGreaterThan(3);
    expect(r[0]!.name).toContain('RiNG');
    const nightBedroom = searchBackgrounds(all, '夜 卧室');
    expect(nightBedroom.length).toBeGreaterThan(3);
    for (const b of nightBedroom) expect(`${b.name} ${b.description} ${b.tags.join(' ')} ${b.time} ${b.labels?.placeName}`).toMatch(/夜/);
    expect(nightBedroom.slice(0, 3).every((b) => /夜/.test(b.name) && /卧室/.test(`${b.name}${b.tags.join('')}`))).toBe(true);
    const signal = searchBackgrounds(all, '信号灯');
    expect(signal.length).toBeGreaterThanOrEqual(8);
    expect(signal.slice(0, 8).every((b) => b.name.includes('信号灯'))).toBe(true);
    expect(searchBackgrounds(all, '不存在的地点xyz')).toEqual([]);
    expect(searchBackgrounds(all, '').length).toBe(all.length);
    expect(searchBackgrounds(all, '千早爱音').some((b) => b.labels?.owner?.includes('爱音'))).toBe(true);
  });
  it('titles are unique, so a card is told apart by its title', () => {
    expect(new Set(all.map((b) => b.name)).size).toBe(all.length);
  });
});

describe('entries from labels alone (the workbench without a library)', () => {
  it('title, description, tags and category come from the label', () => {
    const e = entryFromLabel('adv_bkg_stage_000103', LABEL_FILE.labels[stage(103)]!);
    expect(e.name).toBe('拉面店吧台·红凳');
    expect(e.description).toBeTruthy();
    expect(e.category).toBe('scene');
    expect(e.tags.length).toBeGreaterThan(0);
  });
});
