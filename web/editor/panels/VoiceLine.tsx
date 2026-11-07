/** Inspector: the recorded voice of a line (only when it has one) with a play button, and the sections plugins registered for a line. */
import { useEffect, useRef, useState } from 'react';
import type { Beat, Project, Scene } from '@shared/schema/project';
import { usableVoice } from '@shared/voice/lines';
import { usePlugins } from '../../plugins/registry';
import { useVoicePrefs } from '../../store/voicePrefs';
import { Row, Section } from '../ui';

export function VoiceLine({ project, beat }: { project: Project; beat: Beat }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => audio.current?.pause(), [beat.id]);
  const v = beat.voice;
  if (!v) return null;
  const usable = usableVoice(beat);
  const play = async () => {
    if (!usable) return;
    setError(null);
    try {
      audio.current?.pause();
      const a = new Audio(`/api/projects/${encodeURIComponent(project.id)}/voice/${encodeURIComponent(usable.file)}`);
      a.volume = useVoicePrefs.getState().volume;
      audio.current = a;
      await a.play();
    } catch (e) {
      setError(`播放失败：${(e as Error).message}`);
    }
  };
  return (
    <Section title="配音" hint={v.by} testid="insp-voice-line">
      <Row label="音频">
        <span className="ro" data-testid="insp-voice-state">
          {usable ? `${usable.seconds.toFixed(1)} 秒` : v.file ? '台词已改，这段配音不再使用' : '尚未生成音频'}
        </span>
        <button className="btn-s" disabled={!usable} onClick={() => void play()} data-testid="insp-voice-play">▶ 播放</button>
      </Row>
      {v.spoken && <p className="hint" data-testid="insp-voice-spoken">{v.spoken}</p>}
      {error && <p className="bad">{error}</p>}
    </Section>
  );
}

export function PluginInspectorSections({ project, scene, beat }: { project: Project; scene: Scene; beat: Beat }) {
  const sections = usePlugins((s) => s.sections);
  return (
    <>
      {sections.map((s) => <s.component key={`${s.pluginId}:${s.id}`} project={project} scene={scene} beat={beat} />)}
    </>
  );
}
