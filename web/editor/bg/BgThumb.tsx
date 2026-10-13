import { useEffect, useRef, useState } from 'react';

interface SheetDesc { x: number; y: number; w: number; h: number; sheetW: number; sheetH: number; url: string }
const sheets = new Map<string, Promise<SheetDesc | null>>();

/** Where the picture sits on a contact sheet (null when there is no sheet); cached per id. */
export function loadSheet(id: string): Promise<SheetDesc | null> {
  let p = sheets.get(id);
  if (!p) {
    p = fetch(`/api/thumbs/backgrounds/${encodeURIComponent(id)}/sheet`).then(
      (r) => (r.ok ? (r.json() as Promise<SheetDesc>) : null),
      () => null,
    );
    sheets.set(id, p);
  }
  return p;
}

export type ThumbState = 'img' | 'sheet' | 'none';
export interface ThumbTarget { id: string; name: string; description?: string | null }

/**
 * Thumbnail with a three-step fallback: the library's picture (server-made small copy) -> the contact-sheet crop (developer machines) ->
 * a placeholder card that shows the title and the description, so a background can be recognised even with no picture at all.
 */
export function BgThumb({ bg, w = 320, className = '', onState }: { bg: ThumbTarget; w?: number; className?: string; onState?: (s: ThumbState) => void }) {
  // state is kept per picture id, so a card that shows another picture starts again from the real image
  const [st, setSt] = useState<{ id: string; state: ThumbState; sheet: SheetDesc | null }>({ id: bg.id, state: 'img', sheet: null });
  const { state, sheet } = st.id === bg.id ? st : { state: 'img' as ThumbState, sheet: null };
  const cb = useRef(onState);
  useEffect(() => {
    cb.current = onState;
  });
  useEffect(() => {
    cb.current?.(state);
  }, [state]);
  const fail = () => {
    void loadSheet(bg.id).then((d) => setSt({ id: bg.id, state: d ? 'sheet' : 'none', sheet: d }));
  };
  // the cell is a little wider than 16:9: scale it up until it fills the frame's height, and crop the sides evenly
  const scale = sheet ? Math.max(1, sheet.w / sheet.h / (16 / 9)) : 1;
  return (
    <div className={`bgx-thumb ${className}`} data-thumb={state} data-testid="bg-thumb">
      {state === 'img' && <img src={`/api/thumbs/backgrounds/${encodeURIComponent(bg.id)}?w=${w}`} loading="lazy" decoding="async" alt={bg.name} onError={fail} draggable={false} />}
      {state === 'sheet' && sheet && (
        <img
          className="bgx-sheet" src={sheet.url} alt={bg.name} draggable={false}
          style={{ width: `${(sheet.sheetW / sheet.w) * scale * 100}%`, left: `${-(sheet.x / sheet.w) * scale * 100 - ((scale - 1) / 2) * 100}%`, transform: `translateY(${-(sheet.y / sheet.sheetH) * 100}%)` }}
        />
      )}
      {state === 'none' && (
        <div className="bgx-ph" role="img" aria-label={bg.name}>
          <strong>{bg.name}</strong>
          {bg.description && <span>{bg.description}</span>}
        </div>
      )}
    </div>
  );
}
