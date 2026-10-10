/** AI settings: provider switch, model / base URL / key (write-only, shown masked), connection test. */
import { useCallback, useEffect, useState } from 'react';
import type { LlmProviderId, PublicLlmSettings } from '@shared/schema/settings';
import { fetchLlmSettings, saveLlmSettings, testLlm, type TestOutcome } from '../../llmApi';
import { Modal } from '../ui';

const LABEL: Record<LlmProviderId, string> = { anthropic: 'Claude（Anthropic）', openai: 'OpenAI 兼容（LM Studio / DeepSeek …）', fixture: '测试回放（非 AI）' };

export function SettingsDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: (s: PublicLlmSettings) => void }) {
  const [s, setS] = useState<PublicLlmSettings | null>(null);
  const [provider, setProvider] = useState<LlmProviderId>('anthropic');
  const [aModel, setAModel] = useState('');
  const [aKey, setAKey] = useState('');
  const [oBase, setOBase] = useState('');
  const [oModel, setOModel] = useState('');
  const [oKey, setOKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestOutcome | null>(null);

  const adopt = useCallback((v: PublicLlmSettings) => {
    setS(v);
    setProvider(v.provider ?? (v.openai.baseUrl ? 'openai' : 'anthropic'));
    setAModel(v.anthropic.model);
    setOBase(v.openai.baseUrl);
    setOModel(v.openai.model);
    onChanged?.(v);
  }, [onChanged]);

  useEffect(() => {
    fetchLlmSettings().then(adopt, (e: Error) => setError(e.message));
  }, [adopt]);

  /** Keys are only sent when typed; an empty key box keeps the stored one. */
  const save = async (): Promise<PublicLlmSettings | null> => {
    setError(null);
    try {
      const v = await saveLlmSettings({
        provider,
        anthropic: { model: aModel, ...(aKey.trim() ? { apiKey: aKey.trim() } : {}) },
        openai: { baseUrl: oBase, model: oModel, ...(oKey.trim() ? { apiKey: oKey.trim() } : {}) },
      });
      setAKey('');
      setOKey('');
      adopt(v);
      return v;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const clearKey = async (which: 'anthropic' | 'openai') => {
    const v = await saveLlmSettings(which === 'anthropic' ? { anthropic: { apiKey: null } } : { openai: { apiKey: null } });
    adopt(v);
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    if (await save()) {
      setResult(await testLlm());
      // the server remembers the outcome: show "verified" / "failed" in the status line too
      await fetchLlmSettings().then(adopt, () => undefined);
    }
    setBusy(false);
  };

  const keyInfo = (k: PublicLlmSettings['anthropic'], which: 'anthropic' | 'openai') =>
    k.hasKey ? (
      <span className="hint" data-testid={`${which}-key-state`}>
        已填写 key <code>{k.mask}</code>（{k.source === 'env' ? '来自环境变量 / .env' : '已保存在服务端'}）
        {k.source === 'file' && <button className="btn-s" onClick={() => void clearKey(which)}>清除</button>}
      </span>
    ) : (
      <span className="hint" data-testid={`${which}-key-state`}>未配置</span>
    );

  return (
    <Modal title="AI 设置" onClose={onClose} testid="settings-dialog" wide>
      {!s ? (
        <p className="hint">{error ?? '读取中…'}</p>
      ) : (
        <div className="settings-form">
          <p className={s.status.verified === 'ok' ? 'ok' : s.status.configured && s.status.verified !== 'failed' ? 'hint' : 'warn'} data-testid="llm-status" data-verified={s.status.verified}>{s.status.message}</p>
          <label className="srow">
            <span>提供方</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as LlmProviderId)} data-testid="llm-provider">
              {s.available.map((p) => <option key={p} value={p}>{LABEL[p]}</option>)}
            </select>
          </label>
          {provider === 'anthropic' && (
            <>
              <label className="srow"><span>模型</span><input className="text" value={aModel} onChange={(e) => setAModel(e.target.value)} data-testid="anthropic-model" /></label>
              <label className="srow">
                <span>API Key</span>
                <input className="text" type="password" autoComplete="off" placeholder="sk-ant-…（只写入服务端，不会回显）" value={aKey} onChange={(e) => setAKey(e.target.value)} data-testid="anthropic-key" />
              </label>
              <div className="srow"><span /> {keyInfo(s.anthropic, 'anthropic')}</div>
            </>
          )}
          {provider === 'openai' && (
            <>
              <label className="srow"><span>接口地址</span><input className="text" placeholder="http://localhost:1234/v1" value={oBase} onChange={(e) => setOBase(e.target.value)} data-testid="openai-base" /></label>
              <label className="srow"><span>模型</span><input className="text" value={oModel} onChange={(e) => setOModel(e.target.value)} data-testid="openai-model" /></label>
              <label className="srow">
                <span>API Key（可空）</span>
                <input className="text" type="password" autoComplete="off" placeholder="本地服务无需填写" value={oKey} onChange={(e) => setOKey(e.target.value)} data-testid="openai-key" />
              </label>
              <div className="srow"><span /> {keyInfo(s.openai, 'openai')}</div>
            </>
          )}
          {provider === 'fixture' && <p className="hint">仅测试环境：回放 tests/fixtures/llm 中录制的模型输出，不调用任何模型。</p>}
          {error && <p className="bad" data-testid="settings-error">{error}</p>}
          {result && (
            <p className={result.ok ? 'ok' : 'bad'} data-testid="test-result">
              {result.ok ? `连接成功：${result.model} · ${result.latencyMs} ms` : `连接失败：${result.error?.message ?? '未知错误'}`}
            </p>
          )}
          <p className="hint">Key 保存在服务端 data/settings.local.json（已被 git 忽略），页面不会再次显示明文。环境变量 / .env 只提供默认值，这里保存的值优先。</p>
          <div className="modal-actions">
            <button className="btn" disabled={busy} onClick={() => void test()} data-testid="btn-test-llm">{busy ? '测试中…' : '测试连接'}</button>
            <button className="btn primary" disabled={busy} onClick={() => void save().then((v) => v && onClose())} data-testid="btn-save-llm">保存</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
