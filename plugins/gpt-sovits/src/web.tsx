/** Browser side of the GPT-SoVITS plugin: `activate(host)` is called by the studio's plugin loader. */
import type { HostApi, PluginWebModule } from '../../../shared/plugins/api';
import { setHost } from './web/api';
import { VoiceDialog } from './web/Dialog';
import { VoiceSection } from './web/InspectorSection';
import { CSS } from './web/style';
import { loadSettings } from './web/store';

const plugin: PluginWebModule = {
  activate(host: HostApi) {
    setHost(host);
    if (!document.getElementById('gpt-sovits-style')) {
      const el = document.createElement('style');
      el.id = 'gpt-sovits-style';
      el.textContent = CSS;
      document.head.appendChild(el);
    }
    host.registerTopBarButton({ id: 'voice', label: '配音', title: 'GPT-SoVITS 自动配音（插件）', dialog: VoiceDialog });
    host.registerInspectorSection({ id: 'voice', component: VoiceSection });
    void loadSettings();
  },
};
export default plugin;
