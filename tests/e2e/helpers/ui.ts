import type { Page } from '@playwright/test';

export type InspectorTab = 'project' | 'scene' | 'beat' | 'actor' | 'shot' | 'key' | 'style';

/**
 * The one AI panel (the 「生成」 section = the AI director, the assistant chat below) sits in the inspector's group as a background tab in the
 * default layout: bring the inspector to the front when the AI panel is in front of it.
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

/** Bring the AI panel to the front (adding it when it was closed); the 「生成」 section is expanded unless `generate` is false. */
export async function openAi(page: Page, opts: { generate?: boolean } = {}): Promise<void> {
  if (!(await page.getByTestId('ai-merged-panel').isVisible())) await page.getByTestId('btn-agent').click();
  await page.getByTestId('ai-merged-panel').waitFor({ state: 'visible' });
  if (opts.generate === false) return;
  const section = page.getByTestId('ai-generate-section');
  if ((await section.getAttribute('data-open')) !== '1') await page.getByTestId('ai-generate-toggle').click();
  await page.getByTestId('ai-panel').waitFor({ state: 'visible' });
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
