import express, { Router } from 'express';
import { z } from 'zod';
import type { LabelFile } from '../../../shared/schema/assetLabels';
import type { SetupStore } from '../../setup/routes';
import type { CatalogService } from '../indexer';
import {
  HANEOKA_DISCLAIMER, HANEOKA_DISCLAIMER_VERSION, HANEOKA_LOCALES, HaneokaFormatError, buildList, buildManifestItems, manifestCsv, manifestMarkdown,
  type HaneokaSource,
} from './haneoka';

const SOURCE_ID = 'haneoka';

/**
 * The server-side gate: until the current disclaimer version has been confirmed, every data route of the source
 * answers 403 `disclaimer_required` (the UI is not trusted to enforce it).
 */
export function sourceRoutes(deps: { source: HaneokaSource; store: SetupStore; catalog: CatalogService; labels: () => Promise<LabelFile | null> }): Router {
  const r = Router();
  const accepted = () => deps.store.read().sources?.[SOURCE_ID]?.disclaimerAcceptedVersion === HANEOKA_DISCLAIMER_VERSION;
  const gate: express.RequestHandler = (_req, res, next) => {
    if (accepted()) next();
    else res.status(403).json({ code: 'disclaimer_required', error: '请先阅读并确认免责声明', version: HANEOKA_DISCLAIMER_VERSION });
  };

  r.get('/api/sources/haneoka', (_req, res) => {
    res.json({
      id: SOURCE_ID, name: 'Haneoka（仅清单）', policy: 'manual-only', accepted: accepted(), disclaimerVersion: HANEOKA_DISCLAIMER_VERSION,
      disclaimer: HANEOKA_DISCLAIMER, locales: HANEOKA_LOCALES,
    });
  });

  r.post('/api/sources/haneoka/accept', express.json(), (req, res) => {
    const version = (req.body as { version?: unknown } | undefined)?.version;
    if (version !== HANEOKA_DISCLAIMER_VERSION) {
      res.status(409).json({ error: '免责声明版本已更新，请刷新后重新阅读', version: HANEOKA_DISCLAIMER_VERSION });
      return;
    }
    deps.store.update((s) => ({ ...s, sources: { ...s.sources, [SOURCE_ID]: { disclaimerAcceptedVersion: version, acceptedAt: new Date().toISOString() } } }));
    res.json({ accepted: true });
  });

  const loadList = async (locale: string, force: boolean) => {
    const { data, fromCache } = await deps.source.load({ force });
    const cat = await deps.catalog.get();
    const list = buildList(
      data,
      { models: new Set(cat.models.map((m) => m.id)), backgrounds: new Set(cat.backgrounds.map((b) => b.id)) },
      await deps.labels().catch(() => null),
      { locale },
    );
    return { list, fromCache };
  };
  const localeOf = (v: unknown) => (typeof v === 'string' && (HANEOKA_LOCALES as readonly string[]).includes(v) ? v : 'en');
  const fail = (res: express.Response, e: unknown) => {
    const msg = e instanceof HaneokaFormatError ? `站点索引格式已变化：${e.message}。可直接打开 haneoka.org 手动查找。` : `无法读取站点索引：${(e as Error).message}。可稍后重试，或直接打开 haneoka.org。`;
    res.status(502).json({ code: 'source_unavailable', error: msg });
  };

  r.get('/api/sources/haneoka/list', gate, async (req, res) => {
    try {
      res.json(await loadList(localeOf(req.query.locale), req.query.refresh === '1'));
    } catch (e) {
      fail(res, e);
    }
  });

  const Sel = z.object({ models: z.array(z.string()).max(1000).default([]), backgrounds: z.array(z.string()).max(1000).default([]), format: z.enum(['json', 'md', 'csv']).default('json'), locale: z.string().optional() });
  r.post('/api/sources/haneoka/manifest', gate, express.json({ limit: '1mb' }), async (req, res) => {
    const sel = Sel.safeParse(req.body ?? {});
    if (!sel.success) {
      res.status(400).json({ error: '选择格式不正确' });
      return;
    }
    try {
      const { list } = await loadList(localeOf(sel.data.locale), false);
      const items = buildManifestItems(list, sel.data);
      if (sel.data.format === 'md') res.type('text/markdown; charset=utf-8').set('Content-Disposition', 'attachment; filename="openotes-manifest.md"').send(manifestMarkdown(items, list));
      else if (sel.data.format === 'csv') res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="openotes-manifest.csv"').send(manifestCsv(items));
      else res.json({ items, releaseId: list.releaseId });
    } catch (e) {
      fail(res, e);
    }
  });

  return r;
}
