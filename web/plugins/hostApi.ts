import { useSyncExternalStore } from 'react';
import { PLUGIN_API_VERSION, type HostApi, type StudioSnapshot } from '@shared/plugins/api';
import pkg from '../../package.json';
import { Modal, Row, Section } from '../editor/ui';
import { useProject } from '../store/projectStore';
import { notify } from '../store/uiStore';
import { useVoicePrefs } from '../store/voicePrefs';
import { applyBeatVoice } from './patches';
import { addButton, addSection } from './registry';

const snapshot = (): StudioSnapshot => {
  const s = useProject.getState();
  return { project: s.project, selection: s.selection };
};
let cache = snapshot();
const current = (): StudioSnapshot => {
  const s = useProject.getState();
  if (cache.project !== s.project || cache.selection !== s.selection) cache = snapshot();
  return cache;
};

/** The API object one plugin gets. */
export function createHostApi(pluginId: string): HostApi {
  return {
    apiVersion: PLUGIN_API_VERSION,
    studioVersion: pkg.version,
    registerTopBarButton: (b) => addButton({ pluginId, ...b }),
    registerInspectorSection: (s) => addSection({ pluginId, ...s }),
    useStudio: () => useSyncExternalStore((fn) => useProject.subscribe(fn), current, current),
    getStudio: current,
    applyBeatVoice,
    sealEdit: () => useProject.getState().seal(),
    notify: (text, tone = 'info') => notify(text, tone),
    fetchPlugin: (id, path, init) => fetch(`/api/plugins/${encodeURIComponent(id)}/${path.replace(/^\//, '')}`, init),
    voice: {
      fileUrl: (projectId, file) => `/api/projects/${encodeURIComponent(projectId)}/voice/${encodeURIComponent(file)}`,
      getVolume: () => useVoicePrefs.getState().volume,
      setVolume: (v) => useVoicePrefs.getState().setVolume(v),
    },
    ui: { Modal, Section, Row } as HostApi['ui'],
  };
}
