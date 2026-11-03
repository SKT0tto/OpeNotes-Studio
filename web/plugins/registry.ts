/** What loaded plugins registered: top-bar buttons and inspector sections. Empty without plugins. */
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { PluginInfo } from '@shared/plugins/api';
import type { Beat, Project, Scene } from '@shared/schema/project';

export interface TopBarButton { pluginId: string; id: string; label: string; title?: string | undefined; dialog: ComponentType<{ onClose(): void }> }
export interface InspectorSectionReg { pluginId: string; id: string; component: ComponentType<{ project: Project; scene: Scene; beat: Beat }> }

export const usePlugins = create<{
  info: PluginInfo[];
  buttons: TopBarButton[];
  sections: InspectorSectionReg[];
}>(() => ({ info: [], buttons: [], sections: [] }));

export const addButton = (b: TopBarButton) => usePlugins.setState((s) => ({ buttons: [...s.buttons.filter((x) => !(x.pluginId === b.pluginId && x.id === b.id)), b] }));
export const addSection = (r: InspectorSectionReg) => usePlugins.setState((s) => ({ sections: [...s.sections.filter((x) => !(x.pluginId === r.pluginId && x.id === r.id)), r] }));
