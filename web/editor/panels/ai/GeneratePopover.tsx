/**
 * 「生成 ▾」: the compact options of a generation (what to generate, which part, which engine, preview / overwrite / memory). The values live in
 * `useDirectorRun().controls`, not in a section of the panel; the 「生成」 button runs the request (`generateActions.ts`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SCOPE_LABEL, SCOPE_NAMES, type ScopeName } from '@shared/director/scope';
import { useProject } from '../../../store/projectStore';
import { useUi } from '../../../store/uiStore';
import { isDirectedScene, usesRule, useDirectorRun, type DirectorEnv, type Engine } from '../directorRun';
import { DirectorMemoryLine } from '../MemoryPanel';
import { useAiSettings } from './aiSettings';
import { beatTarget, missingScenes, startGenerate } from './generateActions';

export function GeneratePopover({ env, onClose, onOpenSettings }: { env: DirectorEnv; onClose: () => void; onOpenSettings: () => void }) {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const picked = useUi((s) => s.cards);
  const d = useDirectorRun();
  const settings = useAiSettings((s) => s.settings);
  // generation waits for the AI settings (it must know whether an AI is configured) and does not start when they could not be read
  const settingsReady = useAiSettings((s) => !s.loading && !s.error);
  const { engine, scope, target, onlyBeat, overwriteUser, preview, useMem } = d.controls;
  const ref = useRef<HTMLDivElement>(null);
  // The popover opens upward from the composer: its height is what is left between the top of the panel (the part of it that is on screen)
  // and the composer, so it always fits and scrolls inside itself.
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const host = ref.current?.offsetParent as HTMLElement | null;
    const panel = host?.closest<HTMLElement>('.ai-panel-root') ?? host?.parentElement;
    if (!host || !panel) return;
    const measure = () => {
      const top = Math.max(panel.getBoundingClientRect().top, 0);
      setRoom(Math.max(96, Math.floor(host.getBoundingClientRect().top - top - 8)));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(panel);
    ro?.observe(host);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, []);
  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? project.scenes[0];
  const beats = beatTarget(project, selection, picked);
  const missing = missingScenes(project);
  const useRule = usesRule(engine, env.configured);
  const hasText = !!project.source.text;
  const canGenerate = settingsReady && !d.busy && hasText && project.scenes.length > 0 && (target !== 'missing' || missing.length > 0) && (target !== 'scene' || !!scene) && (!onlyBeat || target !== 'scene' || beats !== null);
  const regen = !!scene && isDirectedScene(scene);
  const which = target === 'all' ? 'all' : target === 'missing' ? 'missing' : onlyBeat ? 'beats' : 'scene';
  const pick = (w: 'scene' | 'beats' | 'all' | 'missing') => d.setControls({ target: w === 'all' || w === 'missing' ? w : 'scene', onlyBeat: w === 'beats' });

  // Esc and a click outside close it (the 「生成 ▾」 button itself toggles it)
  useEffect(() => {
    // (capture phase, like the dialogs: the workspace's own Esc shortcut must not also clear the selection)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target as HTMLElement | null;
      if (el && t && !el.contains(t) && !t.closest('[data-testid="ai-gen-chip"]')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const run = (refresh: boolean) => {
    void startGenerate(project, selection, picked, env, refresh);
    onClose();
  };
  const verb = which === 'scene' || which === 'beats' ? (regen ? '重新生成' : '生成') : '生成';
  const runLabel = which === 'all' ? '生成全部场景' : which === 'missing' ? `生成 ${missing.length} 个场景` : which === 'beats' ? '重做选中的句子' : `${verb}这一场`;
  const runTestId = which === 'all' ? 'ai-gen-all' : 'ai-regen-scene';

  return (
    <div className="ai-pop" ref={ref} role="dialog" aria-label="生成" data-testid="ai-gen-popover" style={room === null ? undefined : { maxHeight: room }}>
      <div className="ai-pop-title">生成</div>
      {!hasText && <p className="hint" data-testid="ai-no-source">这个项目没有原文（不是由小说创建的），不能生成。请在项目列表里用「导入小说开始」创建项目。</p>}
      <div className="ai-pop-targets" role="radiogroup" aria-label="生成什么">
        <label className="chk" data-testid="ai-gen-target-scene"><input type="radio" name="ai-target" checked={which === 'scene'} onChange={() => pick('scene')} /> 这一场 <span className="hint">{scene ? `第${project.scenes.indexOf(scene) + 1}场「${scene.title}」` : '—'}</span></label>
        <label className={`chk${beats ? '' : ' off'}`} data-testid="ai-gen-target-beats"><input type="radio" name="ai-target" checked={which === 'beats'} disabled={!beats} onChange={() => pick('beats')} data-testid="ai-only-beat" /> 选中的句子 <span className="hint">{beats ? `${beats.beatIds.length} 句` : '没有选中句子'}</span></label>
        <label className="chk" data-testid="ai-gen-target-all"><input type="radio" name="ai-target" checked={which === 'all'} onChange={() => pick('all')} /> 全部场景 <span className="hint">{project.scenes.length}</span></label>
        <label className={`chk${missing.length > 0 ? '' : ' off'}`} data-testid="ai-gen-target-missing"><input type="radio" name="ai-target" checked={which === 'missing'} disabled={missing.length === 0} onChange={() => pick('missing')} /> 还没生成的场景 <span className="hint">{missing.length}</span></label>
      </div>
      <div className="ai-pop-grid">
        <label className="srow"><span>内容</span>
          <select value={scope} disabled={which === 'all' || which === 'missing'} onChange={(e) => d.setControls({ scope: e.target.value as ScopeName })} data-testid="ai-scope">
            {SCOPE_NAMES.map((n) => <option key={n} value={n}>{SCOPE_LABEL[n]}</option>)}
          </select>
        </label>
        <label className="srow"><span>引擎</span>
          <select value={useRule ? 'rule' : 'ai'} onChange={(e) => d.setControls({ engine: e.target.value as Engine })} data-testid="ai-engine">
            <option value="ai" disabled={!env.configured}>AI 模型{env.configured ? '' : '（未配置）'}</option>
            <option value="rule">规则生成（非 AI）</option>
          </select>
        </label>
      </div>
      <label className="chk"><input type="checkbox" checked={preview} onChange={(e) => d.setControls({ preview: e.target.checked })} data-testid="ai-preview" /> 先看差异再应用</label>
      <label className="chk"><input type="checkbox" checked={overwriteUser} onChange={(e) => d.setControls({ overwriteUser: e.target.checked })} data-testid="ai-overwrite" /> 覆盖我手改过的内容（锁定的永不覆盖）</label>
      {!useRule && <DirectorMemoryLine projectId={project.id} on={useMem} setOn={(on) => d.setControls({ useMem: on })} disabled={d.busy} />}
      {settings && (
        <p className={settings.status.verified === 'ok' ? 'ok' : env.configured && settings.status.verified !== 'failed' ? 'hint' : 'warn'} data-testid="ai-status">
          {settings.status.message}{' '}<button className="btn-s" onClick={onOpenSettings} data-testid="ai-open-settings">AI 设置</button>
        </p>
      )}
      {useRule && <p className="hint" data-testid="ai-rule-hint">规则生成（非 AI）：对白按引号识别、说话人按名字匹配、镜头按固定节奏，产物标注为「规则」，不是 AI。</p>}
      <div className="ai-pop-actions">
        {!useRule && <button className="btn" disabled={!canGenerate || which === 'missing'} onClick={() => run(true)} data-testid="ai-regen-fresh" title="忽略缓存，向模型重新要一个结果（会再调用一次模型）">换一版</button>}
        <span data-testid="ai-gen-run" className="ai-pop-run">
          <button className="btn primary" disabled={!canGenerate} onClick={() => run(false)} data-testid={runTestId} title={regen ? '同一场景、同一内容、输入没变时，直接用上次的结果（缓存，不再调用模型）；想要不同的结果请点「换一版」' : undefined}>{runLabel}</button>
        </span>
      </div>
    </div>
  );
}
