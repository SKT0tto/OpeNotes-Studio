import type { Page } from '@playwright/test';

export type InspectorTab = 'project' | 'scene' | 'beat' | 'actor' | 'shot' | 'key' | 'style';

/** Switch the inspector to one of its tabs. */
export const tab = (page: Page, name: InspectorTab) => page.getByTestId(`insp-tab-${name}`).click();
