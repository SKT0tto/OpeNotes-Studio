/** OpeNotes Studio editor entry: the project hub (new / open / import) and, once a project is open, the workspace. */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { blankProject, newProjectId } from '@shared/project/blank';
import { ProjectSchema } from '@shared/schema/project';
import demoJson from '../../tests/fixtures/demo-project.json';
import type { Health } from '../api';
import { fetchLlmSettings } from '../llmApi';
import type { PublicLlmSettings } from '@shared/schema/settings';
import { createProject, deleteProject, listProjects, loadProject, type ProjectSummary } from '../projectsApi';
import { useProject } from '../store/projectStore';
import { ImportDialog } from './dialogs/ImportDialog';
import { AiBreakdownDialog } from './dialogs/AiBreakdownDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { SetupWizard, useCoreProbe } from '../setup/SetupWizard';
import { Workspace } from './Workspace';
import { useCatalog } from './useCatalog';
import { HubCharacter, HubCharacterMenu, HubModelPicker, useHubCharacterPrefs } from './HubCharacter';
import { DEFAULT_PLACEMENT, resolveHubModel } from './hubCharacterLogic';

const when = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false });
const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  if (m < 60 * 24 * 30) return `${Math.round(m / 60 / 24)} 天前`;
  return when(t).slice(0, 10);
};
/** A stable hue per project id, for the generated cover of projects without a background. */
const hue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
/** Small line icon (24×24 path); `fill` for solid glyphs. */
const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

function useMedia(query: string): boolean {
  const [hit, setHit] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setHit(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return hit;
}

/** Up / Down move focus between the title-menu entries (game-menu style). */
const menuKeys = (e: ReactKeyboardEvent<HTMLElement>) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)')];
  const i = items.findIndex((x) => x === document.activeElement || x.contains(document.activeElement));
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  if (!next) return;
  e.preventDefault();
  (next.matches('button') ? next : next.querySelector<HTMLElement>('button') ?? next).focus();
};

export function EditorApp({ health, onHealthChanged }: { health: Health; onHealthChanged: () => void }) {
  const project = useProject((s) => s.project);
  const catalog = useCatalog();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [imp, setImp] = useState<{ text: string; name: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wizard, setWizard] = useState<number | null>(null);
  const coreProbe = useCoreProbe(health.cubismCoreUrl);
  const [aiOpen, setAiOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [manage, setManage] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const [llm, setLlm] = useState<PublicLlmSettings | null | undefined>(undefined);
  const [allOpen, setAllOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [seed] = useState(() => Math.random());
  const wide = useMedia('(min-width: 721px)');
  const [charPrefs, setCharPrefs] = useHubCharacterPrefs();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  useEffect(() => {
    if (!allOpen && !envOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-back')) return;
      setAllOpen(false);
      setEnvOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allOpen, envOpen]);

  const refresh = useCallback(() => listProjects().then(setList, (e: Error) => setError(e.message)), []);

  const openById = useCallback(async (id: string) => {
    try {
      const r = await loadProject(id);
      useProject.getState().open(r.project, r.etag);
      history.replaceState(null, '', `/editor/${encodeURIComponent(id)}`);
    } catch (e) {
      setError((e as Error).message);
      history.replaceState(null, '', '/');
    }
  }, []);

  // Loading the list (and a project named in the URL) on mount is data fetching, not derived state.
  useEffect(() => {
    void refresh();
    fetchLlmSettings().then(setLlm, () => setLlm(null));
    const m = /^\/editor\/([^/]+)$/.exec(location.pathname);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (m && !useProject.getState().project) void openById(decodeURIComponent(m[1]!));
  }, [refresh, openById]);

  const exit = () => {
    const st = useProject.getState();
    if (st.saveState !== 'saved' && !confirm('有未保存的更改，仍要离开吗？')) return;
    st.close();
    history.replaceState(null, '', '/');
    void refresh();
  };

  const make = async (p: ReturnType<typeof blankProject>) => {
    try {
      const r = await createProject(p);
      useProject.getState().open(r.project, r.etag);
      history.replaceState(null, '', `/editor/${r.project.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (project) return <Workspace health={health} onExit={exit} />;

  const bgUrl = (id: string | null) => (id ? catalog?.backgrounds.find((x) => x.id === id)?.url : undefined);
  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((p) => !q || p.title.toLowerCase().includes(q));
  const removeMany = async (ids: string[]) => {
    if (ids.length === 0 || !confirm(ids.length === 1 ? `删除项目 “${list?.find((p) => p.id === ids[0])?.title ?? ids[0]}”？此操作不可撤销。` : `删除选中的 ${ids.length} 个项目？此操作不可撤销。`)) return;
    for (const id of ids) {
      try {
        await deleteProject(id);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    setPicked(new Set());
    setManage(false);
    void refresh();
  };
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const recentCover = bgUrl([...(list ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).find((p) => p.coverBackground)?.coverBackground ?? null);
  const coreLocal = !health.cubismCoreUrl.startsWith('https://cubism.live2d.com/');
  type Check = { key: string; ok: boolean | null; label: string; detail: string; action?: { text: string; run: () => void } };
  const assetsEmpty = health.assetRoot.ok && health.assetRoot.models === 0;
  const checks: Check[] = [
    health.assetRoot.ok
      ? {
          key: 'assets', ok: !assetsEmpty, label: '素材库',
          detail: assetsEmpty ? '素材库是空的：导入你已有的素材文件夹或 zip 即可。' : `${health.assetRoot.models} 个模型 / ${health.assetRoot.backgrounds} 张背景`,
          action: { text: assetsEmpty ? '导入素材' : '导入更多素材', run: () => setWizard(1) },
        }
      : { key: 'assets', ok: false, label: '素材库', detail: '未找到素材库。点“导入素材”选择你已有的素材文件夹或 zip；也可以在 .env 设置 ASSET_ROOT。', action: { text: '导入素材', run: () => setWizard(1) } },
    coreProbe.state === 'checking'
      ? { key: 'core', ok: null, label: 'Cubism Core', detail: '检查中…' }
      : coreProbe.state === 'ok'
        ? { key: 'core', ok: true, label: 'Cubism Core', detail: `${coreLocal ? '使用本地副本（vendor/）' : '使用 Live2D 官方地址（需联网）'} · moc3 v${coreProbe.mocVersion}`, action: { text: '管理 Core', run: () => setWizard(0) } }
        : { key: 'core', ok: false, label: 'Cubism Core', detail: coreProbe.message, action: { text: '获取 Core', run: () => setWizard(0) } },
    llm === undefined
      ? { key: 'ai', ok: null, label: 'AI 导演', detail: '检查中…' }
      : llm?.status.configured
        ? { key: 'ai', ok: true, label: 'AI 导演', detail: `${llm.status.provider === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${llm.status.model ?? ''}` }
        : { key: 'ai', ok: false, label: 'AI 导演', detail: 'AI 未配置：填入你自己的 API key 或本地 LM Studio 地址即可启用；未配置时仍可使用“规则生成（非 AI）”。', action: { text: '打开 AI 设置', run: () => setSettingsOpen(true) } },
  ];

  const ready = checks.filter((c) => c.ok === true).length;
  const pending = checks.some((c) => c.ok === null);
  const recent = [...(list ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const last = recent[0] ?? null;
  const scenes = catalog?.backgrounds.filter((b) => (b.labels?.category ?? b.category) === 'scene') ?? [];
  const stageBg = recentCover ?? scenes[Math.floor(seed * scenes.length)]?.url;
  const modelId = catalog ? resolveHubModel(catalog, charPrefs.model) : null;
  const covered = allOpen || aiOpen || settingsOpen || pickerOpen || wizard !== null || imp !== null;
  const placement = { x: charPrefs.x, y: charPrefs.y, scale: charPrefs.scale };
  const newBlank = () => void make(blankProject(title.trim() || '未命名项目'));

  const card = (p: ProjectSummary, strip: boolean) => {
    const cover = bgUrl(p.coverBackground);
    return (
      <span className="proj-cover" style={cover ? { backgroundImage: `url("${cover}")` } : ({ '--h': hue(p.id) } as CSSProperties)}>
        {!cover && <span className="nopreview"><Icon d="M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" />{strip ? '' : '无背景'}</span>}
        {!strip && <span className="proj-open-hint">{manage ? (picked.has(p.id) ? '已选中' : '点击选择') : '打开 →'}</span>}
      </span>
    );
  };

  return (
    <div className={`hub${allOpen ? ' all-open' : ''}`} data-testid="hub">
      <div className="stage-bg" style={stageBg ? { backgroundImage: `url("${stageBg}")` } : undefined} aria-hidden="true" />
      <div className="stage-shade" aria-hidden="true" />
      {wide && (
        <HubCharacter
          health={health}
          modelId={modelId}
          placement={placement}
          onPlacement={(p) => setCharPrefs({ ...charPrefs, ...p })}
          onPick={() => { setAdjusting(false); setPickerOpen(true); }}
          paused={covered}
          adjusting={adjusting && !covered && charPrefs.model !== null}
          onAdjust={setAdjusting}
        />
      )}

      <main className="title-screen">
        <section className="title-menu" aria-label="开始">
          <header className="wordmark">
            <svg className="hub-logo" viewBox="0 0 48 48" aria-hidden="true">
              <defs><linearGradient id="hl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5b8cff" /><stop offset="1" stopColor="#b48cff" /></linearGradient></defs>
              <rect width="48" height="48" rx="12" fill="url(#hl)" />
              <path d="M18 33V15l14-3v18" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="14.5" cy="33" r="3.5" fill="#fff" /><circle cx="28.5" cy="30" r="3.5" fill="#fff" />
            </svg>
            <div className="hub-title">
              <h1>OpeNotes Studio</h1>
              <p className="tagline">Live2D 剧情演出工作室 <span className="ver-pill">v{health.version}</span></p>
            </div>
          </header>
          <p className="lede">把小说变成《BanG Dream! Our Notes》风格的演出：AI 分场、选背景与服装、写镜头与表演，再在编辑器里逐句打磨。</p>

          <nav className="menu" aria-label="主菜单" onKeyDown={menuKeys}>
            <button className="menu-item primary" onClick={() => setAiOpen(true)} data-testid="btn-ai-breakdown" title="粘贴或打开 .txt / .md 小说，自动分场并导演整部作品。支持 UTF-8 / GBK 编码，可随时取消与续跑。">
              <Icon d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8L12 3Zm6.5 10 .9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z" fill />
              <span className="mi-text"><strong>导入小说开始</strong><small>粘贴或打开小说，AI 一键分场、导演整部作品</small></span>
            </button>
            {last && (
              <button className="menu-item" onClick={() => void openById(last.id)} data-testid="hub-continue" title={`${last.title} · ${when(last.updatedAt)}`}>
                <Icon d="M8 5.5v13l10.5-6.5L8 5.5Z" fill />
                <span className="mi-text"><strong>继续：<span className="mi-name">{last.title}</span></strong><small>{ago(last.updatedAt)}更新</small></span>
              </button>
            )}
            <div className="menu-item has-field">
              <button className="mi-btn" onClick={newBlank} data-testid="btn-new">
                <Icon d="M12 5v14M5 12h14" />
                <span className="mi-text"><strong>新建空白项目</strong></span>
              </button>
              <input className="text mi-field" placeholder="项目标题（可留空）" aria-label="新项目标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') newBlank(); }} data-testid="new-title" />
            </div>
            <button
              className="menu-item"
              data-testid="btn-from-demo"
              onClick={() => {
                const demo = ProjectSchema.parse(demoJson);
                void make({ ...demo, id: newProjectId(), title: title.trim() || '示例演出', createdAt: Date.now(), updatedAt: Date.now() });
              }}
            >
              <Icon d="M4 6.5h16M4 12h16M4 17.5h10" />
              <span className="mi-text"><strong>打开示例</strong><small>从一个现成的演出开始，边看边学</small></span>
            </button>
            <button className="menu-item" onClick={() => fileInput.current?.click()} disabled={!catalog} data-testid="btn-import">
              <Icon d="M12 15V4m-4.5 4.5L12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />
              <span className="mi-text"><strong>导入项目文件…</strong><small>打开别人分享的 .openotes.json（兼容旧版 .ournotes.json）</small></span>
            </button>
            <div className="menu-row">
              <button className="menu-item small" onClick={() => setSettingsOpen(true)} data-testid="btn-settings">
                <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />
                <span className="mi-text"><strong>AI 设置</strong></span>
              </button>
              <button className="menu-item small" onClick={() => setWizard(0)} data-testid="btn-wizard">
                <Icon d="M5 19 19 5m-4 0h4v4M7 3v3M3 7h3m11 10v3m-3-3h3" />
                <span className="mi-text"><strong>配置向导</strong></span>
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              data-testid="import-file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) setImp({ text: await f.text(), name: f.name });
              }}
            />
          </nav>

          {list && list.length === 0 && (
            <div className="first-steps" data-testid="hub-empty">
              <strong>还没有项目 · 第一次使用？</strong>
              <ol className="steps">
                <li>点“打开示例”，先看一遍成品是怎么演的。</li>
                <li>配好 AI（或用规则生成），导入一篇小说一键成片。</li>
                <li>在编辑器里逐句调整镜头、表情与音乐，导出分享。</li>
              </ol>
            </div>
          )}
        </section>

        {recent.length > 0 && (
          <section className="recent-strip" aria-label="最近的项目">
            <h2>最近的项目</h2>
            <ul>
              {recent.slice(0, 5).map((p, i) => (
                <li key={p.id} className={i === 4 ? 'r5' : undefined}>
                  <button className="strip-card" onClick={() => void openById(p.id)} data-testid="recent-item" data-recent-id={p.id} title={`${p.title} · ${p.scenes} 场景 · ${when(p.updatedAt)}`}>
                    {card(p, true)}
                    <span className="strip-meta"><strong>{p.title}</strong><small>{ago(p.updatedAt)} · {p.scenes} 场景</small></span>
                  </button>
                </li>
              ))}
              <li>
                <button className="strip-card all" onClick={() => setAllOpen(true)} data-testid="hub-all">
                  <span className="all-icon"><Icon d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></span>
                  <span className="strip-meta"><strong>全部项目</strong><small>{list?.length ?? 0} 个 · 搜索与管理</small></span>
                </button>
              </li>
            </ul>
          </section>
        )}
      </main>

      <div className="corner-tr">
        {error && <p className="bad hub-msg" data-testid="hub-error">{error}</p>}
        {note && <p className="ok hub-msg">{note}</p>}
        <div className="corner-row">
        {wide && catalog && (
          <HubCharacterMenu
            hidden={charPrefs.model === null}
            onPick={() => { setAdjusting(false); setPickerOpen(true); }}
            onAdjust={() => setAdjusting(true)}
            onReset={() => setCharPrefs({ ...charPrefs, ...DEFAULT_PLACEMENT })}
            onToggle={() => setCharPrefs({ ...charPrefs, model: charPrefs.model === null ? undefined : null })}
          />
        )}
        <button className={`env-pill ${pending ? '' : ready === checks.length ? 'ok' : 'warn'}`} onClick={() => setEnvOpen(!envOpen)} aria-expanded={envOpen} aria-controls="hub-env" data-testid="env-pill">
          <span className="env-dot" aria-hidden="true" />
          {pending ? '环境检查中…' : ready === checks.length ? '环境就绪' : `${checks.length - ready} 项待配置`}
        </button>
        </div>
        <section id="hub-env" className="env-pop" data-testid="env-check" hidden={!envOpen} aria-label="环境检查">
          <h3>环境检查</h3>
          <ul className="env-list">
            {checks.map((c) => (
              <li key={c.key} data-testid={`env-${c.key}`} className={c.ok === null ? '' : c.ok ? 'ok' : 'warn'}>
                <span className="env-dot" aria-hidden="true" />
                <div>
                  <strong>{c.label}</strong>
                  <p>{c.detail}</p>
                  {c.action && <button className="btn" onClick={c.action.run} data-testid={`env-${c.key}-action`}>{c.action.text}</button>}
                </div>
              </li>
            ))}
          </ul>
          <nav className="links" aria-label="工具">
            <a href="/assets">素材浏览器</a><a href="/play/demo">播放示例</a><a href="/lab/actor">Actor Lab</a><a href="/lab/stage">Stage Lab</a>
          </nav>
        </section>
      </div>

      <footer className="hub-foot">
        <span>作者 <a href="https://space.bilibili.com/358479834" target="_blank" rel="noreferrer noopener" data-testid="author-link">bilibili @羽丘魅魔高松灯</a> · 非官方同人项目 · GPL-3.0</span>
        <span>与 Bushiroad / Craft Egg 无关；本仓库不含任何游戏素材与 Live2D Cubism Core。项目保存在服务端 data/projects；导出文件只含项目数据与素材 ID。</span>
      </footer>

      {allOpen && (
        <div className="all-panel-back" onMouseDown={(e) => e.target === e.currentTarget && setAllOpen(false)}>
          <section className="all-panel" role="dialog" aria-modal="true" aria-label="全部项目" data-testid="hub-all-panel">
            <div className="hub-bar">
              <h2>全部项目{list ? <span className="count">{list.length}</span> : null}</h2>
              {list && list.length > 0 && (
                <>
                  <label className="hub-search">
                    <Icon d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.7-1.8L20 20" />
                    <input className="text" type="search" placeholder="搜索项目" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="hub-search" autoFocus />
                  </label>
                  <button className={`btn${manage ? ' toggle on' : ''}`} onClick={() => { setManage(!manage); setPicked(new Set()); }} data-testid="hub-manage">{manage ? '完成' : '批量管理'}</button>
                  {manage && <button className="btn danger" disabled={picked.size === 0} onClick={() => void removeMany([...picked])} data-testid="hub-delete-picked">删除选中（{picked.size}）</button>}
                </>
              )}
              <button className="btn close" onClick={() => setAllOpen(false)} aria-label="关闭" data-testid="hub-all-close">
                <Icon d="M6 6l12 12M18 6 6 18" />
              </button>
            </div>
            <div className="all-scroll">
              {list === null ? (
                <ul className="proj-grid skeleton" aria-busy="true" aria-label="读取中…">
                  {[0, 1, 2].map((i) => <li key={i}><span className="sk-cover" /><span className="sk-line" /><span className="sk-line short" /></li>)}
                </ul>
              ) : list.length === 0 ? (
                <p className="hint hub-nomatch">还没有项目。</p>
              ) : shown.length === 0 ? (
                <p className="hint hub-nomatch" data-testid="hub-no-match">没有名字包含“{query}”的项目。</p>
              ) : (
                <ul className="proj-grid" data-testid="project-list">
                  {shown.map((p) => (
                    <li key={p.id} data-testid="project-item" data-project-id={p.id} className={picked.has(p.id) ? 'picked' : ''}>
                      <button className="proj-card" onClick={() => (manage ? toggle(p.id) : void openById(p.id))}>
                        {card(p, false)}
                        <span className="proj-body">
                          <strong className="proj-name" title={p.title}>{p.title}</strong>
                          <span className="proj-stats">
                            <span>{p.scenes} 场景</span><span>{p.beats} 句</span><span>{p.cast} 角色</span>
                          </span>
                          <span className="proj-time" title={when(p.updatedAt)}>
                            <Icon d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4.5l3 1.8" />{ago(p.updatedAt)}更新
                          </span>
                        </span>
                      </button>
                      {manage && <input type="checkbox" className="proj-pick" checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`选择 ${p.title}`} />}
                      <button className="btn danger proj-del" onClick={() => void removeMany([p.id])} data-testid="btn-delete" title={`删除 ${p.id}`}>删除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
      {pickerOpen && catalog && (
        <HubModelPicker
          catalog={catalog}
          current={charPrefs.model}
          onPick={(model) => { setCharPrefs({ ...charPrefs, model }); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {aiOpen && <AiBreakdownDialog catalog={catalog} onClose={() => setAiOpen(false)} onCreated={(id) => { setAiOpen(false); history.replaceState(null, '', `/editor/${id}`); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {wizard !== null && <SetupWizard health={health} initialStep={wizard} onChanged={onHealthChanged} onClose={() => setWizard(null)} />}
      {imp && catalog && (
        <ImportDialog
          text={imp.text}
          fileName={imp.name}
          catalog={catalog}
          onClose={() => setImp(null)}
          onDone={(p, etag, msg) => {
            setImp(null);
            setNote(msg);
            useProject.getState().open(p, etag);
            history.replaceState(null, '', `/editor/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
