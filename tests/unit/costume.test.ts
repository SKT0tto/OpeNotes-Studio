import { describe, expect, it } from 'vitest';
import { costumeLabel, parseCostume, splitModelId } from '../../shared/catalog/costume';

describe('splitModelId', () => {
  it.each([
    ['001_casual_spring_01', '001', 'casual_spring_01', false],
    ['001_live-mode_live_01_low', '001', 'live-mode_live_01_low', false],
    ['sub_bota_casual_spring_01_still', 'sub_bota', 'casual_spring_01_still', true],
    ['sub_a_ko_casual_spring_01_still', 'sub_a_ko', 'casual_spring_01_still', true],
    ['sub_mikus_father_casual_spring_01', 'sub_mikus_father', 'casual_spring_01', true],
    ['sub_raikas_fathers_secretary_suits_01', 'sub_raikas_fathers_secretary', 'suits_01', true],
    ['sub_bell_school_winter_hs', 'sub_bell', 'school_winter_hs', true],
  ])('%s', (id, key, costume, isSub) => {
    expect(splitModelId(id)).toEqual({ characterKey: key, costume, isSub });
  });
});

describe('parseCostume', () => {
  it('parses casual/season', () => {
    expect(parseCostume('casual_spring_01')).toMatchObject({ base: 'casual', season: 'spring', glasses: false, mode: 'adv', quality: '', still: false });
  });
  it('parses school variants with grade and glasses', () => {
    expect(parseCostume('school_winter_hs_1st_glasses')).toMatchObject({ base: 'school', season: 'winter', school: 'hs', grade: 1, glasses: true });
    expect(parseCostume('school_summer_jhs_3rd')).toMatchObject({ base: 'school', season: 'summer', school: 'jhs', grade: 3 });
    expect(parseCostume('school_winter_jhs')).toMatchObject({ school: 'jhs' });
    expect(parseCostume('school_winter_jhs').grade).toBeUndefined();
  });
  it('detects live-mode vs story live costume', () => {
    expect(parseCostume('live-mode_live_01')).toMatchObject({ base: 'live', mode: 'live', tags: [] });
    expect(costumeLabel(parseCostume('live-mode_live_01'))).toBe('live');
    expect(parseCostume('live_01')).toMatchObject({ base: 'live', mode: 'adv' });
    expect(parseCostume('live_01_mask_silhouette').tags).toEqual(['mask', 'silhouette']);
  });
  it('detects quality and still', () => {
    expect(parseCostume('live_01_low')).toMatchObject({ quality: 'low', base: 'live' });
    expect(parseCostume('casual_spring_01_still')).toMatchObject({ still: true, quality: '' });
    expect(parseCostume('live-mode_live_01_low')).toMatchObject({ quality: 'low', mode: 'live' });
  });
  it('maps other bases and keeps leftovers as tags', () => {
    expect(parseCostume('roomwear_01_glasses')).toMatchObject({ base: 'roomwear', glasses: true });
    expect(parseCostume('suits_01_still').base).toBe('suits');
    expect(parseCostume('virtual_01').base).toBe('virtual');
    expect(parseCostume('arbeit_ring_01')).toMatchObject({ base: 'other', tags: ['arbeit', 'ring'] });
    expect(parseCostume('casual_spring_01_hairdown_nose_glasses')).toMatchObject({ base: 'casual', glasses: true, tags: ['hairdown', 'nose'] });
    expect(parseCostume('jhs_casual_spring_01_still')).toMatchObject({ base: 'casual', school: 'jhs', still: true });
    expect(parseCostume('01_still')).toMatchObject({ base: 'other', still: true });
  });
  it('produces a readable label', () => {
    expect(costumeLabel(parseCostume('school_winter_hs_1st_glasses'))).toBe('school · winter · hs · 1年 · glasses');
    expect(costumeLabel(parseCostume('arbeit_ring_01'))).toBe('arbeit · ring');
  });
});
