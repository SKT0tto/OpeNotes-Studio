import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles.css';
import './editor/editor.css';
import './editor/studio.css';
import './editor/dock/dock.css';
import './setup/setup.css';
import './editor/bg/bg.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
