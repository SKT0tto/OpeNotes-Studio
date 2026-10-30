import type { Page } from '@playwright/test';

export type InspectorTab = 'project' | 'scene' | 'beat' | 'actor' | 'shot' | 'key' | 'style';

/**
 * The one AI panel (chat first: one stream, a composer at the bottom with the 「生成 ▾」 popover) sits in the inspector's group as a background
 * tab in the default layout: bring the inspector to the front when the AI panel is in front of it.
 */
export async function showInspector(page: Page): Promise<void> {
  if (!(await page.getByTestId('right-panel').isVisible())) await page.getByTestId('dock-tab-inspector').locator('.dock-tab-title').click(); // the title, not the tab's ✕
  await page.getByTestId('right-panel').waitFor({ state: 'visible' });
}

/** Switch the inspector to one of its tabs. */
export const tab = async (page: Page, name: InspectorTab): Promise<void> => {
  await showInspector(page);
  await page.getByTestId(`insp-tab-${name}`).click();
};

/** Open the 「生成 ▾」 popover (it closes itself when 「生成」 is used): the generation options and buttons live in it. */
export async function aiPop(page: Page): Promise<void> {
  if (!(await page.getByTestId('ai-gen-popover').isVisible())) await page.getByTestId('ai-gen-chip').click();
  await page.getByTestId('ai-gen-popover').waitFor({ state: 'visible' });
}

/** Bring the AI panel to the front (adding it when it was closed); the 「生成 ▾」 popover is opened (unless `generate` is false) with `target` chosen (default: this scene). */
export async function openAi(page: Page, opts: { generate?: boolean; target?: 'scene' | 'all' } = {}): Promise<void> {
  if (!(await page.getByTestId('ai-merged-panel').isVisible())) await page.getByTestId('btn-agent').click();
  await page.getByTestId('ai-merged-panel').waitFor({ state: 'visible' });
  if (opts.generate === false) return;
  await aiPop(page);
  await page.getByTestId(`ai-gen-target-${opts.target ?? 'scene'}`).click();
}

/** The AI settings as 「configured」 (the assistant's free-text box is disabled without an AI model; the model itself is never called in these tests). */
export async function mockAiConfigured(page: Page): Promise<void> {
  await page.route('**/api/llm/settings', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: {
      provider: 'openai', available: ['anthropic', 'openai'],
      anthropic: { hasKey: false, mask: null, source: null, model: '', baseUrl: '' },
      openai: { hasKey: false, mask: null, source: null, model: 'fixture', baseUrl: '' },
      status: { configured: true, provider: 'openai', model: 'fixture', verified: 'none', message: 'Fixture AI configured' },
    } })
    : route.fallback());
}

/**
 * The AI panel in its own column right of the stage, so that it and the inspector are on screen together: a panel that is closed and
 * opened again is added as a new column (the default layout has it behind the inspector's tab).
 */
export async function aiColumn(page: Page): Promise<void> {
  await openAi(page, { generate: false });
  await page.getByTestId('agent-close').click();
  await page.getByTestId('btn-agent').click();
  await page.getByTestId('ai-merged-panel').waitFor({ state: 'visible' });
  await page.getByTestId('right-panel').waitFor({ state: 'visible' });
}
