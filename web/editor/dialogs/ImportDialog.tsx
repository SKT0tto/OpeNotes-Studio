/** Import a `.openotes.json` (or bare project) file: validate, list resources the library lacks, let the user substitute them. */
import { useMemo, useState } from 'react';
import { findMissing, parseImport, replaceRef, type MissingRef } from '@shared/project/exchange';
import { newProjectId } from '@shared/project/blank';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';
import { createProject, listProjects } from '../../projectsApi';
import { idsOf } from '../useCatalog';
import { Modal } from '../ui';

const KIND_LABEL = { model: '服装模型', background: '背景', audio: '音频' } as const;

function candidates(m: MissingRef, catalog: CompactCatalog): Array<{ id: string; label: string }> {
  if (m.kind === 'background') return catalog.backgrounds.slice(0, 400).map((b) => ({ id: b.id, label: `${b.name}（${b.id}）` }));
  if (m.kind === 'audio') return catalog.audio.map((a) => ({ id: a.id, label: a.name }));
  const key = catalog.models.find((x) => x.id === m.id)?.characterKey ?? m.id.split('_')[0];
  return catalog.models.filter((x) => x.characterKey === key && x.quality !== 'low').map((x) => ({ id: x.id, label: x.id }));
}

export function ImportDialog({ text, fileName, catalog, onDone, onClose }: { text: string; fileName: string; catalog: CompactCatalog; onDone: (p: Project, etag: string, note: string) => void; onClose: () => void }) {
  const parsed = useMemo(() => parseImport(text), [text]);
  const [project, setProject] = useState<Project | null>(parsed.ok ? parsed.project : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const have = useMemo(() => idsOf(catalog), [catalog]);
  const missing = project ? findMissing(project, have) : [];

  const commit = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const taken = (await listProjects()).some((p) => p.id === project.id);
      const toCreate = taken ? { ...project, id: newProjectId(), title: `${project.title}（导入）` } : project;
      const r = await createProject(toCreate);
      onDone(r.project, r.etag, taken ? '项目 id 已存在，已作为新项目导入。' : '导入完成。');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`导入项目 · ${fileName}`} onClose={onClose} testid="import-dialog" wide>
      {!parsed.ok || !project ? (
        <p className="bad" data-testid="import-error">{parsed.ok ? '' : parsed.error}</p>
      ) : (
        <>
          <p>
            <strong>{project.title}</strong>：{project.scenes.length} 个场景，{project.cast.length} 个角色。
            {parsed.catalogVersion && parsed.catalogVersion !== catalog.version && <span className="warn"> 导出时的素材库版本与当前不同。</span>}
          </p>
          {missing.length === 0 ? (
            <p className="ok" data-testid="import-ok">所有引用的素材都在当前素材库中。</p>
          ) : (
            <div data-testid="import-missing">
              <p className="warn">当前素材库缺少 {missing.length} 个被引用的素材。可以逐个替换，或原样导入（对应场景在预览中会显示错误，之后仍可在检查器里更换）。</p>
              <table className="missing">
                <tbody>
                  {missing.map((m) => (
                    <tr key={`${m.kind}:${m.id}`} data-testid="missing-row">
                      <td>{KIND_LABEL[m.kind]}</td>
                      <td className="mono">{m.id}</td>
                      <td>
                        <select defaultValue="" onChange={(e) => e.target.value && setProject(replaceRef(project, m.kind, m.id, e.target.value))} aria-label={`替换 ${m.id}`}>
                          <option value="">（保持原样）</option>
                          {candidates(m, catalog).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="bad">{error}</p>}
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy} onClick={() => void commit()} data-testid="import-confirm">{missing.length > 0 ? '仍然导入' : '导入'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
