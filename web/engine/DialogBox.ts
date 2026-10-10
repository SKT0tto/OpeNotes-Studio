/**
 * Dialogue area. Default theme "ournotes" follows the original: no frame, a full-width deep-purple gradient at the
 * bottom, a plain white name, a thin fading rule under it and the text (STYLE_REFERENCE 7.1). Theme "plate" is the
 * earlier rounded panel with a coloured name plate. Every size is a share of the stage height, so it scales with the
 * preview; the reveal itself is time-driven by evaluate(), so seeking shows exactly the right amount of text.
 */
import type { SubtitleRender, UiStyle } from '@shared/timeline/types';

export interface Speaker {
  name: string;
  /** CSS colour of the name plate (plate theme only). */
  color: string;
}

const FONT = '"Noto Sans SC","Source Han Sans SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif';

const hexRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

export class DialogBox {
  readonly el = document.createElement('div');
  private readonly grad = document.createElement('div');
  private readonly name = document.createElement('div');
  private readonly baseline = document.createElement('i');
  private readonly rule = document.createElement('div');
  private readonly text = document.createElement('div');
  private readonly marker = document.createElement('div');
  private readonly ro: ResizeObserver;
  private ui: UiStyle['dialog'] | null = null;
  private shown = '';
  private hasName = false;
  private laidOutH = 0;
  private plateColor = '#888';

  constructor(
    private readonly host: HTMLElement,
    private readonly speakerOf: (castId: string | null) => Speaker | null,
  ) {
    this.el.dataset.testid = 'dialog';
    this.grad.dataset.part = 'gradient';
    this.name.dataset.part = 'name';
    this.rule.dataset.part = 'rule';
    this.text.dataset.part = 'text';
    this.baseline.dataset.part = 'baseline';
    this.marker.dataset.part = 'next';
    this.marker.textContent = '▼';
    this.name.append(document.createTextNode(''), this.baseline);
    this.el.append(this.grad, this.name, this.rule, this.text, this.marker);
    Object.assign(this.el.style, { position: 'absolute', inset: '0', pointerEvents: 'none', display: 'none', overflow: 'hidden', fontFamily: FONT });
    Object.assign(this.baseline.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
    host.appendChild(this.el);
    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(host);
  }

  /** Names shown for a beat: "A & B" for co-speakers, "<name>的声音" for off-screen voices. */
  private nameOf(sub: SubtitleRender, d: UiStyle['dialog']): { text: string; color: string } | null {
    if (sub.kind !== 'dialogue') return null;
    const main = this.speakerOf(sub.speakerId);
    if (!main) return null;
    const all = [main, ...sub.coSpeakers.map((id) => this.speakerOf(id)).filter((x): x is Speaker => !!x)];
    let text = all.map((s) => s.name).join(d.multiSeparator);
    if (sub.variant === 'offscreen') text = d.offscreenNameTemplate.replace('{name}', text);
    return { text, color: main.color };
  }

  /** `glow` (0..1) is the memory-glow strength on screen: the gradient fades towards `fx.glowDialogAlpha` of its opacity. */
  update(sub: SubtitleRender | null, ui: UiStyle, revealAll = false, glow = 0): void {
    const d = ui.dialog;
    // Shown for the whole line (gradient, name and rule from its first frame, text typing in); hiding is up to compile's hiddenDialog.
    if (ui.hud.hideUi || !sub) {
      this.el.style.display = 'none';
      return;
    }
    const wasHidden = this.el.style.display === 'none';
    this.el.style.display = '';
    const nm = this.nameOf(sub, d);
    // Layout only when something that shapes it changed (style, name present, size): not on every frame / typed character.
    const relayout = wasHidden || this.ui !== d || this.hasName !== !!nm || this.laidOutH !== this.host.clientHeight;
    this.ui = d;
    this.hasName = !!nm;
    this.plateColor = nm?.color ?? '#888';
    this.name.firstChild!.textContent = nm?.text ?? '';
    const count = revealAll ? sub.totalChars : sub.visibleChars;
    const chars = [...sub.text];
    const wrap = sub.variant === 'monologue' && d.monologueBrackets && !/^[（(]/.test(sub.text);
    this.shown = chars.slice(0, count).join('');
    if (wrap) this.shown = `（${this.shown}${count >= sub.totalChars ? '）' : ''}`;
    this.text.textContent = this.shown;
    this.el.dataset.theme = d.theme;
    this.el.dataset.kind = sub.kind;
    this.marker.hidden = count < sub.totalChars;
    if (relayout) this.relayout();
    this.grad.style.opacity = String(1 - (1 - ui.fx.glowDialogAlpha) * Math.min(1, Math.max(0, glow)));
  }

  /** Position everything from the style values (shares of the stage height) and the host's current size. */
  private relayout(): void {
    const d = this.ui;
    const H = this.host.clientHeight;
    if (!d || H === 0 || this.el.style.display === 'none') return;
    this.laidOutH = H;
    const px = (v: number) => `${v * H}px`;
    // Wider than 16:9: the text column keeps its place relative to the 16:9 centre area instead of hugging the left edge.
    const ox = Math.max(0, (this.host.clientWidth - (H * 16) / 9) / 2);
    const pxl = (v: number) => `${v * H + ox}px`;
    const shadow = `0 ${Math.max(1, H / 1080)}px ${Math.max(2, (2 * H) / 1080)}px rgba(0,0,0,${d.shadowAlpha})`;
    if (d.theme === 'plate') {
      this.layoutPlate(px, shadow);
      return;
    }
    const rgb = hexRgb(d.color);
    const full = ((d.gradientY1 - d.gradientY0) / (1 - d.gradientY0)) * 100;
    this.marker.style.cssText = 'display:none';
    this.grad.style.cssText = `position:absolute;left:0;right:0;top:${px(d.gradientY0)};bottom:0;background:linear-gradient(to bottom,rgba(${rgb},0) 0%,rgba(${rgb},${d.maxAlpha}) ${full}%,rgba(${rgb},${d.maxAlpha}) 100%)`;
    this.name.style.cssText = `position:absolute;display:${this.hasName ? 'block' : 'none'};left:${pxl(d.nameLeft)};top:0;font-size:${px(d.nameSize)};line-height:${px(d.nameSize)};font-weight:${d.nameWeight};color:${d.nameColor};white-space:nowrap;text-shadow:${shadow}`;
    this.rule.style.cssText = `position:absolute;display:${this.hasName ? 'block' : 'none'};left:${pxl(d.ruleLeft)};top:${px(d.ruleY)};width:${px(d.ruleLength)};height:${Math.max(1, d.ruleThickness * H)}px;background:linear-gradient(to right,${d.ruleColor} 0%,${d.ruleColor} 55%,rgba(${hexRgb(d.ruleColor)},0) 100%)`;
    this.text.style.cssText = `position:absolute;left:${pxl(d.textLeft)};top:${px(d.textTop)};width:${px(d.textWidth)};max-height:${px(d.lineHeight * d.maxLines)};overflow:hidden;font-size:${px(d.textSize)};line-height:${px(d.lineHeight)};font-weight:${d.textWeight};color:#fff;white-space:pre-wrap;word-break:break-all;text-shadow:${shadow}`;
    // Exact baseline: measure where the zero-size inline box of the name sits, then shift the name onto the style's baseline y.
    if (this.hasName) {
      const off = this.baseline.getBoundingClientRect().bottom - this.name.getBoundingClientRect().top;
      this.name.style.top = `${d.nameBaseline * H - off}px`;
    }
  }

  private layoutPlate(px: (v: number) => string, shadow: string): void {
    this.grad.style.cssText = `position:absolute;left:6%;right:6%;bottom:5%;height:${px(0.2)};border-radius:${px(0.013)};background:linear-gradient(180deg,rgba(34,40,62,.82),rgba(20,24,40,.9));border:1.5px solid rgba(255,255,255,.55);box-shadow:0 6px 24px rgba(0,0,0,.45)`;
    this.name.style.cssText = `position:absolute;display:${this.hasName ? 'block' : 'none'};left:9%;bottom:${px(0.23)};padding:.2em 1.4em;border-radius:999px 999px 999px 4px;background:${this.plateColor};color:#fff;font-weight:700;font-size:${px(0.03)};letter-spacing:.08em;border:2px solid rgba(255,255,255,.85);text-shadow:${shadow}`;
    this.rule.style.cssText = 'display:none';
    this.text.style.cssText = `position:absolute;left:10%;right:10%;bottom:${px(0.07)};font-size:${px(0.034)};line-height:1.6;letter-spacing:.04em;color:#fff;white-space:pre-wrap;text-shadow:${shadow}`;
    this.marker.style.cssText = `position:absolute;right:8%;bottom:${px(0.075)};font-size:${px(0.026)};color:#fff`;
  }

  get visibleText(): string {
    return this.shown;
  }

  dispose(): void {
    this.ro.disconnect();
    this.el.remove();
  }
}
