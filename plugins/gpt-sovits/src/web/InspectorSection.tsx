/** Inspector section of a spoken line: its Japanese text (editable), the recording (play), and 「生成这一句配音」. Shown only while the plugin is on. */
import { useEffect, useRef, useState } from 'react';
import type { Beat, Project, Scene } from '../../../../shared/schema/project';
import { usableVoice } from '../../../../shared/voice/lines';
import { isSpokenBeat, profileOfBeat } from '../lines';
import { host } from './api';
import { jobRunning, loadSettings, runJob, useVoice } from './store';

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
  const stale = !!v?.file && !usable;
  const running = jobRunning(job);
  const edit = (spoken: string) =>
    h.applyBeatVoice([{ sceneId: scene.id, beatId: beat.id, voice: spoken.trim() === '' ? null : { src: beat.text, spoken, spokenEdited: true, by: 'gpt-sovits' } }], '修改日语台词', { coalesce: `${beat.id}.spoken` });
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
  return (
    <Section title="配音（GPT-SoVITS）" hint={profile ? profile.displayName : undefined} testid="insp-voice">
      {!profile && <p className="hint" data-testid="insp-voice-novoice">这位角色还没有设置参考音频，不会配音（顶栏「配音」里设置）。</p>}
      <Row label="日语台词">
        <span className="ro">{v?.spokenEdited ? '手改（重新翻译时保留）' : v?.spoken ? 'AI 翻译' : '尚未翻译'}</span>
      </Row>
      <textarea className="area" rows={3} value={v?.spoken ?? ''} placeholder="生成配音时由 AI 译成日语；也可以在这里直接写" data-testid="insp-voice-ja" onChange={(e) => edit(e.target.value)} onBlur={() => h.sealEdit()} />
      <Row label="音频">
        <span className="ro" data-testid="insp-voice-gen-state">
          {usable ? `已生成 ${usable.seconds.toFixed(1)} 秒` : stale ? '原文已改，需要重新生成' : v?.spoken ? '日语已有，音频未生成' : '未生成'}
        </span>
        <button className="btn-s" disabled={!usable} onClick={() => void play()} data-testid="insp-voice-play-gen">▶ 播放</button>
        <button className="btn-s accent" disabled={!profile || running} onClick={() => void runJob({ kind: 'beat', sceneId: scene.id, beatId: beat.id }, stale ? { retranslate: !v?.spokenEdited } : {})} data-testid="insp-voice-gen">
          {running && job?.scope.kind === 'beat' && job.scope.beatId === beat.id ? '生成中…' : '生成这一句配音'}
        </button>
      </Row>
      {playError && <p className="bad">{playError}</p>}
    </Section>
  );
}
