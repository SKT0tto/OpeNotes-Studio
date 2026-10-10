import { useCallback, useEffect, useState } from 'react';
import { fetchHealth, type Health } from './api';
import { AssetBrowser } from './editor/panels/AssetBrowser';
import { EditorApp } from './editor/EditorApp';
import { ActorLab } from './lab/ActorLab';
import { StageLab } from './lab/StageLab';
import { PlayPage } from './play/PlayPage';
import { SetupWizard } from './setup/SetupWizard';

function HealthBar({ health, error }: { health: Health | null; error: string | null }) {
  if (error) return <span className="status bad" data-testid="health">服务端不可用：{error}</span>;
  if (!health) return <span className="status" data-testid="health">检查中…</span>;
  const a = health.assetRoot;
  return a.ok ? (
    <span className="status ok" data-testid="health" title={a.path}>
      ASSET_ROOT: OK（{a.models} models / {a.backgrounds} backgrounds 目录可读）
    </span>
  ) : (
    <span className="status bad" data-testid="health" title={a.path}>
      ASSET_ROOT 不可用：{a.error}（{a.path}）
    </span>
  );
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => fetchHealth().then(setHealth, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const ready = health?.assetRoot.ok === true;
  // a first-run wizard stays up (so its import report can be read) until the user presses 完成
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => {
    if (health && setup === null) setSetup(!health.assetRoot.ok); // eslint-disable-line react-hooks/set-state-in-effect
  }, [health, setup]);
  const isEditor = location.pathname === '/' || location.pathname.startsWith('/editor');
  if (ready && health && isEditor && !setup) return <EditorApp health={health} onHealthChanged={() => void reload()} />;
  return (
    <div className="app">
      <header className="topbar">
        <h1>OpeNotes Studio</h1>
        <span className="ver">{health ? `v${health.version}` : ''}</span>
        <nav className="topnav">
          <a href="/">编辑器</a>
          <a href="/assets">素材</a>
          <a href="/lab/actor">Actor Lab</a>
          <a href="/lab/stage">Stage Lab</a>
          <a href="/play/demo">播放示例</a>
        </nav>
        <HealthBar health={health} error={error} />
      </header>
      <main className="main">
        {ready && health && location.pathname === '/lab/actor' ? (
          <ActorLab health={health} />
        ) : ready && health && location.pathname === '/lab/stage' ? (
          <StageLab health={health} />
        ) : ready && health && location.pathname.startsWith('/play/') ? (
          <PlayPage health={health} projectId={decodeURIComponent(location.pathname.slice('/play/'.length))} />
        ) : ready && !setup ? (
          <AssetBrowser />
        ) : (
          health ? <SetupWizard health={health} standalone initialStep={health.assetRoot.ok ? 0 : 1} onChanged={() => void reload()} onClose={() => setSetup(false)} /> : <p className="empty">等待服务端…</p>
        )}
      </main>
    </div>
  );
}
