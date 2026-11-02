/** The speed menu of the editor preview and the play page: presets, plus 「自定义…」 for a typed speed. */
import { useState } from 'react';
import { RATE_MAX, RATE_MIN, RATE_PRESETS, formatRate, isPreset, parseRate } from './rate';

const CUSTOM = 'custom';

export function RateSelect({ value, onChange, testId = 'play-rate' }: { value: number; onChange: (rate: number) => void; testId?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const r = parseRate(draft);
    if (r !== null) onChange(r);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        className="rate-input" autoFocus inputMode="decimal" value={draft} size={5}
        placeholder={`${RATE_MIN}–${RATE_MAX}`} title={`输入倍速，${RATE_MIN}–${RATE_MAX}（如 1.3），回车确定，Esc 取消`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation(); // typing digits must not trigger the editor's shortcuts
        }}
        data-testid={`${testId}-custom`}
      />
    );
  }
  return (
    <select
      value={String(value)}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setDraft(String(value));
          setEditing(true);
        } else onChange(Number(e.target.value));
      }}
      data-testid={testId}
    >
      {RATE_PRESETS.map((r) => <option key={r} value={String(r)}>{formatRate(r)}</option>)}
      {!isPreset(value) && <option value={String(value)}>{formatRate(value)}（自定义）</option>}
      <option value={CUSTOM}>自定义…</option>
    </select>
  );
}
