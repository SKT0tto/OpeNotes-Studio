/** Inspector section of a spoken line: its Japanese text (editable), the recording (play), and 「生成这一句配音」. Shown only while the plugin is on. */
import { useEffect, useRef, useState } from 'react';
import type { Beat, Project, Scene } from '@shared/schema/project';
import { isSpokenBeat, profileOfBeat } from '@shared/voice/lines';
import { useProject } from '../../store/projectStore';
import { jobRunning, useVoice } from '../../store/voiceStore';
import { voiceFileUrl } from '../../voiceApi';
import { Row, Section } from '../ui';

export function VoiceFields({ project, scene, beat }: { project: Project; scene: Scene; beat: Beat }) {
  const settings = useVoice((s) => s.settings);
  const job = useVoice((s) => s.job);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  useEffect(() => {
    if (!useVoice.getState().settings) void useVoice.getState().load();
  }, []);
  useEffect(() => () => audio.current?.pause(), [beat.id]);
  if (!settings?.enabled || !isSpokenBeat(beat)) return null;

  const profile = profileOfBeat(project, beat, settings.profiles);
  const v = beat.voice;
  const stale = v?.src !== undefined && v.src !== beat.text;
  const running = jobRunning(job);
  const edit = (ja: string) =>
    useProject.getState().applyEdit((d) => {
      const b = d.scenes.find((s) => s.id === scene.id)?.beats.find((x) => x.id === beat.id);
      if (!b) return;
      // a hand-written Japanese line: it keeps through re-translation, and the old recording no longer fits it
      if (ja.trim() === '') delete b.voice;
      else b.voice = { ja, jaEdited: true, src: b.text };
    }, '修改日语台词', { coalesce: `${beat.id}.ja` });
  const play = async () => {
    setPlayError(null);
    if (!v?.file) return;
    try {
      audio.current?.pause();
      const a = new Audio(voiceFileUrl(project.id, v.file));
      a.volume = settings.volume;
      audio.current = a;
      await a.play();
    } catch (e) {
      setPlayError(`播放失败：${(e as Error).message}`);
    }
  };
  return (
    <Section title="配音" hint={profile ? profile.displayName : undefined} testid="insp-voice">
      {!profile && <p className="hint" data-testid="insp-voice-novoice">这位角色还没有设置参考音频，不会配音（顶栏「配音」里设置）。</p>}
      <Row label="日语台词">
        <span className="ro">{v?.jaEdited ? '手改（重新翻译时保留）' : v?.ja ? 'AI 翻译' : '尚未翻译'}</span>
      </Row>
      <textarea className="area" rows={3} value={v?.ja ?? ''} placeholder="生成配音时由 AI 译成日语；也可以在这里直接写" data-testid="insp-voice-ja" onChange={(e) => edit(e.target.value)} onBlur={() => useProject.getState().seal()} />
      <Row label="音频">
        <span className="ro" data-testid="insp-voice-state">
          {v?.file && !stale ? `已生成 ${v.seconds?.toFixed(1) ?? '?'} 秒` : stale ? '原文已改，需要重新生成' : v?.ja ? '日语已有，音频未生成' : '未生成'}
        </span>
        <button className="btn-s" disabled={!v?.file || stale} onClick={() => void play()} data-testid="insp-voice-play">▶ 播放</button>
        <button className="btn-s accent" disabled={!profile || running} onClick={() => void useVoice.getState().run({ kind: 'beat', sceneId: scene.id, beatId: beat.id }, stale ? { retranslate: !v?.jaEdited } : {})} data-testid="insp-voice-gen">
          {running && job?.scope.kind === 'beat' && job.scope.beatId === beat.id ? '生成中…' : '生成这一句配音'}
        </button>
      </Row>
      {playError && <p className="bad">{playError}</p>}
    </Section>
  );
}
