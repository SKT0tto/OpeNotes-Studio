import { CATEGORY_COLOR, CATEGORY_LABEL, REVIEW_COLOR, REVIEW_LABEL, bandColor, reviewOf, suggestionText } from '@shared/catalog/bgUi';
import { bgCategoryOf } from '@shared/director/bgCategory';
import { GENERIC_BAND } from '@shared/schema/assetLabels';
import type { BackgroundEntry } from '@shared/schema/assets';
import charactersJson from '@shared/data/characters.json';
import bandsJson from '@shared/data/bands.json';
import { BgThumb } from './BgThumb';

export const BANDS = bandsJson.bands as Array<{ key: string; name: string; members: string[] }>;
export const CHARACTERS = charactersJson.characters as Array<{ key: string; name: string; band: string; role: string }>;
export const bandNameOfKey = (k: string) => (k === GENERIC_BAND ? '通用' : (BANDS.find((b) => b.key === k)?.name ?? k));
const TIME_SHORT: Record<string, string> = { 日间: '日', 傍晚: '傍晚', 夜间: '夜' };

/** Band badge: the band's colour, "通用" in grey, a grey question mark for an unknown owner. */
export function BandBadge({ bands }: { bands: readonly string[] | undefined }) {
  if (!bands || bands.length === 0) return <span className="bgx-badge bgx-unknown" data-testid="bg-band" title="乐队未知">？未知</span>;
  if (bands.includes(GENERIC_BAND)) return <span className="bgx-badge" style={{ ['--c' as string]: bandColor(GENERIC_BAND) }} data-testid="bg-band">通用</span>;
  return (
    <>
      {bands.map((b) => <span key={b} className="bgx-badge" style={{ ['--c' as string]: bandColor(b) }} data-testid="bg-band">{bandNameOfKey(b)}</span>)}
    </>
  );
}

export function OwnerDot({ name, band }: { name: string; band?: string }) {
  const c = CHARACTERS.find((x) => x.name === name || x.name.endsWith(name) || name.startsWith(x.name));
  const text = (c?.name ?? name).slice(0, 1);
  return <span className="bgx-owner" style={{ ['--c' as string]: bandColor(c?.band ?? band) }} title={`主人 ${name}`} data-testid="bg-owner"><i>{text}</i></span>;
}

/** The badge row of a card: band, place, time of day, category (not for plain scenes), stage, owner, duplicates. */
export function BgBadges({ bg, copies = 0, onCopies }: { bg: BackgroundEntry; copies?: number; onCopies?: () => void }) {
  const l = bg.labels;
  const cat = bgCategoryOf(bg);
  const place = l?.placeName ?? l?.location ?? bg.location;
  const time = bg.time ? (TIME_SHORT[bg.time] ?? bg.time) : null;
  return (
    <div className="bgx-badges">
      <BandBadge bands={l?.bands} />
      {place && <span className="bgx-badge bgx-place" data-testid="bg-place">{place}</span>}
      {time && <span className="bgx-badge bgx-time" data-testid="bg-time">{time}{bg.weather === '雨' ? '·雨' : ''}</span>}
      {cat !== 'scene' && <span className="bgx-badge bgx-cat" style={{ ['--c' as string]: CATEGORY_COLOR[cat] }} data-testid="bg-category">{CATEGORY_LABEL[cat]}</span>}
      {l?.stage && <span className="bgx-badge bgx-stage" data-testid="bg-stage">舞台</span>}
      {l?.owner && <OwnerDot name={l.owner.split('（')[0]!} {...(l.bands[0] ? { band: l.bands[0] } : {})} />}
      {copies > 0 && (
        <button type="button" className="bgx-badge bgx-dup" data-testid="bg-dup" title="点击展开 / 折叠同一画面的其它拷贝" onClick={(e) => { e.stopPropagation(); onCopies?.(); }}>同一画面 ×{copies + 1}</button>
      )}
    </div>
  );
}

export interface BgCardProps {
  bg: BackgroundEntry;
  selected?: boolean;
  /** Folded duplicate copies of this picture. */
  copies?: number;
  onCopies?: () => void;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  /** Show the review colour and the AI suggestion (workbench). */
  review?: boolean;
  /** A warning shown over the card (the picker's ⚠ with its reason). */
  warn?: string | null;
  testid?: string;
  className?: string;
  children?: React.ReactNode;
}

/** One background: thumbnail, bold title, one line of description (full text on hover), badges. */
export function BgCard({ bg, selected, copies = 0, onCopies, onClick, onDoubleClick, review, warn, testid = 'bg-card', className = '', children }: BgCardProps) {
  const r = reviewOf(bg);
  const sug = review ? suggestionText(bg.labels) : null;
  return (
    <figure
      className={`bgx-card ${selected ? 'selected' : ''} ${review ? `rv-${r}` : ''} ${className}`}
      data-testid={testid} data-bg-id={bg.id} data-selected={!!selected} data-review={r}
      style={review ? { ['--rv' as string]: REVIEW_COLOR[r] } : undefined}
      onClick={onClick} onDoubleClick={onDoubleClick}
    >
      <BgThumb bg={bg} />
      {review && <i className="bgx-dot" style={{ background: REVIEW_COLOR[r] }} title={REVIEW_LABEL[r]} data-testid="bg-review-dot" />}
      {warn && <span className="bgx-warn" title={warn} data-testid="bg-warn">⚠</span>}
      <figcaption>
        <div className="bgx-title" data-testid="bg-title" title={bg.name}>{bg.name}</div>
        <div className="bgx-desc" data-testid="bg-desc" title={bg.description ?? undefined}>{bg.description ?? ''}</div>
        <BgBadges bg={bg} copies={copies} {...(onCopies ? { onCopies } : {})} />
        {sug && <div className="bgx-sug" data-testid="bg-suggestion" title={sug}>{sug}</div>}
        {warn && <div className="bgx-warntext">{warn}</div>}
        {children}
      </figcaption>
    </figure>
  );
}
