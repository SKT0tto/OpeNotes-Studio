/**
 * Style layer editor (PLAN_REVISION 3.1): the same field table for the three layers project / scene / beat.
 * A value shows the resolved number; inherited values are dim with the layer they come from, overridden ones have the
 * layer colour bar and a "back to inherited" button. Every edit lands in `layer.overrides[path]` and reaches the
 * preview through the normal project -> recompile path.
 */
import type { Draft } from 'immer';
import { PRESETS, STYLE_FIELDS, coerceStyleValue, getStylePath, resolveStyle, styleField, type StyleField, type StyleOrigin } from '@shared/style/ournotes';
import type { Project, StyleLayer } from '@shared/schema/project';
import { useState } from 'react';
import { touch, useProject } from '../../store/projectStore';
import { notify, useUi } from '../../store/uiStore';
import { NumField, Row, Section } from '../ui';

export type LayerRef = { kind: 'project' } | { kind: 'scene'; sceneId: string } | { kind: 'beat'; sceneId: string; beatId: string };

const GROUPS: Array<[string, StyleField[]]> = (() => {
  const m = new Map<string, StyleField[]>();
  for (const f of STYLE_FIELDS) (m.get(f.group) ?? m.set(f.group, []).get(f.group)!).push(f);
  return [...m];
})();

const ORIGIN_LABEL: Record<StyleOrigin, string> = { preset: '预设', project: '项目', scene: '场景', beat: '台词' };

export const layerOf = (project: Project, ref: LayerRef): StyleLayer | null => {
  if (ref.kind === 'project') return project.style;
  const scene = project.scenes.find((s) => s.id === ref.sceneId);
  if (!scene) return null;
  if (ref.kind === 'scene') return scene.style;
  return scene.beats.find((b) => b.id === ref.beatId)?.style ?? null;
};
const draftLayer = (d: Draft<Project>, ref: LayerRef): Draft<StyleLayer> | null => {
  if (ref.kind === 'project') return d.style;
  const scene = d.scenes.find((s) => s.id === ref.sceneId);
  if (!scene) return null;
  if (ref.kind === 'scene') return scene.style;
  return scene.beats.find((b) => b.id === ref.beatId)?.style ?? null;
};

export function StyleSection({ project, layer: ref, title }: { project: Project; layer: LayerRef; title: string }) {
  const { applyEdit, seal } = useProject.getState();
  const unit = useUi((st) => st.styleUnit);
  const [menu, setMenu] = useState<{ x: number; y: number; field: StyleField } | null>(null);
  const layer = layerOf(project, ref);
  const scene = ref.kind === 'project' ? null : project.scenes.find((s) => s.id === ref.sceneId) ?? null;
  const beat = ref.kind === 'beat' ? scene?.beats.find((b) => b.id === ref.beatId) ?? null : null;
  const resolved = resolveStyle(project.style, ref.kind === 'project' ? null : scene?.style, beat?.style);
  if (!layer) return null;
  const here: StyleOrigin = ref.kind;
  const count = Object.keys(layer.overrides).length;

  const set = (path: string, v: unknown, coalesce = true) =>
    applyEdit((d) => {
      const l = draftLayer(d, ref);
      if (!l) return;
      l.overrides[path] = v;
      touch(l.meta);
    }, `风格：${path}`, coalesce ? { coalesce: `style.${ref.kind}.${path}` } : {});
  const setProjectDefault = (path: string, v: unknown) =>
    applyEdit((d) => {
      d.style.overrides[path] = v;
      touch(d.style.meta);
    }, `设为项目默认：${path}`);
  const reset = (path: string) =>
    applyEdit((d) => {
      const l = draftLayer(d, ref);
      if (l) delete l.overrides[path];
    }, `恢复继承：${path}`);

  return (
    <Section title={title} hint={count > 0 ? `覆盖 ${count} 项` : '全部继承'} defaultOpen={false} testid={`insp-style-${ref.kind}`}>
      {ref.kind === 'project' && (
        <Row label="风格预设">
          <select
            value={project.style.preset ?? 'ournotes'}
            data-testid="insp-style-preset"
            onChange={(e) => applyEdit((d) => { d.style.preset = e.target.value; touch(d.style.meta); }, '切换风格预设')}
          >
            {Object.entries(PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </Row>
      )}
      {count > 0 && (
        <Row label="重置">
          <button className="btn" data-testid={`insp-style-reset-${ref.kind}`} onClick={() => applyEdit((d) => { const l = draftLayer(d, ref); if (l) l.overrides = {}; }, '清除本层风格覆盖')}>清除本层全部覆盖</button>
        </Row>
      )}
      <PresetBar layerRef={ref} overrides={layer.overrides} />
      {GROUPS.map(([group, fields]) => {
        const n = fields.filter((f) => f.path in layer.overrides).length;
        return (
          <Section key={group} title={group} hint={n > 0 ? `覆盖 ${n} 项` : undefined} defaultOpen={false} testid={`insp-style-group-${ref.kind}-${group}`}>
            {fields.map((f) => {
              const origin = resolved.origin[f.path]!;
              const mine = origin === here;
              const value = getStylePath(resolved.values, f.path);
              return (
                <div key={f.path} className={`style-row${mine ? ' own' : ''}`} data-testid={`style-${ref.kind}-${f.path}`} title={f.path} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, field: f }); }}>
                  <Row label={unit === 'px' && isH(f) ? f.label.replace('/H', '') : f.label}>
                    <FieldControl field={f} value={value} dim={!mine} px={unit === 'px' && isH(f)} onChange={(v) => set(f.path, v)} onCommit={seal} testid={`style-input-${ref.kind}-${f.path}`} />
                    {mine ? (
                      <button className="ghost" onClick={() => reset(f.path)} title="恢复继承" aria-label={`恢复继承 ${f.label}`}>↺</button>
                    ) : (
                      <span className="origin" title={`继承自：${ORIGIN_LABEL[origin]}`}>{ORIGIN_LABEL[origin]}</span>
                    )}
                  </Row>
                </div>
              );
            })}
          </Section>
        );
      })}
      {menu && (
        <>
          <div className="ctx-back" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu" data-testid="style-ctx">
            <button role="menuitem" onClick={() => { clip = { value: getStylePath(resolved.values, menu.field.path), field: menu.field }; notify(`已复制 ${menu.field.label}`, 'info'); setMenu(null); }}>复制值</button>
            <button role="menuitem" disabled={!clip || clip.field.kind !== menu.field.kind} onClick={() => { if (clip) { const v = coerceStyleValue(menu.field, clip.value); if (v !== undefined) set(menu.field.path, v, false); } setMenu(null); }}>粘贴值</button>
            <button role="menuitem" disabled={!(menu.field.path in layer.overrides)} onClick={() => { reset(menu.field.path); setMenu(null); }}>恢复继承</button>
            <button role="menuitem" disabled={ref.kind === 'project'} onClick={() => { setProjectDefault(menu.field.path, getStylePath(resolved.values, menu.field.path)); setMenu(null); }} title="把当前生效的值写入项目层（成为全局默认）">设为项目默认</button>
          </div>
        </>
      )}
    </Section>
  );
}

const isH = (f: StyleField) => f.label.includes('/H');
let clip: { value: number | string | boolean; field: StyleField } | null = null;

const PRESET_KEY = 'studio.stylePresets';
type SavedPresets = Record<string, { name: string; overrides: Record<string, unknown> }>;
const loadPresets = (): SavedPresets => {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '{}') as SavedPresets;
  } catch {
    return {};
  }
};
const storePresets = (p: SavedPresets) => {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(p));
  } catch {
    notify('浏览器不允许保存预设（存储被禁用）');
  }
};
/** Keep only overrides that name a real style field and carry a valid value (what an imported preset may contain). */
export function cleanOverrides(raw: unknown): { ok: Record<string, unknown>; dropped: number } {
  const ok: Record<string, unknown> = {};
  let dropped = 0;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const f = styleField(k);
      const c = f ? coerceStyleValue(f, v) : undefined;
      if (c === undefined) dropped++;
      else ok[k] = c;
    }
  }
  return { ok, dropped };
}

/** Save / apply / duplicate / rename / delete / import / export the overrides of one style layer as named presets (kept in this browser). */
function PresetBar({ layerRef, overrides }: { layerRef: LayerRef; overrides: Record<string, unknown> }) {
  const [presets, setPresets] = useState<SavedPresets>(loadPresets);
  const [sel, setSel] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'save' | 'rename' | null>(null);
  const commit = (next: SavedPresets) => {
    setPresets(next);
    storePresets(next);
  };
  const apply = (raw: unknown, label: string) => {
    const { ok, dropped } = cleanOverrides(raw);
    useProject.getState().applyEdit((d) => {
      const l = draftLayer(d, layerRef);
      if (!l) return;
      Object.assign(l.overrides, ok);
      touch(l.meta);
    }, label);
    notify(`已应用 ${Object.keys(ok).length} 项${dropped > 0 ? `，忽略 ${dropped} 项无效值` : ''}`, 'info');
  };
  const chosen = presets[sel];
  const newId = () => `p${Date.now().toString(36)}`;
  return (
    <div className="style-presets" data-testid={`style-presets-${layerRef.kind}`}>
      <select value={sel} aria-label="已保存的风格预设" data-testid={`preset-select-${layerRef.kind}`} onChange={(e) => setSel(e.target.value)}>
        <option value="">（已保存的预设：{Object.keys(presets).length}）</option>
        {Object.entries(presets).map(([id, p]) => <option key={id} value={id}>{p.name}（{Object.keys(p.overrides).length} 项）</option>)}
      </select>
      <button className="btn-s" disabled={!chosen} data-testid={`preset-apply-${layerRef.kind}`} onClick={() => chosen && apply(chosen.overrides, `应用预设 ${chosen.name}`)}>应用</button>
      <button className="btn-s" data-testid={`preset-saveas-${layerRef.kind}`} onClick={() => { setMode('save'); setName(''); }} disabled={Object.keys(overrides).length === 0} title="把本层的覆盖项存成预设">另存为…</button>
      <button className="btn-s" disabled={!chosen} onClick={() => { if (chosen) { const id = newId(); commit({ ...presets, [id]: { name: `${chosen.name} 副本`, overrides: structuredClone(chosen.overrides) } }); setSel(id); } }}>复制</button>
      <button className="btn-s" disabled={!chosen} onClick={() => { setMode('rename'); setName(chosen?.name ?? ''); }}>重命名</button>
      <button className="btn-s danger" disabled={!chosen} onClick={() => { const rest = { ...presets }; delete rest[sel]; commit(rest); setSel(''); }}>删除</button>
      <button className="btn-s" disabled={Object.keys(overrides).length === 0} data-testid={`preset-export-${layerRef.kind}`} onClick={() => downloadJson('style-preset.json', { format: 'ournotes-style-preset', version: 1, overrides })}>导出</button>
      <label className="btn-s file">导入…<input type="file" accept=".json,application/json" hidden data-testid={`preset-import-${layerRef.kind}`} onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          const j = JSON.parse(await f.text()) as { format?: string; overrides?: unknown };
          if (j.format !== 'ournotes-style-preset') throw new Error('不是风格预设文件');
          apply(j.overrides, '导入风格预设');
        } catch (err) {
          notify(`导入失败：${(err as Error).message}`);
        }
      }} /></label>
      {mode && (
        <span className="preset-name">
          <input className="text" value={name} autoFocus placeholder="预设名称" aria-label="预设名称" data-testid="preset-name" onChange={(e) => setName(e.target.value)} />
          <button className="btn-s" disabled={!name.trim()} data-testid="preset-confirm" onClick={() => {
            if (mode === 'save') {
              const id = newId();
              commit({ ...presets, [id]: { name: name.trim(), overrides: structuredClone(overrides) } });
              setSel(id);
            } else if (chosen) commit({ ...presets, [sel]: { ...chosen, name: name.trim() } });
            setMode(null);
          }}>确定</button>
          <button className="btn-s" onClick={() => setMode(null)}>取消</button>
        </span>
      )}
    </div>
  );
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FieldControl({ field, value, dim, px, onChange, onCommit, testid }: { field: StyleField; value: number | string | boolean; dim: boolean; px: boolean; onChange: (v: unknown) => void; onCommit: () => void; testid: string }) {
  const cls = dim ? 'dim' : '';
  switch (field.kind) {
    case 'number':
    case 'int':
      if (px) {
        // shown as pixels of a 1080-row frame; stored as a fraction of the frame height
        const k = 1080;
        return (
          <span className={cls}>
            <NumField value={(value as number) * k} min={(field.min ?? -Infinity) * k} max={(field.max ?? Infinity) * k} step={Math.max(0.1, (field.step ?? 0.01) * k)} digits={1} unit="px" testid={testid} onChange={(v) => onChange(v / k)} onCommit={onCommit} />
          </span>
        );
      }
      return (
        <span className={cls}>
          <NumField value={value as number} min={field.min ?? -Infinity} max={field.max ?? Infinity} step={field.step ?? 0.01} digits={field.kind === 'int' ? 0 : (field.step ?? 0.01) < 0.01 ? 4 : 2} {...(field.unit ? { unit: field.unit } : {})} testid={testid} onChange={onChange} onCommit={onCommit} />
        </span>
      );
    case 'bool':
      return <input type="checkbox" className={cls} checked={value as boolean} data-testid={testid} onChange={(e) => { onChange(e.target.checked); onCommit(); }} />;
    case 'color':
      return <input type="color" className={cls} value={value as string} data-testid={testid} onChange={(e) => onChange(e.target.value)} onBlur={onCommit} />;
    case 'enum':
      return (
        <select className={cls} value={value as string} data-testid={testid} onChange={(e) => { onChange(e.target.value); onCommit(); }}>
          {field.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      );
    case 'text':
      return <input className={`text ${cls}`} value={value as string} data-testid={testid} onChange={(e) => onChange(e.target.value)} onBlur={onCommit} />;
  }
}
