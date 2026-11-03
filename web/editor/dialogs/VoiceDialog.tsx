/** 「配音」: the GPT-SoVITS auto voice-over plugin (off by default): server address, per-character voices, and generation for the project / scene. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SOVITS_ENDPOINT, hasVoice, type VoiceProfile, type VoiceScope, type VoiceSettings } from '@shared/schema/voice';
import { previewVoice, testVoiceConnection } from '../../voiceApi';
import { useProject } from '../../store/projectStore';
import { jobRunning, useVoice } from '../../store/voiceStore';
import { useCatalog } from '../useCatalog';
import { Modal } from '../ui';

const BLANK: VoiceProfile = { promptText: '', promptLang: 'ja', speed: 1 };

export function VoiceDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const catalog = useCatalog();
  const settings = useVoice((s) => s.settings);
  const loadError = useVoice((s) => s.loadError);
  const job = useVoice((s) => s.job);
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState(DEFAULT_SOVITS_ENDPOINT);
  const [volume, setVolume] = useState(1);
  const [textLang, setTextLang] = useState('ja');
  const [profiles, setProfiles] = useState<Record<string, VoiceProfile>>({});
  const [conn, setConn] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retranslate, setRetranslate] = useState(false);
  const [force, setForce] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const adopt = useCallback((s: VoiceSettings) => {
    setEnabled(s.enabled);
    setEndpoint(s.endpoint);
    setVolume(s.volume);
    setTextLang(s.textLang);
    setProfiles(s.profiles);
  }, []);
  useEffect(() => {
    void useVoice.getState().load().then((s) => s && adopt(s));
  }, [adopt]);
  useEffect(() => () => audio.current?.pause(), []);

  // one row per character of the project's cast, then the voices saved for characters that are not in it
  const rows = useMemo(() => {
    const out: Array<{ key: string; name: string }> = [];
    for (const c of project.cast) if (!out.some((r) => r.key === c.characterKey)) out.push({ key: c.characterKey, name: c.displayName });
    for (const key of Object.keys(profiles)) if (!out.some((r) => r.key === key)) out.push({ key, name: catalog?.characters.find((c) => c.key === key)?.name ?? key });
    return out;
  }, [project.cast, profiles, catalog]);

  const patchProfile = (key: string, p: Partial<VoiceProfile>) => {
    setSaved(false);
    setProfiles((cur) => ({ ...cur, [key]: { ...BLANK, ...cur[key], ...p } }));
  };

  const save = async (): Promise<boolean> => {
    setError(null);
    try {
      const profs: Record<string, VoiceProfile | null> = {};
      for (const [k, v] of Object.entries(profiles)) profs[k] = v.refAudioPath?.trim() || v.gptWeights?.trim() || v.sovitsWeights?.trim() || v.promptText ? v : null;
      adopt(await useVoice.getState().save({ enabled, endpoint, volume, textLang, profiles: profs }));
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
    void useVoice.getState().run(scope, { ...(retranslate ? { retranslate: true } : {}), ...(force ? { force: true } : {}) });
  };

  const running = jobRunning(job);
  const view = job?.view ?? null;
  const voicedKeys = rows.filter((r) => hasVoice(profiles[r.key])).length;
  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? null;
  const pct = view && view.total > 0 ? Math.round((view.done / view.total) * 100) : 0;

  return (
    <Modal title="配音（GPT-SoVITS）" onClose={onClose} testid="voice-dialog" wide>
      {!settings ? (
        <p className="hint">{loadError ?? '读取中…'}</p>
      ) : (
        <div className="settings-form voice-form">
          <p className="hint">
            用你自己运行的 GPT-SoVITS（<code>api_v2.py</code>）给对白自动配日语：AI 先把台词译成口语日语，再按每个角色的参考音频逐句合成。旁白不配音；没有设置参考音频的角色也不配音。
          </p>
          <label className="srow">
            <span>启用</span>
            <span><input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }} data-testid="voice-enabled" /> 播放时使用配音（默认关闭）</span>
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
            <span>音量</span>
            <span className="voice-line"><input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => { setVolume(Number(e.target.value)); setSaved(false); }} data-testid="voice-volume" /><span>{Math.round(volume * 100)}%</span></span>
          </label>
          <label className="srow">
            <span>合成语言</span>
            <input className="text" value={textLang} onChange={(e) => { setTextLang(e.target.value); setSaved(false); }} placeholder="ja" data-testid="voice-textlang" />
          </label>

          <h3 className="voice-h">角色声线</h3>
          <p className="hint">路径是 GPT-SoVITS 所在电脑上的路径。权重留空 = 沿用服务当前已加载的模型。参考音频建议 3–10 秒、与参考文本一致。</p>
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
            {running && <button className="btn" onClick={() => useVoice.getState().cancel()} data-testid="voice-cancel">取消</button>}
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
