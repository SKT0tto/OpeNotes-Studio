/**
 * The dock: every editor pane lives in a dockview group (drag a tab to dock it left / right / above / below another panel or into a
 * tab group; drag the dividers; double-click a tab or press the corner button to maximise). This file wires the pure layout model
 * (`layoutModel.ts`) to dockview. The panel contents are the unchanged editor components; they are rendered by the Workspace
 * (`render`) so they keep reading the same state. The stage is special: its DOM host is owned by the Workspace and only
 * attached here, so the Pixi application survives every layout operation (preset, reset, closing and re-adding a group).
 */
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, createContext, type ReactNode } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewPanelApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import {
  LAYOUT_KEY,
  PANEL_IDS,
  PANEL_MIN,
  PANEL_TITLE,
  REQUIRED,
  SHOW_PLACEMENT,
  aiRestorePlacement,
  forgetLayout,
  isPanelId,
  loadMigratedLayout,
  presetById,
  resolvePlacement,
  saveLayout,
  type PanelId,
  type Placement,
} from './layoutModel';

export interface DockController {
  api: DockviewApi;
  has: (id: PanelId) => boolean;
  show: (id: PanelId) => void;
  hide: (id: PanelId) => void;
  toggle: (id: PanelId) => void;
  activate: (id: PanelId) => void;
  /** Bring the previously front tab of this panel's group to the front, without closing the panel or changing the layout. False when the panel is alone in its group. */
  back: (id: PanelId) => boolean;
  applyPreset: (id: string) => void;
  /** Back to the default preset and forget the saved layout. */
  reset: () => void;
}

interface DockCtxValue {
  render: (id: PanelId, visible: boolean) => ReactNode;
  stageHost: HTMLElement;
  /** A panel became the visible tab of its group (true) or stopped being rendered / visible (false). */
  onVisible: (id: PanelId, visible: boolean) => void;
}
const DockCtx = createContext<DockCtxValue | null>(null);

function usePanelVisible(api: DockviewPanelApi): boolean {
  return useSyncExternalStore(
    (cb) => {
      const d = api.onDidVisibilityChange(cb);
      return () => d.dispose();
    },
    () => api.isVisible,
  );
}

function DockPanel({ api }: IDockviewPanelProps) {
  const ctx = useContext(DockCtx)!;
  const id = api.id as PanelId;
  const visible = usePanelVisible(api);
  const holder = useRef<HTMLDivElement>(null);
  // the workspace needs to know whether a panel is on screen (not just present): the 「AI」 button activates a panel hidden behind another tab
  const { onVisible } = ctx;
  useEffect(() => {
    onVisible(id, visible);
    return () => onVisible(id, false);
  }, [onVisible, id, visible]);
  useLayoutEffect(() => {
    if (id !== 'stage') return;
    const el = holder.current!;
    el.appendChild(ctx.stageHost);
  }, [id, ctx.stageHost]);
  if (id === 'stage') return <div ref={holder} className="dock-fill ws-center" data-testid="stage-dock" />;
  return <div className="dock-fill">{ctx.render(id, visible)}</div>;
}

function DockTab({ api, containerApi }: IDockviewPanelHeaderProps) {
  const id = api.id as PanelId;
  const closable = !REQUIRED.includes(id);
  return (
    <div
      className="dock-tab"
      data-testid={`dock-tab-${id}`}
      title="拖动标签可停靠到其他面板的四周或并入标签组；双击最大化"
      onDoubleClick={() => {
        const g = api.group;
        if (g.api.isMaximized()) g.api.exitMaximized();
        else if (containerApi.groups.length > 1) g.api.maximize();
      }}
    >
      <span className="dock-tab-title">{api.title ?? PANEL_TITLE[id]}</span>
      {closable && (
        <button
          className="dock-tab-x"
          aria-label={`关闭${PANEL_TITLE[id]}`}
          title="关闭（可在“布局”菜单里重新打开）"
          data-testid={id === 'agent' ? 'agent-close' : `dock-close-${id}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            api.close();
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function GroupActions({ api, containerApi, activePanel }: IDockviewHeaderActionsProps) {
  const max = useSyncExternalStore(
    (cb) => {
      const d = containerApi.onDidMaximizedGroupChange(cb);
      return () => d.dispose();
    },
    () => api.isMaximized(),
  );
  const id = activePanel?.id ?? 'group';
  return (
    <div className="dock-actions">
      <button
        className="dock-act"
        aria-pressed={max}
        data-testid={`dock-max-${id}`}
        title={max ? '还原（双击标签也可以）' : '最大化这个面板（临时）'}
        aria-label={max ? '还原面板' : '最大化面板'}
        onClick={() => (max ? api.exitMaximized() : api.maximize())}
      >
        {max ? '❐' : '▢'}
      </button>
    </div>
  );
}

// Module-level constants: dockview-react re-applies options whenever these props change identity, which must not happen on every workspace render.
const COMPONENTS = Object.fromEntries(PANEL_IDS.map((id) => [id, DockPanel]));
const TAB_COMPONENTS = { tab: DockTab };

function presentOf(api: DockviewApi): Set<PanelId> {
  return new Set(api.panels.map((p) => p.id).filter(isPanelId));
}

function addPlacement(api: DockviewApi, p: Placement, present: ReadonlySet<PanelId>, activate: boolean): void {
  const target = resolvePlacement(p, present);
  const min = PANEL_MIN[p.id];
  const base = {
    id: p.id,
    component: p.id,
    tabComponent: 'tab',
    title: PANEL_TITLE[p.id],
    // the stage keeps its (hidden) DOM and size behind a sibling tab, as the old "behind" preview did
    renderer: p.id === 'stage' ? ('always' as const) : ('onlyWhenVisible' as const),
    minimumWidth: min.w,
    minimumHeight: min.h,
    ...(p.w ? { initialWidth: p.w } : {}),
    ...(p.h ? { initialHeight: p.h } : {}),
    ...(p.inactive && !activate ? { inactive: true } : {}),
  };
  if (target.kind === 'first') api.addPanel(base);
  else if (target.kind === 'edge') api.addPanel({ ...base, position: { direction: target.dir } } as Parameters<DockviewApi['addPanel']>[0]);
  else api.addPanel({ ...base, position: { referencePanel: target.ref, direction: target.dir } } as Parameters<DockviewApi['addPanel']>[0]);
}

function buildPreset(api: DockviewApi, presetId: string, extra: PanelId[] = [], showAgent = false): void {
  api.clear();
  const present = new Set<PanelId>();
  const preset = presetById(presetId);
  for (const p of preset.placements) {
    addPlacement(api, p, present, false);
    present.add(p.id);
  }
  for (const id of extra) {
    if (present.has(id)) continue;
    addPlacement(api, SHOW_PLACEMENT[id], present, true);
    present.add(id);
  }
  // the stage is the tab shown in its group, unless the preset made the storyboard the main view
  api.getPanel(presetId === 'storyboard' ? 'storyboard' : 'stage')?.api.setActive();
  // the AI panel was open before (the remembered flag): bring its tab to the front of its group
  if (showAgent) api.getPanel('agent')?.api.setActive();
}

export function Dock({ render, stageHost, agentWanted, onController, onPresent, onVisible, onCenter }: {
  render: DockCtxValue['render'];
  stageHost: HTMLElement;
  /** Show the AI panel in a layout that is built from scratch (the remembered "AI panel open" flag). */
  agentWanted: boolean;
  onController: (c: DockController) => void;
  onPresent: (present: ReadonlySet<PanelId>) => void;
  onVisible: DockCtxValue['onVisible'];
  /** The stage / storyboard tab that is now the visible one. */
  onCenter: (id: 'stage' | 'storyboard') => void;
}) {
  const live = useRef({ onController, onPresent, onCenter, agentWanted });
  useEffect(() => {
    live.current = { onController, onPresent, onCenter, agentWanted };
  });
  const ctxValue = useMemo<DockCtxValue>(() => ({ render, stageHost, onVisible }), [render, stageHost, onVisible]);
  const onReady = ({ api }: DockviewReadyEvent) => {
    let restoring = true;
    const saved = loadMigratedLayout();
    let ok = false;
    if (saved) {
      try {
        api.fromJSON(saved.layout as unknown as Parameters<DockviewApi['fromJSON']>[0]);
        ok = true;
        // a layout saved before the AI director became part of the AI panel: the panel is added back (a background tab), and the titles are refreshed
        if (saved.needsAiPanel && !api.getPanel('agent')) addPlacement(api, aiRestorePlacement(presentOf(api)), presentOf(api), false);
        for (const p of api.panels) if (isPanelId(p.id) && p.title !== PANEL_TITLE[p.id]) p.api.setTitle(PANEL_TITLE[p.id]);
      } catch {
        ok = false; // dockview rejected it: start from the default
      }
    }
    if (!ok) buildPreset(api, 'default', [], live.current.agentWanted);
    restoring = false;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          saveLayout(api.toJSON());
        } catch {
          /* not remembered */
        }
      }, 250);
    };
    // the tabs that were in front before, newest first (for `back`: the 「AI」 button returns to the previous tab of the group)
    let recent: string[] = [];
    // the add / remove events fire before dockview updates its own list, so the set is kept from the events themselves
    let cur = presentOf(api);
    const emitPresent = () => live.current.onPresent(new Set(cur));
    const recompute = () => {
      cur = presentOf(api);
      emitPresent();
    };
    // dockview disposes its own events with the instance (and keeps the instance across React strict-mode replays), so nothing is torn down here
    void [
      api.onDidLayoutChange(() => {
        if (!restoring) persist();
      }),
      api.onDidAddPanel((p) => {
        if (isPanelId(p.id)) cur.add(p.id);
        emitPresent();
      }),
      api.onDidRemovePanel((p) => {
        cur.delete(p.id as PanelId);
        emitPresent();
      }),
      api.onDidLayoutFromJSON(recompute),
      api.onDidActivePanelChange((e) => {
        const id = e.panel?.id;
        if (id) recent = [id, ...recent.filter((x) => x !== id)].slice(0, 12);
        if (id === 'stage' || id === 'storyboard') live.current.onCenter(id);
      }),
    ];
    const has = (id: PanelId) => !!api.getPanel(id);
    const controller: DockController = {
      api,
      has,
      show: (id) => {
        const existing = api.getPanel(id);
        if (existing) {
          existing.api.setActive();
          return;
        }
        addPlacement(api, SHOW_PLACEMENT[id], presentOf(api), true);
      },
      hide: (id) => {
        if (REQUIRED.includes(id)) return;
        api.getPanel(id)?.api.close();
      },
      toggle: (id) => (has(id) ? controller.hide(id) : controller.show(id)),
      activate: (id) => api.getPanel(id)?.api.setActive(),
      back: (id) => {
        const panel = api.getPanel(id);
        const mates = panel?.group.panels.filter((p) => p.id !== id) ?? [];
        const target = recent.map((x) => mates.find((p) => p.id === x)).find(Boolean) ?? mates[0];
        if (!target) return false;
        target.api.setActive();
        return true;
      },
      applyPreset: (id) => {
        restoring = true;
        try {
          buildPreset(api, id); // every preset has the AI panel (the 「AI 工作」 one in front, the others behind the inspector's tab)
        } finally {
          restoring = false;
        }
        recompute();
        persist();
      },
      reset: () => {
        forgetLayout();
        controller.applyPreset('default');
      },
    };
    live.current.onController(controller);
    recompute();
    persist();
  };

  return (
    <DockCtx.Provider value={ctxValue}>
      <div className="dock-root" data-testid="dock-root" data-layout-key={LAYOUT_KEY}>
        <DockviewReact
          components={COMPONENTS}
          tabComponents={TAB_COMPONENTS}
          defaultTabComponent={DockTab}
          rightHeaderActionsComponent={GroupActions}
          theme={themeDark}
          disableFloatingGroups
          onReady={onReady}
        />
      </div>
    </DockCtx.Provider>
  );
}
