/** Inspector section of a spoken line: its Japanese text (editable), the recording (play), and 「生成这一句配音」. Shown only while the plugin is on. */
import { useEffect, useRef, useState } from 'react';
import type { Beat, Project, Scene } from '../../../../shared/schema/project';
import { usableVoice } from '../../../../shared/voice/lines';
import { EMOTION_LABEL } from '../../../../shared/catalog/labels';
import type { BeatVoice } from '../../../../shared/schema/project';
import { isSpokenBeat, profileOfBeat, refChanged, resolveRef, type ResolvedRef } from '../lines';
import { host, previewRef } from './api';
import { jobRunning, loadSettings, playVersion, runJob, useVoice } from './store';

export function VoiceSection({ project, scene, beat }: { project: Project; scene: Scene; beat: Beat }) {
  const h = host();
  const { Section, Row } = h.ui;
  const settings = useVoice((s) => s.settings);
  const job = useVoice((s) => s.job);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings]);
  useEffect(() => () => audio.current?.pause(), [beat.id]);
  if (!settings?.enabled || !isSpokenBeat(beat)) return null;

  const profile = profileOfBeat(project, beat, settings.profiles);
  const v = beat.voice;
  const usable = usableVoice(beat);
  const resolved = profile ? resolveRef(profile.profile, beat) : null;
  const refStale = !!usable && !!resolved && refChanged(v, resolved);
  const stale = !!v?.file && !usable;
  const running = jobRunning(job);
  const edit = (spoken: string) =>
    h.applyBeatVoice([{ sceneId: scene.id, beatId: beat.id, voice: spoken.trim() === '' ? (v?.ref !== undefined ? { src: beat.text, ref: v.ref, by: 'gpt-sovits' } : null) : { src: beat.text, spoken, spokenEdited: true, ...(v?.ref !== undefined ? { ref: v.ref } : {}), by: 'gpt-sovits' } }], '修改日语台词', { coalesce: `${beat.id}.spoken` });
  /** Pins (or, with `undefined`, unpins) the reference clip of this line; the recording stays until it is made again. */
  const setRef = (ref: BeatVoice['ref'] | undefined) => {
    const next: BeatVoice = { ...(v ?? { src: beat.text }) };
    if (ref === undefined) delete next.ref;
    else next.ref = ref;
    const empty = !next.file && !next.spoken && next.ref === undefined;
    h.applyBeatVoice([{ sceneId: scene.id, beatId: beat.id, voice: empty ? null : { ...next, by: 'gpt-sovits' } }], '修改参考音频', { coalesce: `${beat.id}.ref` });
  };
  const pin = v?.ref;
  const choice = pin === undefined || pin === 'auto' ? 'auto' : typeof pin === 'object' ? 'custom' : pin === 'default' ? 'default' : `emo:${pin}`;
  const onChoice = (value: string) => {
    if (value === 'auto') setRef(undefined);
    else if (value === 'default') setRef('default');
    else if (value === 'custom') setRef({ path: typeof pin === 'object' ? pin.path : resolved?.ref.path ?? '', text: typeof pin === 'object' ? pin.text : resolved?.ref.text ?? '', lang: typeof pin === 'object' ? pin.lang : resolved?.ref.lang ?? 'ja' });
    else setRef(value.slice(4));
    h.sealEdit();
  };
  const emotions = profile ? Object.keys(EMOTION_LABEL).filter((k) => profile.profile.emotionRefs?.[k]?.path.trim()) : [];
  const nameOfRef = (r: ResolvedRef) => `${r.ref.path.split(/[\\/]/).slice(-1)[0] ?? r.ref.path}${r.emotion ? `（${EMOTION_LABEL[r.emotion] ?? r.emotion}）` : '（默认）'}`;
  const hearRef = async () => {
    setPlayError(null);
    if (!resolved) return;
    try {
      audio.current?.pause();
      const a = new Audio(URL.createObjectURL(await previewRef(resolved.ref.path)));
      a.volume = h.voice.getVolume();
      audio.current = a;
      await a.play();
    } catch (e) {
      setPlayError(`试听参考音频失败：${(e as Error).message}`);
    }
  };
  const play = async () => {
    setPlayError(null);
    if (!usable) return;
    try {
      audio.current?.pause();
      const a = new Audio(h.voice.fileUrl(project.id, usable.file));
      a.volume = h.voice.getVolume();
      audio.current = a;
      await a.play();
    } catch (e) {
      setPlayError(`播放失败：${(e as Error).message}`);
    }
  };
  const mine = running && job?.scope.kind === 'beat' && job.scope.beatId === beat.id;
  /** A new version of this line (same Japanese, or retranslated first); it is played as soon as it arrives. */
  const regenerate = async (retranslate: boolean) => {
    let overwriteEdited = false;
    if (retranslate && v?.spokenEdited) {
      if (!window.confirm('这句日语是你手改过的，重新翻译会覆盖它。继续吗？')) return;
      overwriteEdited = true;
    }
    const view = await runJob({ kind: 'beat', sceneId: scene.id, beatId: beat.id }, { regenerate: true, label: `重新合成配音：${[...beat.text].slice(0, 6).join('')}`, ...(retranslate ? { retranslate: true, overwriteEdited } : {}) });
    const file = view?.results.find((r) => r.beatId === beat.id)?.voice.file;
    if (file) await playVersion(project.id, file).catch((e: Error) => setPlayError(`播放失败：${e.message}`));
  };
  return (
    <Section title="配音（GPT-SoVITS）" hint={profile ? profile.displayName : undefined} testid="insp-voice">
      {!profile && <p className="hint" data-testid="insp-voice-novoice">这位角色还没有设置参考音频，不会配音（顶栏「配音」里设置）。</p>}
      <Row label="日语台词">
        <span className="ro">{v?.spokenEdited ? '手改（重新翻译时保留）' : v?.spoken ? 'AI 翻译' : '尚未翻译'}</span>
      </Row>
      <textarea className="area" rows={3} value={v?.spoken ?? ''} placeholder="生成配音时由 AI 译成日语；也可以在这里直接写" data-testid="insp-voice-ja" onChange={(e) => edit(e.target.value)} onBlur={() => h.sealEdit()} />
      {profile && resolved && (
        <>
          <Row label="参考音频">
            <select value={choice} onChange={(e) => onChoice(e.target.value)} data-testid="insp-voice-ref">
              <option value="auto">{`按情绪（自动：${nameOfRef(resolveRef(profile.profile, { emotion: beat.emotion }))}）`}</option>
              <option value="default">默认参考</option>
              {emotions.map((k) => <option key={k} value={`emo:${k}`}>{`${EMOTION_LABEL[k] ?? k}：${profile.profile.emotionRefs![k]!.path.split(/[\\/]/).slice(-1)[0]}`}</option>)}
              <option value="custom">自定义…</option>
            </select>
            <button className="btn-s" onClick={() => void hearRef()} title={resolved.ref.path} data-testid="insp-voice-ref-hear">▶ 试听参考</button>
          </Row>
          {typeof pin === 'object' && (
            <>
              <input className="text" value={pin.path} placeholder="参考音频路径（GPT-SoVITS 那台电脑上的）" data-testid="insp-voice-ref-path" onChange={(e) => setRef({ ...pin, path: e.target.value })} onBlur={() => h.sealEdit()} />
              <input className="text" value={pin.text} placeholder="参考文本（音频里说的话）" data-testid="insp-voice-ref-text" onChange={(e) => setRef({ ...pin, text: e.target.value })} onBlur={() => h.sealEdit()} />
            </>
          )}
          <p className="hint" data-testid="insp-voice-ref-used">将使用：{nameOfRef(resolved)}</p>
          {refStale && <p className="warn" data-testid="insp-voice-ref-stale">参考音频已改，需要重新生成（点「生成这一句配音」）。</p>}
        </>
      )}
      <Row label="音频">
        <span className="ro" data-testid="insp-voice-gen-state">
          {usable ? `已生成 ${usable.seconds.toFixed(1)} 秒${refStale ? '（参考音频已改，需要重新生成）' : ''}` : stale ? '原文已改，需要重新生成' : v?.spoken ? '日语已有，音频未生成' : '未生成'}
        </span>
        <button className="btn-s" disabled={!usable} onClick={() => void play()} data-testid="insp-voice-play-gen">▶ 播放</button>
        <button className="btn-s accent" disabled={!profile || running} onClick={() => void runJob({ kind: 'beat', sceneId: scene.id, beatId: beat.id }, stale ? { retranslate: !v?.spokenEdited } : {})} data-testid="insp-voice-gen">
          {mine && job?.mode === 'generate' ? '生成中…' : '生成这一句配音'}
        </button>
        <button className="btn-s" disabled={!profile || running || !v?.spoken} onClick={() => void regenerate(false)} title="用同一句日语再合成一版（每次语气略有不同），可撤销回上一版" data-testid="insp-voice-regen">
          {mine && job?.mode === 'regenerate' ? '合成中…' : '重新合成'}
        </button>
        <button className="btn-s" disabled={!profile || running} onClick={() => void regenerate(true)} title="结合上下文重新翻译这一句，再合成一版；可撤销" data-testid="insp-voice-retranslate">
          {mine && job?.mode === 'retranslate' ? '合成中…' : '重新翻译并合成'}
        </button>
      </Row>
      {usable && v?.suspect && <p className="warn" data-testid="insp-voice-suspect">这一句可能没读完（重试后声音仍比日语应有的短）：请听一遍，不对就点「重新合成」。</p>}
      {playError && <p className="bad">{playError}</p>}
    </Section>
  );
}
