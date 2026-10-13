import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LabelFileSchema } from '../../shared/schema/assetLabels';
import { bgCategoryOf } from '../../shared/director/bgCategory';
import { pendingQueue } from '../../shared/catalog/bgUi';
import { bgFromLabel } from './helpers/labelCatalog';

// Invariants of the live, user-edited label file. No ids, owners or counts of the data are asserted, so label edits never break these.
const LIVE = LabelFileSchema.parse(JSON.parse(fs.readFileSync('asset-labels/backgrounds.json', 'utf8')));
const FIXTURE = LabelFileSchema.parse(JSON.parse(fs.readFileSync('tests/fixtures/backgrounds.labels.fixture.json', 'utf8')));
const entries = Object.entries(LIVE.labels).map(([id, l]) => bgFromLabel(id, l));

describe('live label file invariants', () => {
  it('is schema valid and covers every background of the frozen catalog fixture', () => {
    for (const id of Object.keys(FIXTURE.labels)) expect(LIVE.labels[id], id).toBeTruthy();
  });
  it('decor is never a scene candidate', () => {
    for (const b of pendingQueue(entries)) expect(bgCategoryOf(b)).not.toBe('decor');
  });
  it('user-sourced confirmed entries carry no pending fixes except explicit ownership doubts', () => {
    for (const [id, l] of Object.entries(LIVE.labels)) if (l.source === 'user' && l.confidence === 'confirmed') expect((l.fixes ?? []).filter((f) => !f.field.startsWith('owner')), id).toHaveLength(0);
  });
  it('the queue holds only entries that genuinely need the user, and stays small', () => {
    const q = pendingQueue(entries);
    for (const b of q) {
      const l = b.labels!;
      expect(!!l.duplicateOf).toBe(false);
      expect((l.fixes?.length ?? 0) > 0 || l.confidence !== 'confirmed' || l.bands.length === 0, b.id).toBe(true);
    }
    expect(q.length).toBeLessThan(Object.keys(LIVE.labels).length / 4);
  });
});
