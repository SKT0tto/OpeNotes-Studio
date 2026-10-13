import { describe, expect, it } from 'vitest';
import { homePatch, homeTitle, searchCharacters } from '../../shared/catalog/bgHome';
import { BgLabelPatchSchema } from '../../shared/schema/assetLabels';

const uika = { key: '006', name: '三角初华', band: 'avemujica' };
describe('set as someone\'s home', () => {
  it('maps a character to owner, residents, band, private, exclusive, place and a title', () => {
    const p = homePatch(uika, '阁楼', 'night');
    expect(p).toMatchObject({ owner: '三角初华', ownerKey: '006', residents: ['006'], bands: ['avemujica'], access: 'private', exclusive: true, placeName: '三角初华家', title: '三角初华家·阁楼（夜间）' });
    expect(() => BgLabelPatchSchema.parse(p)).not.toThrow();
  });
  it('leaves out an empty area and an unspecified time', () => {
    expect(homeTitle('三角初华', '', 'unspecified')).toBe('三角初华家');
    expect(homePatch(uika).title).toBe('三角初华家');
  });
  it('finds characters by Chinese name, romanised name, key and band', () => {
    const list = [uika, { key: '001', name: '高松灯', band: 'mygo' }];
    expect(searchCharacters(list, '初华').map((c) => c.key)).toEqual(['006']);
    expect(searchCharacters(list, 'Uika').map((c) => c.key)).toEqual(['006']);
    expect(searchCharacters(list, 'mygo').map((c) => c.key)).toEqual(['001']);
    expect(searchCharacters(list, '')).toEqual([]);
  });
});
