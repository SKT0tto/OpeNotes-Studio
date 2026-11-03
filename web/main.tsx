import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadPlugins } from './plugins/loadPlugins';
import './styles/tokens.css';
import './styles.css';
import './editor/editor.css';
import './editor/studio.css';
import './editor/dock/dock.css';
import './setup/setup.css';
import './editor/bg/bg.css';
import './play/play.css';

void loadPlugins(); // optional add-ons from plugins/: they register their buttons and panels when ready

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
