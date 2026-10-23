/**
 * The dock: every editor pane lives in a dockview group (drag a tab to dock it left / right / above / below another panel or into a
 * tab group; drag the dividers; double-click a tab or press the corner button to maximise). This file wires the pure layout model
 * (`layoutModel.ts`) to dockview. The panel contents are the unchanged editor components; they are rendered by the Workspace
 * (`render`) so they keep reading the same state. The stage is special: its DOM host is owned by the Workspace and only
 * attached here, so the Pixi application survives every layout operation (preset, reset, closing and re-adding a group).
 */
import { useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, createContext, type ReactNode } from 'react';
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
  forgetLayout,
  isPanelId,
  loadSavedLayout,
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
  applyPreset: (id: string) => void;
  /** Back to the default preset and forget the saved layout. */
  reset: () => void;
}

interface DockCtxValue {
  render: (id: PanelId, visible: boolean) => ReactNode;
  stageHost: HTMLElement;
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

function buildPreset(api: DockviewApi, presetId: string, extra: PanelId[] = []): void {
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
}

export function Dock({ render, stageHost, agentWanted, onController, onPresent, onCenter }: {
  render: DockCtxValue['render'];
  stageHost: HTMLElement;
  /** Open the assistant in a layout that is built from scratch (the remembered "assistant open" flag). */
  agentWanted: boolean;
  onController: (c: DockController) => void;
  onPresent: (present: ReadonlySet<PanelId>) => void;
  /** The stage / storyboard tab that is now the visible one. */
  onCenter: (id: 'stage' | 'storyboard') => void;
}) {
  const live = useRef({ onController, onPresent, onCenter, agentWanted });
  useEffect(() => {
    live.current = { onController, onPresent, onCenter, agentWanted };
  });
  const onReady = ({ api }: DockviewReadyEvent) => {
    let restoring = true;
    const saved = loadSavedLayout();
    let ok = false;
    if (saved) {
      try {
        api.fromJSON(saved as unknown as Parameters<DockviewApi['fromJSON']>[0]);
        ok = true;
      } catch {
        ok = false; // dockview rejected it: start from the default
      }
    }
    if (!ok) buildPreset(api, 'default', live.current.agentWanted ? ['agent'] : []);
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
      applyPreset: (id) => {
        const hadAgent = has('agent');
        restoring = true;
        try {
          // an assistant that is open stays open, wherever the preset puts the other panels
          buildPreset(api, id, hadAgent && !presetById(id).placements.some((p) => p.id === 'agent') ? ['agent'] : []);
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
    <DockCtx.Provider value={{ render, stageHost }}>
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
