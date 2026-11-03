import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectSchema } from '../../shared/schema/project';
import { applyBeatVoice } from '../../web/plugins/patches';
import { addButton, addSection, usePlugins } from '../../web/plugins/registry';
import { useProject } from '../../web/store/projectStore';
import { useVoicePrefs } from '../../web/store/voicePrefs';
import demo from '../fixtures/demo-project.json';

const open = () => useProject.getState().open(ProjectSchema.parse(JSON.parse(JSON.stringify(demo))), null);
const beat = (id: string) => useProject.getState().project!.scenes.flatMap((s) => s.beats).find((b) => b.id === id)!;

beforeEach(() => {
  open();
});

describe('host API: applyBeatVoice', () => {
  it('writes several beats as ONE undo step and undo restores the project exactly', () => {
    const before = useProject.getState().project!;
    const n = applyBeatVoice(
      [
        { sceneId: 's1', beatId: 's1b1', voice: { src: beat('s1b1').text, spoken: 'こんにちは', file: 'a-12345678.wav', seconds: 2, by: 'test' } },
        { sceneId: 's1', beatId: 's1b3', voice: { src: beat('s1b3').text, spoken: 'やあ' } },
      ],
      '生成配音',
    );
    expect(n).toBe(2);
    expect(beat('s1b1').voice).toMatchObject({ spoken: 'こんにちは', file: 'a-12345678.wav', seconds: 2 });
    expect(beat('s1b3').voice).toMatchObject({ spoken: 'やあ' });
    expect(useProject.getState().undoLabel).toBe('生成配音');
    useProject.getState().undo();
    expect(useProject.getState().project).toEqual(before);
    expect(useProject.getState().canUndo).toBe(false);
  });

  it('changes nothing but the voice field, ignores unknown beats, and works on a locked beat', () => {
    useProject.getState().applyEdit((d) => void (d.scenes[0]!.beats[0]!.meta.locked = true), '锁定');
    const before = JSON.parse(JSON.stringify(useProject.getState().project));
    expect(applyBeatVoice([{ sceneId: 's1', beatId: 'nope', voice: { src: 'x' } }], 'x')).toBe(0);
    expect(applyBeatVoice([{ sceneId: 's1', beatId: 's1b1', voice: { src: beat('s1b1').text, spoken: 'ロック中でも' } }], '生成配音')).toBe(1);
    const after = JSON.parse(JSON.stringify(useProject.getState().project));
    delete after.scenes[0].beats[0].voice;
    expect(after).toEqual(before);
  });

  it('null removes the voice; a coalesce key merges consecutive edits into one step', () => {
    applyBeatVoice([{ sceneId: 's1', beatId: 's1b1', voice: { src: beat('s1b1').text, spoken: 'あ' } }], '修改日语台词', { coalesce: 'k' });
    applyBeatVoice([{ sceneId: 's1', beatId: 's1b1', voice: { src: beat('s1b1').text, spoken: 'あい' } }], '修改日语台词', { coalesce: 'k' });
    useProject.getState().undo();
    expect(beat('s1b1').voice).toBeUndefined();
    expect(useProject.getState().canUndo).toBe(false);
    applyBeatVoice([{ sceneId: 's1', beatId: 's1b1', voice: { src: 'x', spoken: 'あ' } }], 'a');
    expect(applyBeatVoice([{ sceneId: 's1', beatId: 's1b1', voice: null }], 'b')).toBe(1);
    expect(beat('s1b1').voice).toBeUndefined();
  });
});

describe('plugin registry and voice preference', () => {
  it('is empty without plugins and replaces a registration with the same id', () => {
    usePlugins.setState({ info: [], buttons: [], sections: [] });
    expect(usePlugins.getState().buttons).toEqual([]);
    expect(usePlugins.getState().sections).toEqual([]);
    const dialog = () => null;
    addButton({ pluginId: 'p', id: 'b', label: 'one', dialog });
    addButton({ pluginId: 'p', id: 'b', label: 'two', dialog });
    addSection({ pluginId: 'p', id: 's', component: () => null });
    expect(usePlugins.getState().buttons.map((b) => b.label)).toEqual(['two']);
    expect(usePlugins.getState().sections).toHaveLength(1);
    usePlugins.setState({ info: [], buttons: [], sections: [] });
  });
  it('voice volume defaults to 1 and is clamped', () => {
    expect(useVoicePrefs.getState().volume).toBe(1);
    useVoicePrefs.getState().setVolume(5);
    expect(useVoicePrefs.getState().volume).toBe(1);
    useVoicePrefs.getState().setVolume(-1);
    expect(useVoicePrefs.getState().volume).toBe(0);
    useVoicePrefs.getState().setVolume(1);
  });
});
