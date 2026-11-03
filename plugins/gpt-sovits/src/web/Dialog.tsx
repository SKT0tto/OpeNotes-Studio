/** 「配音」: the GPT-SoVITS auto voice-over plugin: server address, per-character voices (with 「自动匹配」), and generation for the project / scene. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatchResult, MatchRow } from '../match/match';
import { DEFAULT_SOVITS_ENDPOINT, hasVoice, type VoiceProfile, type VoiceScope, type VoiceSettings } from '../schema';
import { host, previewVoice, requestMatch, testVoiceConnection } from './api';
import { cancelJob, jobRunning, loadSettings, runJob, saveSettings, useVoice } from './store';

const BLANK: VoiceProfile = { promptText: '', promptLang: 'ja', speed: 1 };
const SOURCE_LABEL = { filename: '文件名', ai: 'AI' } as const;

/** Would applying this row replace something the person already filled in? */
export function overwrites(row: MatchRow, cur: VoiceProfile | undefined): boolean {
  if (!cur) return false;
  const differs = (a: string | undefined, b: string | undefined) => !!a && !!b && a !== b;
  return differs(cur.gptWeights, row.gpt) || differs(cur.sovitsWeights, row.sovits) || differs(cur.refAudioPath, row.ref?.path);
}

export function VoiceDialog({ onClose }: { onClose: () => void }) {
  const h = host();
  const { Modal } = h.ui;
  const { project, selection } = h.useStudio();
  const settings = useVoice((s) => s.settings);
  const loadError = useVoice((s) => s.loadError);
  const job = useVoice((s) => s.job);
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState(DEFAULT_SOVITS_ENDPOINT);
  const [volume, setVolume] = useState(h.voice.getVolume());
  const [textLang, setTextLang] = useState('ja');
  const [defGpt, setDefGpt] = useState('');
  const [defSov, setDefSov] = useState('');
  const [sovitsRoot, setSovitsRoot] = useState('');
  const [refDirs, setRefDirs] = useState('');
  const [profiles, setProfiles] = useState<Record<string, VoiceProfile>>({});
  const [conn, setConn] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retranslate, setRetranslate] = useState(false);
  const [force, setForce] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const audio = useRef<HTMLAudioElement | null>(null);

  const adopt = (s: VoiceSettings) => {
    setEnabled(s.enabled);
    setEndpoint(s.endpoint);
    setTextLang(s.textLang);
    setProfiles(s.profiles);
    setDefGpt(s.defaultGptWeights ?? '');
    setDefSov(s.defaultSovitsWeights ?? '');
    setSovitsRoot(s.sovitsRoot ?? '');
    setRefDirs(s.refDirs.join('\n'));
  };
  useEffect(() => {
    void loadSettings().then((s) => s && adopt(s));
  }, []);
  useEffect(() => () => audio.current?.pause(), []);

  // one row per character of the project's cast, then the voices saved for characters that are not in it
  const rows = useMemo(() => {
    const out: Array<{ key: string; name: string }> = [];
    for (const c of project?.cast ?? []) if (!out.some((r) => r.key === c.characterKey)) out.push({ key: c.characterKey, name: c.displayName });
    for (const key of Object.keys(profiles)) if (!out.some((r) => r.key === key)) out.push({ key, name: key });
    return out;
  }, [project?.cast, profiles]);

  const patchProfile = (key: string, p: Partial<VoiceProfile>) => {
    setSaved(false);
    setProfiles((cur) => ({ ...cur, [key]: { ...BLANK, ...cur[key], ...p } }));
  };

  const save = async (): Promise<boolean> => {
    setError(null);
    try {
      const profs: Record<string, VoiceProfile | null> = {};
      for (const [k, v] of Object.entries(profiles)) profs[k] = v.refAudioPath?.trim() || v.gptWeights?.trim() || v.sovitsWeights?.trim() || v.promptText ? v : null;
      adopt(await saveSettings({ enabled, endpoint, textLang, defaultGptWeights: defGpt, defaultSovitsWeights: defSov, sovitsRoot, refDirs: refDirs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), profiles: profs }));
      setSaved(true);
      return true;
    } catch (e) {
      setError(`保存失败：${(e as Error).message}`);
      return false;
    }
  };

  const test = async () => {
    setBusy('test');
    setConn(null);
    try {
      setConn(await testVoiceConnection(endpoint));
    } catch (e) {
      setConn({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const listen = async (key: string) => {
    setError(null);
    setBusy(`listen:${key}`);
    try {
      if (!(await save())) return;
      const blob = await previewVoice(key);
      audio.current?.pause();
      const a = new Audio(URL.createObjectURL(blob));
      a.volume = volume;
      audio.current = a;
      await a.play();
    } catch (e) {
      setError(`试听失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const generate = async (scope: VoiceScope) => {
    if (!(await save())) return;
    void runJob(scope, { ...(retranslate ? { retranslate: true } : {}), ...(force ? { force: true } : {}) });
  };

  const autoMatch = async () => {
    setError(null);
    setBusy('match');
    setMatch(null);
    try {
      const r = await requestMatch(rows, sovitsRoot, refDirs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
      setMatch(r);
      setPicked(new Set(r.rows.filter((row) => !overwrites(row, profiles[row.characterKey])).map((row) => row.characterKey)));
    } catch (e) {
      setError(`自动匹配失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const applyPicked = () => {
    if (!match) return;
    setSaved(false);
    setProfiles((cur) => {
      const next = { ...cur };
      for (const row of match.rows) {
        if (!picked.has(row.characterKey)) continue;
        next[row.characterKey] = {
          ...BLANK, ...cur[row.characterKey],
          ...(row.gpt ? { gptWeights: row.gpt } : {}), ...(row.sovits ? { sovitsWeights: row.sovits } : {}),
          ...(row.ref ? { refAudioPath: row.ref.path, ...(row.ref.text ? { promptText: row.ref.text } : {}), promptLang: row.ref.lang || 'ja' } : {}),
        };
      }
      return next;
    });
    setMatch(null);
  };

  const running = jobRunning(job);
  const view = job?.view ?? null;
  const voicedKeys = rows.filter((r) => hasVoice(profiles[r.key])).length;
  const scene = project?.scenes.find((s) => s.id === selection.sceneId) ?? null;
  const pct = view && view.total > 0 ? Math.round((view.done / view.total) * 100) : 0;
  const base = (p: string) => p.split(/[\\/]/).slice(-1)[0] ?? p;

  return (
    <Modal title="配音（GPT-SoVITS 插件）" onClose={onClose} testid="voice-dialog" wide>
      {!settings ? (
        <p className="hint">{loadError ?? '读取中…'}</p>
      ) : (
        <div className="settings-form voice-form">
          <p className="hint">
            用你自己运行的 GPT-SoVITS（<code>api_v2.py</code>）给对白自动配日语：AI 先把台词译成口语日语，再按每个角色的参考音频逐句合成。旁白不配音；没有设置参考音频的角色也不配音。
          </p>
          <label className="srow">
            <span>启用</span>
            <span><input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }} data-testid="voice-enabled" /> 使用配音插件（默认关闭）</span>
          </label>
          <label className="srow">
            <span>服务地址</span>
            <span className="voice-line">
              <input className="text" value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setSaved(false); setConn(null); }} placeholder={DEFAULT_SOVITS_ENDPOINT} data-testid="voice-endpoint" />
              <button className="btn-s" disabled={busy === 'test'} onClick={() => void test()} data-testid="voice-test">{busy === 'test' ? '测试中…' : '测试连接'}</button>
            </span>
          </label>
          {conn && <p className={conn.ok ? 'ok' : 'bad'} data-testid="voice-conn">{conn.message}</p>}
          <label className="srow">
            <span>播放音量</span>
            <span className="voice-line"><input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => { setVolume(Number(e.target.value)); h.voice.setVolume(Number(e.target.value)); }} data-testid="voice-volume" /><span>{Math.round(volume * 100)}%</span></span>
          </label>
          <label className="srow">
            <span>合成语言</span>
            <input className="text" value={textLang} onChange={(e) => { setTextLang(e.target.value); setSaved(false); }} placeholder="ja" data-testid="voice-textlang" />
          </label>

          <h3 className="voice-h">自动匹配</h3>
          <label className="srow"><span>GPT-SoVITS 文件夹</span><input className="text" value={sovitsRoot} onChange={(e) => { setSovitsRoot(e.target.value); setSaved(false); }} placeholder="D:\GPT-SoVITS\GPT-SoVITS-v5-…" data-testid="voice-root" /></label>
          <label className="srow"><span>其他参考音频文件夹</span><textarea className="area" rows={2} value={refDirs} onChange={(e) => { setRefDirs(e.target.value); setSaved(false); }} placeholder="每行一个文件夹（可空）；每个角色一个子文件夹最好" data-testid="voice-refdirs" /></label>
          <p className="hint">只在 GPT-SoVITS 和本软件在同一台电脑上时可用：扫描 GPT_weights* / SoVITS_weights* 里的权重，和 ref* / 参考音频* 里的参考音频，按文件名与文件夹名对应到角色；对不上的再请 AI 帮忙。</p>
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn" disabled={busy === 'match' || !sovitsRoot.trim() || rows.length === 0} onClick={() => void autoMatch()} data-testid="voice-automatch">{busy === 'match' ? '扫描中…' : '自动匹配'}</button>
          </div>
          {match && (
            <div data-testid="voice-match">
              <p className="hint">扫描到 GPT 权重 {match.scanned.gpt} 个、SoVITS 权重 {match.scanned.sovits} 个、参考音频 {match.scanned.refs} 个。{match.ai === 'unavailable' ? ' 没有配置 AI，只按文件名匹配。' : match.ai === 'failed' ? ' AI 匹配失败。' : ''}</p>
              {match.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
              <table className="voice-match-table">
                <thead><tr><th /><th>角色</th><th>GPT</th><th>SoVITS</th><th>参考音频 / 文本</th><th>来源</th></tr></thead>
                <tbody>
                  {match.rows.map((r) => (
                    <tr key={r.characterKey} data-testid={`voice-match-${r.characterKey}`}>
                      <td><input type="checkbox" checked={picked.has(r.characterKey)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.characterKey); else n.delete(r.characterKey); return n; })} /></td>
                      <td>{r.name}{overwrites(r, profiles[r.characterKey]) && <small className="warn"> 会覆盖已填的</small>}</td>
                      <td title={r.gpt}>{r.gpt ? base(r.gpt) : '—'}</td>
                      <td title={r.sovits}>{r.sovits ? base(r.sovits) : '—'}</td>
                      <td title={r.ref?.path}>{r.ref ? <>{base(r.ref.path)}<br /><small>{r.ref.text || '（没有文本，请手填）'}</small></> : '—'}</td>
                      <td>{SOURCE_LABEL[r.source]}{r.reason ? <small> · {r.reason}</small> : null}</td>
                    </tr>
                  ))}
                  {match.unmatched.map((k) => (
                    <tr key={k} data-testid={`voice-unmatched-${k}`}><td /><td>{rows.find((r) => r.key === k)?.name ?? k}</td><td colSpan={4} className="hint">未找到</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="btn primary" disabled={picked.size === 0} onClick={applyPicked} data-testid="voice-match-apply">应用所选</button>
                <button className="btn" onClick={() => setMatch(null)}>关闭</button>
              </div>
              <p className="hint">应用后记得点下面的「保存设置」。</p>
            </div>
          )}

          <h3 className="voice-h">角色声线</h3>
          <label className="srow"><span>默认 GPT 权重</span><input className="text" value={defGpt} onChange={(e) => { setDefGpt(e.target.value); setSaved(false); }} placeholder=".ckpt（可空）" data-testid="voice-def-gpt" /></label>
          <label className="srow"><span>默认 SoVITS 权重</span><input className="text" value={defSov} onChange={(e) => { setDefSov(e.target.value); setSaved(false); }} placeholder=".pth（可空）" data-testid="voice-def-sovits" /></label>
          <p className="hint">角色的权重留空时用这里的；也留空 = 用 GPT-SoVITS 启动时加载的模型（这时请让所有角色都留空，否则会串用别人的模型）。路径是 GPT-SoVITS 所在电脑上的路径；参考音频建议 3–10 秒、与参考文本一致。</p>
          {rows.length === 0 && <p className="hint">项目里还没有角色。</p>}
          {rows.map((r) => {
            const p = profiles[r.key] ?? BLANK;
            return (
              <fieldset className="voice-char" key={r.key} data-testid={`voice-char-${r.key}`}>
                <legend>{r.name}<small> · {r.key}</small>{hasVoice(p) ? <em className="ok"> 已配置</em> : <em className="hint"> 未配音</em>}</legend>
                <label className="srow"><span>参考音频</span><input className="text" value={p.refAudioPath ?? ''} onChange={(e) => patchProfile(r.key, { refAudioPath: e.target.value })} placeholder="D:\GPT-SoVITS\ref\kasumi.wav" data-testid={`voice-ref-${r.key}`} /></label>
                <label className="srow"><span>参考文本</span><input className="text" value={p.promptText} onChange={(e) => patchProfile(r.key, { promptText: e.target.value })} placeholder="参考音频里说的话（建议填写）" data-testid={`voice-prompt-${r.key}`} /></label>
                <label className="srow"><span>参考语言</span><input className="text" value={p.promptLang} onChange={(e) => patchProfile(r.key, { promptLang: e.target.value })} placeholder="ja" /></label>
                <label className="srow"><span>GPT 权重</span><input className="text" value={p.gptWeights ?? ''} onChange={(e) => patchProfile(r.key, { gptWeights: e.target.value })} placeholder=".ckpt（可空）" /></label>
                <label className="srow"><span>SoVITS 权重</span><input className="text" value={p.sovitsWeights ?? ''} onChange={(e) => patchProfile(r.key, { sovitsWeights: e.target.value })} placeholder=".pth（可空）" /></label>
                <label className="srow">
                  <span>语速</span>
                  <span className="voice-line">
                    <input type="range" min={0.6} max={1.4} step={0.05} value={p.speed} onChange={(e) => patchProfile(r.key, { speed: Number(e.target.value) })} />
                    <span>{p.speed.toFixed(2)}×</span>
                    <button className="btn-s" disabled={!hasVoice(p) || busy !== null || running} onClick={() => void listen(r.key)} data-testid={`voice-listen-${r.key}`}>{busy === `listen:${r.key}` ? '合成中…' : '试听'}</button>
                  </span>
                </label>
              </fieldset>
            );
          })}

          {error && <p className="bad" data-testid="voice-error">{error}</p>}
          <div className="modal-actions">
            <button className="btn primary" onClick={() => void save()} data-testid="voice-save">{saved ? '已保存' : '保存设置'}</button>
          </div>

          <h3 className="voice-h">生成配音</h3>
          <p className="hint">需要先在上面启用、设置参考音频，并配置好 AI（用来译成日语）。已有且内容没变的句子不会重新合成。生成结果是一步操作，可以撤销。</p>
          <div className="voice-line">
            <label className="chip check"><input type="checkbox" checked={retranslate} onChange={(e) => setRetranslate(e.target.checked)} />重新翻译（保留手改过的日语）</label>
            <label className="chip check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />全部重新合成</label>
          </div>
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" disabled={running || !enabled || voicedKeys === 0} onClick={() => void generate({ kind: 'project' })} data-testid="voice-gen-project">生成整个项目的配音</button>
            <button className="btn" disabled={running || !enabled || voicedKeys === 0 || !scene} onClick={() => scene && void generate({ kind: 'scene', sceneId: scene.id })} data-testid="voice-gen-scene" title={scene ? `场景：${scene.title}` : '先选一个场景'}>生成当前场景</button>
            {running && <button className="btn" onClick={() => cancelJob()} data-testid="voice-cancel">取消</button>}
          </div>
          {(running || view) && (
            <div data-testid="voice-progress">
              <progress value={pct} max={100} style={{ width: '100%' }} />
              <p className={view?.state === 'failed' ? 'bad' : 'hint'}>{job?.starting ? '启动中…' : view?.message}{view && view.total > 0 ? `（${view.done}/${view.total}）` : ''}</p>
              {view && view.errors.length > 0 && (
                <ul className="voice-errors" data-testid="voice-errors">
                  {view.errors.slice(0, 20).map((e) => <li key={e.beatId} className="bad">{e.beatId}：{e.message}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
