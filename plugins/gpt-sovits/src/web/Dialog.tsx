/** 「配音」: the GPT-SoVITS auto voice-over plugin: server address, per-character voices (with 「自动匹配」), and generation for the project / scene. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOTION_LABEL } from '../../../../shared/catalog/labels';
import { NAME_PARTS } from '../../../../shared/catalog/romaji';
import { suggestEmotionPicks } from '../match/emotionFill';
import type { MatchResult, MatchRow, RefCandidate } from '../match/match';
import { cleanPath, cleanPathList } from '../paths';
import { DEFAULT_SOVITS_ENDPOINT, hasVoice } from '../profile';
import type { RefClip, VoiceProfile, VoiceScope, VoiceSettings } from '../schema';
import { host, previewRef, previewVoice, requestMatch, scanRefs, testVoiceConnection } from './api';
import { cancelJob, jobRunning, loadSettings, runJob, saveSettings, useVoice } from './store';

const BLANK: VoiceProfile = { promptText: '', promptLang: 'ja', speed: 1 };
const SOURCE_LABEL = { filename: '文件名', ai: 'AI' } as const;

/** Would applying this row replace something the person already filled in? */
export function overwrites(row: { gpt?: string | undefined; sovits?: string | undefined; ref?: { path: string } | undefined }, cur: VoiceProfile | undefined): boolean {
  if (!cur) return false;
  const differs = (a: string | undefined, b: string | undefined) => !!a && !!b && a !== b;
  return differs(cur.gptWeights, row.gpt) || differs(cur.sovitsWeights, row.sovits) || differs(cur.refAudioPath, row.ref?.path);
}

/** What the person has chosen for one row of the review table. */
export interface RowChoice { ticked: boolean; variant: number; ref: number; text: string }

export function initialChoice(row: MatchRow, cur: VoiceProfile | undefined): RowChoice {
  return { ticked: row.inProject && !overwrites(row, cur), variant: row.variant, ref: row.candidates.length > 0 ? 0 : -1, text: row.ref?.text ?? '' };
}

/** The weights and reference a row stands for after the person's choices. */
export function resolveRow(row: MatchRow, c: RowChoice): { gpt?: string; sovits?: string; ref?: { path: string; lang: string }; text: string } {
  const v = row.variants[c.variant];
  const cand = row.candidates[c.ref];
  const gpt = v ? v.gpt : row.gpt;
  const sovits = v ? v.sovits : row.sovits;
  const ref = cand ? { path: cand.path, lang: cand.lang || 'ja' } : row.ref ? { path: row.ref.path, lang: row.ref.lang || 'ja' } : undefined;
  return { ...(gpt ? { gpt } : {}), ...(sovits ? { sovits } : {}), ...(ref ? { ref } : {}), text: c.text };
}

const nameOfKey = (key: string): string => {
  const p = NAME_PARTS[key];
  return p ? `${p.family}${p.given}` : key;
};
const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);
export const candidateLabel = (c: RefCandidate): string =>
  `${c.calm ? '平静 · ' : ''}${c.tag ? `${c.tag} · ` : ''}${c.seconds !== null ? `${c.seconds.toFixed(1)}秒 · ` : ''}${clip(c.text || '（没有文本）', 26)}`;

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
  const [dirty, setDirty] = useState(false);
  const [retranslate, setRetranslate] = useState(false);
  const [force, setForce] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  const [applied, setApplied] = useState<string | null>(null);
  const [playingRef, setPlayingRef] = useState<string | null>(null);
  /** Reference clips found by the latest scan, per character (the emotion tables choose from them). */
  const [scans, setScans] = useState<Record<string, RefCandidate[]>>({});
  /** Emotion rows (`<character>:<emotion>`) the person switched to a hand-typed path. */
  const [scanning, setScanning] = useState(false);
  /** Rows (`<character>:<emotion>`) whose proposed clip is an extreme delivery that only just fits. */
  const [weakRows, setWeakRows] = useState<Set<string>>(new Set());
  const [customRows, setCustomRows] = useState<Set<string>>(new Set());
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
    setDirty(false);
  };
  useEffect(() => {
    void loadSettings().then((s) => s && adopt(s));
  }, []);
  useEffect(() => () => audio.current?.pause(), []);
  const touch = () => {
    setDirty(true);
    setApplied(null);
  };

  // one row per character of the project's cast, then the voices saved for characters that are not in it
  const rows = useMemo(() => {
    const out: Array<{ key: string; name: string }> = [];
    for (const c of project?.cast ?? []) if (!out.some((r) => r.key === c.characterKey)) out.push({ key: c.characterKey, name: c.displayName });
    for (const key of Object.keys(profiles)) if (!out.some((r) => r.key === key)) out.push({ key, name: nameOfKey(key) });
    return out;
  }, [project?.cast, profiles]);

  const patchProfile = (key: string, p: Partial<VoiceProfile>) => {
    touch();
    setProfiles((cur) => ({ ...cur, [key]: { ...BLANK, ...cur[key], ...p } }));
  };

  const extraDirs = () => cleanPathList(refDirs);

  /** Saves the form (and `withProfiles` instead of the profiles on screen). Pasted quotes are removed from every path first. */
  const persist = async (withProfiles?: Record<string, VoiceProfile>): Promise<boolean> => {
    setError(null);
    try {
      const profs: Record<string, VoiceProfile | null> = {};
      for (const [k, v] of Object.entries(withProfiles ?? profiles)) {
        const c: VoiceProfile = { ...v, ...(v.refAudioPath ? { refAudioPath: cleanPath(v.refAudioPath) } : {}), ...(v.gptWeights ? { gptWeights: cleanPath(v.gptWeights) } : {}), ...(v.sovitsWeights ? { sovitsWeights: cleanPath(v.sovitsWeights) } : {}) };
        if (v.emotionRefs) c.emotionRefs = Object.fromEntries(Object.entries(v.emotionRefs).map(([e, r]) => [e, { ...r, path: cleanPath(r.path) }]));
        profs[k] = c.refAudioPath?.trim() || c.gptWeights?.trim() || c.sovitsWeights?.trim() || c.promptText || (c.emotionRefs && Object.keys(c.emotionRefs).length > 0) ? c : null;
      }
      adopt(await saveSettings({ enabled, endpoint, textLang, defaultGptWeights: cleanPath(defGpt), defaultSovitsWeights: cleanPath(defSov), sovitsRoot: cleanPath(sovitsRoot), refDirs: extraDirs(), profiles: profs }));
      return true;
    } catch (e) {
      setError(`保存失败：${(e as Error).message}`);
      return false;
    }
  };
  const save = () => persist();

  /** Closing with edits that were not saved saves them first (and stays open, with the reason, when that fails). */
  const close = async () => {
    if (dirty && !(await persist())) return;
    onClose();
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

  const play = async (blob: Blob) => {
    audio.current?.pause();
    const a = new Audio(URL.createObjectURL(blob));
    a.volume = volume;
    audio.current = a;
    a.onended = () => setPlayingRef(null);
    await a.play();
  };

  const listen = async (key: string) => {
    setError(null);
    setBusy(`listen:${key}`);
    try {
      if (!(await save())) return;
      await play(await previewVoice(key));
    } catch (e) {
      setError(`试听失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** Plays the reference clip a row would use (straight from the scanned folder). */
  const listenRef = async (file: string) => {
    setError(null);
    setPlayingRef(file);
    try {
      await play(await previewRef(file));
    } catch (e) {
      setPlayingRef(null);
      setError(`试听参考音频失败：${(e as Error).message}`);
    }
  };

  const setEmotionRef = (key: string, emotion: string, ref: RefClip | null) => {
    const cur = { ...(profiles[key]?.emotionRefs ?? {}) };
    if (ref) cur[emotion] = ref;
    else delete cur[emotion];
    const { emotionRefs: _drop, ...rest } = profiles[key] ?? BLANK;
    void _drop;
    patchProfileReplace(key, { ...rest, ...(Object.keys(cur).length > 0 ? { emotionRefs: cur } : {}) });
  };
  const patchProfileReplace = (key: string, p: VoiceProfile) => {
    touch();
    setProfiles((c) => ({ ...c, [key]: { ...BLANK, ...p } }));
  };
  /** Scans the saved model folders for reference clips (no AI, no review, nothing changed) unless a scan is already in memory. */
  const ensureScan = async (): Promise<Record<string, RefCandidate[]>> => {
    if (Object.keys(scans).length > 0 || scanning) return scans;
    if (!hasFolder) return scans;
    setScanning(true);
    try {
      const known = rows.map((r) => ({ key: r.key, name: r.name }));
      const found = await scanRefs(known, cleanPath(sovitsRoot), extraDirs());
      setScans(found);
      return found;
    } catch (e) {
      setError(`扫描参考音频失败：${(e as Error).message}`);
      return scans;
    } finally {
      setScanning(false);
    }
  };
  /** Fills the EMPTY emotion rows from the file-name tags of the scanned clips; nothing is saved until the person saves. */
  const autoFillEmotions = async (key: string) => {
    const sc = await ensureScan();
    const cands = sc[key] ?? [];
    const proposal = suggestEmotionPicks(cands);
    const cur = profiles[key]?.emotionRefs ?? {};
    const add = Object.entries(proposal).filter(([e]) => !cur[e]?.path?.trim());
    if (add.length === 0) {
      setError(cands.length > 0 ? '没有可以自动填的：已填过的行不会被改，也没有别的合适的带标签 3–10 秒参考音频（不合适的宁可留空，用默认参考）' : hasFolder ? '没有扫描到这个角色的参考音频' : '请先在上面填「模型文件夹」');
      return;
    }
    setError(null);
    const { emotionRefs: _drop, ...rest } = profiles[key] ?? BLANK;
    void _drop;
    const weak = new Set(weakRows);
    for (const [e, p] of add) if (p.weak) weak.add(`${key}:${e}`);
    setWeakRows(weak);
    patchProfileReplace(key, { ...rest, emotionRefs: { ...cur, ...Object.fromEntries(add.map(([e, p]) => [e, { path: p.path, text: p.text, lang: p.lang }])) } });
    setApplied(`已按文件名标签填入 ${add.length} 个情绪（${add.map(([e]) => EMOTION_LABEL[e] ?? e).join('、')}）：请检查、试听，没问题再点「保存设置」。没有合适音频的情绪留空（用默认参考）。`);
  };
  /** Plays a clip of the emotion table (a hand-typed path is saved first, since the server only plays scanned or saved files). */
  const hearEmotionRef = async (file: string) => {
    if (dirty && !(await save())) return;
    await listenRef(file);
  };
  const renderEmotionRefs = (key: string, p: VoiceProfile) => {
    const cands = scans[key] ?? [];
    const refs = p.emotionRefs ?? {};
    const n = Object.values(refs).filter((r) => r.path.trim()).length;
    return (
      <details className="voice-emo" data-testid={`voice-emo-${key}`} onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void ensureScan(); }}>
        <summary>情绪参考音频{n > 0 ? `（已设 ${n} 个）` : '（可选）'}</summary>
        <p className="hint">一句台词的情绪（检查器里的「情绪」）对应哪段参考音频；没设的情绪用上面的默认参考。GPT-SoVITS 的语气取自参考音频，所以换音频才能换语气。展开时会按上面的「模型文件夹」自动扫描一次（不动角色声线），下拉框里才有这个角色的音频。</p>
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn-s" disabled={scanning} onClick={() => void autoFillEmotions(key)} title="只填空着的行，不覆盖已填的；填完请检查再保存" data-testid={`voice-emo-autofill-${key}`}>{scanning ? '扫描中…' : '按文件名标签自动填'}</button>
        </div>
        {Object.keys(EMOTION_LABEL).map((emotion) => {
          const ref = refs[emotion];
          const idx = ref ? cands.findIndex((c) => c.path === ref.path) : -1;
          const custom = customRows.has(`${key}:${emotion}`);
          const saved = !custom && !!ref?.path.trim() && idx < 0; // a saved clip that is not in the scan list: still shown, by file name
          const value = custom ? 'custom' : saved ? 'saved' : ref?.path.trim() ? String(idx) : 'none';
          return (
            <div className="srow" key={emotion} data-testid={`voice-emo-row-${key}-${emotion}`}>
              <span>{EMOTION_LABEL[emotion] ?? emotion}</span>
              <span className="voice-line">
                <select className="voice-sel" value={value} data-testid={`voice-emo-sel-${key}-${emotion}`} onChange={(e) => {
                  const v = e.target.value;
                  const rows = new Set(customRows);
                  const weak = new Set(weakRows);
                  rows.delete(`${key}:${emotion}`);
                  weak.delete(`${key}:${emotion}`);
                  setWeakRows(weak);
                  if (v === 'saved') return;
                  if (v === 'none') setEmotionRef(key, emotion, null);
                  else if (v === 'custom') { rows.add(`${key}:${emotion}`); setEmotionRef(key, emotion, ref ?? { path: '', text: '', lang: 'ja' }); }
                  else { const c = cands[Number(v)]; if (c) setEmotionRef(key, emotion, { path: c.path, text: c.text, lang: c.lang || 'ja' }); }
                  setCustomRows(rows);
                }}>
                  <option value="none">不用（用默认参考）</option>
                  {saved && ref && <option value="saved">{`${base(ref.path)}（已保存，不在扫描列表里）`}</option>}
                  {cands.map((c, i) => <option key={c.path} value={i}>{candidateLabel(c)}</option>)}
                  <option value="custom">自定义路径…</option>
                </select>
                <button className="btn-s" disabled={!ref?.path.trim() || playingRef === ref.path} onClick={() => ref && void hearEmotionRef(ref.path)} data-testid={`voice-emo-hear-${key}-${emotion}`}>▶</button>
              </span>
              {weakRows.has(`${key}:${emotion}`) && ref && <span className="warn" style={{ gridColumn: '1 / -1' }} data-testid={`voice-emo-weak-${key}-${emotion}`}>⚠ 这段是语气比较极端的音频，只因为没有更合适的才填；试听后不合适就改成「不用」。</span>}
              {custom && (
                <span className="voice-line" style={{ gridColumn: '1 / -1' }}>
                  <input className="text" value={ref?.path ?? ''} placeholder="参考音频路径" data-testid={`voice-emo-path-${key}-${emotion}`} onChange={(e) => setEmotionRef(key, emotion, { path: e.target.value, text: ref?.text ?? '', lang: ref?.lang ?? 'ja' })} />
                  <input className="text" value={ref?.text ?? ''} placeholder="参考文本（音频里说的话）" data-testid={`voice-emo-text-${key}-${emotion}`} onChange={(e) => setEmotionRef(key, emotion, { path: ref?.path ?? '', text: e.target.value, lang: ref?.lang ?? 'ja' })} />
                </span>
              )}
            </div>
          );
        })}
      </details>
    );
  };

  const generate = async (scope: VoiceScope) => {
    if (!(await save())) return;
    void runJob(scope, { ...(retranslate ? { retranslate: true } : {}), ...(force ? { force: true } : {}) });
  };

  const hasFolder = !!cleanPath(sovitsRoot) || extraDirs().length > 0;
  const autoMatch = async () => {
    setError(null);
    setApplied(null);
    setBusy('match');
    setMatch(null);
    try {
      const known = new Map(rows.map((r) => [r.key, r.name]));
      const r = await requestMatch([...known].map(([key, name]) => ({ key, name })), cleanPath(sovitsRoot), extraDirs());
      setMatch(r);
      setScans((cur) => ({ ...cur, ...Object.fromEntries(r.rows.map((row) => [row.characterKey, row.candidates])) }));
      setChoices(Object.fromEntries(r.rows.map((row) => [row.characterKey, initialChoice(row, profiles[row.characterKey])])));
    } catch (e) {
      setError(`自动匹配失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const setChoice = (key: string, patch: Partial<RowChoice>) => setChoices((c) => ({ ...c, [key]: { ...c[key]!, ...patch } }));

  /** Puts the ticked rows into the character voices AND saves them together with the folders, so nothing is lost by closing. */
  const applyAndSave = async () => {
    if (!match) return;
    setBusy('apply');
    const next = { ...profiles };
    const names: string[] = [];
    for (const row of match.rows) {
      const c = choices[row.characterKey];
      if (!c?.ticked) continue;
      const r = resolveRow(row, c);
      next[row.characterKey] = {
        ...BLANK, ...profiles[row.characterKey],
        ...(r.gpt ? { gptWeights: r.gpt } : {}), ...(r.sovits ? { sovitsWeights: r.sovits } : {}),
        ...(r.ref ? { refAudioPath: r.ref.path, promptLang: r.ref.lang } : {}), ...(r.text ? { promptText: r.text } : {}),
      };
      names.push(row.name);
    }
    const ok = await persist(next);
    setBusy(null);
    if (!ok) return;
    setMatch(null);
    setApplied(`已应用并保存：${names.length} 个角色的声线（${names.join('、')}），模型文件夹也一起保存了。`);
  };

  const running = jobRunning(job);
  const view = job?.view ?? null;
  const voicedKeys = rows.filter((r) => hasVoice(profiles[r.key])).length;
  const scene = project?.scenes.find((s) => s.id === selection.sceneId) ?? null;
  const pct = view && view.total > 0 ? Math.round((view.done / view.total) * 100) : 0;
  const nTicked = match ? match.rows.filter((r) => choices[r.characterKey]?.ticked).length : 0;
  const base = (p: string) => p.split(/[\\/]/).slice(-1)[0] ?? p;
  const beatLabel = (id: string) => {
    for (const s of project?.scenes ?? []) {
      const i = s.beats.findIndex((b) => b.id === id);
      if (i >= 0) return `${s.title || s.id} 第 ${i + 1} 句「${clip(s.beats[i]!.text, 12)}」`;
    }
    return id;
  };

  const renderRow = (r: MatchRow) => {
    const c = choices[r.characterKey];
    if (!c) return null;
    const res = resolveRow(r, c);
    const cand = r.candidates[c.ref];
    return (
      <fieldset className="voice-char" key={r.characterKey} data-testid={`voice-match-${r.characterKey}`}>
        <legend>
          <label className="check"><input type="checkbox" checked={c.ticked} onChange={(e) => setChoice(r.characterKey, { ticked: e.target.checked })} data-testid={`voice-match-tick-${r.characterKey}`} /> {r.name}</label>
          <small> · {SOURCE_LABEL[r.source]}{r.reason ? ` · ${r.reason}` : ''}</small>
          {!r.inProject && <small className="hint"> · 不在当前项目里</small>}
          {overwrites(res, profiles[r.characterKey]) && <small className="warn"> · 会覆盖已填的</small>}
        </legend>
        <label className="srow">
          <span>模型</span>
          {r.variants.length > 0 ? (
            <select className="voice-sel" value={c.variant} onChange={(e) => setChoice(r.characterKey, { variant: Number(e.target.value) })} data-testid={`voice-match-variant-${r.characterKey}`}>
              {r.variants.map((v, i) => <option key={v.label + i} value={i}>{`${v.label}（${v.version || '版本未知'} · 第 ${v.epoch} 轮${v.gpt && v.sovits ? '' : v.gpt ? ' · 只有 GPT' : ' · 只有 SoVITS'}）`}</option>)}
            </select>
          ) : (
            <span className="ro" title={`${r.gpt ?? ''}\n${r.sovits ?? ''}`}>{r.gpt ? base(r.gpt) : '—'} / {r.sovits ? base(r.sovits) : '—'}</span>
          )}
        </label>
        <label className="srow">
          <span>参考音频</span>
          <span className="voice-line">
            {r.candidates.length > 0 ? (
              <select className="voice-sel" value={c.ref} onChange={(e) => { const i = Number(e.target.value); setChoice(r.characterKey, { ref: i, text: r.candidates[i]?.text ?? '' }); }} data-testid={`voice-match-ref-${r.characterKey}`}>
                {r.candidates.map((k, i) => <option key={k.path} value={i}>{candidateLabel(k)}</option>)}
              </select>
            ) : (
              <span className="ro" title={r.ref?.path}>{r.ref ? base(r.ref.path) : '没有 3–10 秒的参考音频'}</span>
            )}
            <button className="btn-s" disabled={!res.ref || playingRef === res.ref.path} onClick={() => res.ref && void listenRef(res.ref.path)} data-testid={`voice-match-hear-${r.characterKey}`}>{res.ref && playingRef === res.ref.path ? '播放中…' : '试听'}</button>
          </span>
        </label>
        <label className="srow">
          <span>参考文本</span>
          <input className="text" value={c.text} onChange={(e) => setChoice(r.characterKey, { text: e.target.value })} placeholder={cand?.textFrom === 'none' ? '这个音频没有文本，请填音频里说的话' : '参考音频里说的话'} data-testid={`voice-match-text-${r.characterKey}`} />
        </label>
      </fieldset>
    );
  };

  return (
    <Modal title="配音（GPT-SoVITS 插件）" onClose={() => void close()} testid="voice-dialog" wide>
      {!settings ? (
        <p className="hint">{loadError ?? '读取中…'}</p>
      ) : (
        <div className="settings-form voice-form">
          <p className="hint">
            用你自己运行的 GPT-SoVITS（<code>api_v2.py</code>）给对白自动配日语：AI 先把台词译成口语日语，再按每个角色的参考音频逐句合成。旁白不配音；没有设置参考音频的角色也不配音。
          </p>
          <label className="srow">
            <span>启用</span>
            <span><input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); touch(); }} data-testid="voice-enabled" /> 使用配音插件（默认关闭）</span>
          </label>
          <label className="srow">
            <span>服务地址</span>
            <span className="voice-line">
              <input className="text" value={endpoint} onChange={(e) => { setEndpoint(e.target.value); touch(); setConn(null); }} placeholder={DEFAULT_SOVITS_ENDPOINT} data-testid="voice-endpoint" />
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
            <input className="text" value={textLang} onChange={(e) => { setTextLang(e.target.value); touch(); }} placeholder="ja" data-testid="voice-textlang" />
          </label>

          <h3 className="voice-h">自动匹配</h3>
          <label className="srow"><span>模型文件夹</span><input className="text" value={sovitsRoot} onChange={(e) => { setSovitsRoot(e.target.value); touch(); }} onBlur={() => setSovitsRoot((v) => cleanPath(v))} placeholder="GPT-SoVITS 安装目录，或下载的模型包文件夹，例如 D:\GPT-SoVITS\MYGO-models" data-testid="voice-root" /></label>
          <label className="srow"><span>其他模型 / 参考音频文件夹</span><textarea className="area" rows={2} value={refDirs} onChange={(e) => { setRefDirs(e.target.value); touch(); }} onBlur={() => setRefDirs((v) => cleanPathList(v).join('\n'))} placeholder="可空；每行一个文件夹" data-testid="voice-refdirs" /></label>
          <p className="hint">只在 GPT-SoVITS 和本软件在同一台电脑上时可用。填一个文件夹就够了：安装目录、模型包、某个角色的文件夹，或装着几个模型包的文件夹，里面所有子文件夹都会被读到（可以直接粘贴「复制为路径」得到的带引号路径）。按文件名和文件夹名对应到角色；对不上的再请 AI 帮忙。</p>
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn" disabled={busy === 'match' || !hasFolder || rows.length === 0} onClick={() => void autoMatch()} data-testid="voice-automatch">{busy === 'match' ? '扫描中…' : '自动匹配'}</button>
          </div>
          {applied && <p className="ok" data-testid="voice-applied">{applied}</p>}
          {match && (
            <div data-testid="voice-match">
              <p className="hint">扫描到 GPT 权重 {match.scanned.gpt} 个、SoVITS 权重 {match.scanned.sovits} 个、参考音频 {match.scanned.refs} 个。{match.ai === 'unavailable' ? ' 没有配置 AI，只按文件名匹配。' : match.ai === 'failed' ? ' AI 匹配失败。' : ''}</p>
              {match.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
              {match.rows.length > 0 && <p className="hint">项目里的角色已勾选；包里的其他角色没有勾选（声线各个项目共用，需要的话勾上）。可以换模型、换参考音频并试听，参考文本也能改。</p>}
              {match.rows.filter((r) => r.inProject).map(renderRow)}
              {match.rows.some((r) => !r.inProject) && <h4 className="voice-h">包里的其他角色</h4>}
              {match.rows.filter((r) => !r.inProject).map(renderRow)}
              {match.unmatched.map((k) => (
                <p key={k} className="hint" data-testid={`voice-unmatched-${k}`}>{rows.find((r) => r.key === k)?.name ?? k}：未找到</p>
              ))}
              <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="btn primary" disabled={nTicked === 0 || busy === 'apply'} onClick={() => void applyAndSave()} data-testid="voice-match-apply">{busy === 'apply' ? '保存中…' : `应用并保存（${nTicked} 个角色）`}</button>
                <button className="btn" onClick={() => setMatch(null)}>放弃</button>
              </div>
            </div>
          )}

          <h3 className="voice-h">角色声线</h3>
          <label className="srow"><span>默认 GPT 权重</span><input className="text" value={defGpt} onChange={(e) => { setDefGpt(e.target.value); touch(); }} placeholder=".ckpt（可空）" data-testid="voice-def-gpt" /></label>
          <label className="srow"><span>默认 SoVITS 权重</span><input className="text" value={defSov} onChange={(e) => { setDefSov(e.target.value); touch(); }} placeholder=".pth（可空）" data-testid="voice-def-sovits" /></label>
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
                {renderEmotionRefs(r.key, p)}
              </fieldset>
            );
          })}

          {error && <p className="bad" data-testid="voice-error">{error}</p>}
          <div className="modal-actions">
            <button className="btn primary" onClick={() => void save()} data-testid="voice-save">{dirty ? '保存设置' : '已保存'}</button>
          </div>

          <h3 className="voice-h">生成配音</h3>
          <p className="hint">需要先在上面启用、设置参考音频，并配置好 AI（用来译成日语）。已有且内容没变的句子不会重新合成（句子的参考音频——按情绪或手动指定——变了也算变了，会重新合成）。每句用哪段参考音频：这一句在检查器里指定的，否则按它的情绪取上面「情绪参考音频」里设的，都没有就用默认参考。生成结果是一步操作，可以撤销；中途取消或连接失败时，没做完的句子保留原来的配音。每一遍合成都会检查有没有读漏字，疑似漏字会自动换个随机种子重来（最多 2 次）。</p>
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
              {view && view.warnings.length > 0 && (
                <ul className="voice-errors" data-testid="voice-warnings">
                  {view.warnings.slice(0, 20).map((e) => <li key={e.beatId} className="warn">{beatLabel(e.beatId)}：{e.message}</li>)}
                </ul>
              )}
              {view && view.errors.length > 0 && (
                <ul className="voice-errors" data-testid="voice-errors">
                  {view.errors.slice(0, 20).map((e) => <li key={e.beatId} className="bad">{beatLabel(e.beatId)}：{e.message}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
