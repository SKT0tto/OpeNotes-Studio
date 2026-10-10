/**
 * HUD of the original: one round menu button at the top right (Auto / Log / Skip / Hide UI live inside it) and the
 * rotating auto-play mark at the bottom right; plus the place-name banner shown over establishing shots
 * (STYLE_REFERENCE 7.2, 7.3). Sizes are shares of the stage height; the banner is a pure function of the
 * RenderState, so seeking into it shows the right frame.
 */
import type { RenderState, UiStyle } from '@shared/timeline/types';

export interface HudActions {
  /** Toggle automatic line advance; returns the new state. */
  toggleAuto(): boolean;
  /** Jump to the start of the next scene. */
  skip(): void;
  /** Lines shown so far. */
  log(): Array<{ name: string; text: string }>;
}

const FONT = '"Noto Sans SC","Source Han Sans SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif';
const hexRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

const AUTO_SVG =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 0-13.7-5.6"/><path d="M5.5 3.2v3.6h3.6"/><path d="M4 12a8 8 0 0 0 13.7 5.6"/><path d="M18.5 20.8v-3.6h-3.6"/></svg>';

export class HudLayer {
  readonly el = document.createElement('div');
  private readonly menu = document.createElement('button');
  private readonly pop = document.createElement('div');
  private readonly auto = document.createElement('div');
  private readonly banner = document.createElement('div');
  private readonly bannerText = document.createElement('span');
  private readonly logPanel = document.createElement('div');
  private readonly ro: ResizeObserver;
  private ui: UiStyle | null = null;
  private autoOn = true;
  private uiHidden = false;
  /** Dialogue area / black screen state that decides which buttons show; a change triggers a relayout. */
  private dialogShown = false;
  private blackout = false;
  private spin = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly actions: HudActions,
  ) {
    this.el.dataset.testid = 'hud';
    Object.assign(this.el.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', fontFamily: FONT });
    this.menu.dataset.testid = 'hud-menu';
    this.menu.setAttribute('aria-label', '菜单');
    this.menu.innerHTML = '<span></span><span></span><span></span>';
    this.pop.dataset.testid = 'hud-menu-pop';
    this.auto.dataset.testid = 'hud-auto';
    this.auto.innerHTML = AUTO_SVG;
    this.banner.dataset.testid = 'location-banner';
    this.banner.append(this.bannerText);
    this.logPanel.dataset.testid = 'hud-log';
    this.el.append(this.banner, this.auto, this.menu, this.pop, this.logPanel);
    host.appendChild(this.el);

    const stop = (e: Event) => e.stopPropagation();
    for (const n of [this.menu, this.pop, this.logPanel]) {
      n.addEventListener('click', stop);
      n.addEventListener('pointerdown', stop);
    }
    this.menu.addEventListener('click', () => {
      this.pop.style.display = this.pop.style.display === 'none' ? 'flex' : 'none';
      this.fillPop();
      this.relayout();
    });
    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(host);
    this.pop.style.display = 'none';
    this.logPanel.style.display = 'none';
  }

  private item(label: string, testid: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.testid = testid;
    b.addEventListener('click', () => {
      fn();
      this.fillPop();
    });
    return b;
  }

  private fillPop(): void {
    this.pop.replaceChildren(
      this.item(`自动播放：${this.autoOn ? '开' : '关'}`, 'hud-auto-toggle', () => (this.autoOn = this.actions.toggleAuto())),
      this.item('日志', 'hud-log-open', () => this.showLog()),
      this.item('跳过本场景', 'hud-skip', () => this.actions.skip()),
      this.item('隐藏界面', 'hud-hide-ui', () => {
        this.uiHidden = true;
        this.pop.style.display = 'none';
        this.relayout();
      }),
    );
  }

  private showLog(): void {
    const lines = this.actions.log();
    this.logPanel.replaceChildren(
      ...lines.map((l) => {
        const row = document.createElement('div');
        row.textContent = `${l.name ? `${l.name}：` : ''}${l.text}`;
        return row;
      }),
    );
    this.logPanel.style.display = 'block';
    this.pop.style.display = 'none';
    const close = () => {
      this.logPanel.style.display = 'none';
      window.removeEventListener('click', close, true);
    };
    setTimeout(() => window.addEventListener('click', close, true), 0);
    this.relayout();
  }

  /** Clicking the stage brings back a hidden interface. */
  get hidden(): boolean {
    return this.uiHidden;
  }
  restore(): void {
    if (this.uiHidden) {
      this.uiHidden = false;
      this.relayout();
    }
  }

  setAuto(on: boolean): void {
    this.autoOn = on;
    this.relayout();
  }

  update(state: RenderState): void {
    const dialogShown = state.subtitle !== null;
    const tr = state.transition;
    // pure black: a fade key at full strength, or the black phase of a dip / scene change lead-in
    const blackout = state.fade.alpha > 0.95 || (tr !== null && (tr.kind === 'scene_black' || tr.kind === 'dip_black') && tr.seconds >= tr.pause + tr.out - 1e-6);
    const changed = this.ui !== state.ui || this.dialogShown !== dialogShown || this.blackout !== blackout;
    this.ui = state.ui;
    this.dialogShown = dialogShown;
    this.blackout = blackout;
    if (changed) this.relayout();
    // The auto-play mark turns with the project clock: pausing stops it and seeking is consistent, at any refresh rate.
    if (this.autoOn) {
      this.spin = (state.t * state.ui.hud.autoSpinDegPerSec) % 360;
      this.auto.style.transform = `rotate(${this.spin}deg)`;
    }
    const loc = state.location;
    const l = state.ui.location;
    const H = this.host.clientHeight;
    if (!loc || H === 0 || state.ui.hud.hideUi || this.uiHidden) {
      this.banner.style.display = 'none';
      return;
    }
    const dist = l.slideDistance * H;
    const k = loc.phase === 'in' ? easeOut(loc.progress) : loc.phase === 'hold' ? 1 : 1 - loc.progress;
    const dx = loc.phase === 'in' ? (1 - k) * dist : loc.phase === 'out' ? -loc.progress * dist : 0;
    const a = hexRgb(l.color);
    const solid = ((l.fadeHalf - l.solidHalf) / (2 * l.fadeHalf)) * 100;
    this.bannerText.textContent = loc.text;
    this.banner.style.cssText = `position:absolute;display:flex;align-items:center;justify-content:center;left:50%;top:${(l.centerY - l.height / 2) * H}px;height:${l.height * H}px;width:${2 * l.fadeHalf * H}px;transform:translateX(calc(-50% + ${dx}px));opacity:${k};background:linear-gradient(to right,rgba(${a},0) 0%,rgba(${a},${l.alpha}) ${solid}%,rgba(${a},${l.alpha}) ${100 - solid}%,rgba(${a},0) 100%)`;
    this.bannerText.style.cssText = `color:${l.textColor};font-size:${l.textSize * H}px;line-height:1;font-weight:500;letter-spacing:.06em;-webkit-text-stroke:${Math.max(1, (2 * H) / 1080)}px ${l.strokeColor};paint-order:stroke fill;text-shadow:0 ${Math.max(1, H / 540)}px ${Math.max(2, H / 270)}px rgba(0,0,0,.45)`;
  }

  private relayout(): void {
    const ui = this.ui;
    const H = this.host.clientHeight;
    if (!ui || H === 0) return;
    const h = ui.hud;
    const W = this.host.clientWidth;
    const hide = h.hideUi || this.uiHidden;
    const d = h.menuDiameter * H;
    this.menu.style.cssText = `position:absolute;pointer-events:auto;display:${h.menuVisible && !hide && !(h.menuHideOnBlack && this.blackout) ? 'flex' : 'none'};flex-direction:column;align-items:center;justify-content:center;gap:${d * 0.1}px;width:${d}px;height:${d}px;left:${W - h.menuRight * H - d / 2}px;top:${h.menuTop * H - d / 2}px;border-radius:50%;padding:0;cursor:pointer;background:linear-gradient(to bottom,${h.menuColorTop},${h.menuColorBottom});border:${Math.max(1, (2 * H) / 1080)}px solid ${h.menuRing}`;
    for (const bar of Array.from(this.menu.children) as HTMLElement[]) bar.style.cssText = `display:block;width:${d * 0.42}px;height:${Math.max(2, d * 0.055)}px;border-radius:2px;background:#fff`;
    this.pop.style.cssText = `position:absolute;pointer-events:auto;display:${this.pop.style.display === 'none' || hide ? 'none' : 'flex'};flex-direction:column;gap:2px;left:${W - h.menuRight * H - d / 2 - 2.2 * d}px;top:${(h.menuTop + h.menuDiameter / 2 + 0.01) * H}px;width:${3.2 * d}px;padding:${0.006 * H}px;border-radius:${0.012 * H}px;background:rgba(26,16,48,.92);border:1px solid ${h.menuRing}`;
    for (const b of Array.from(this.pop.children) as HTMLElement[]) b.style.cssText = `all:unset;cursor:pointer;color:#fff;font-size:${0.026 * H}px;padding:${0.008 * H}px ${0.012 * H}px;border-radius:4px;font-family:${FONT}`;
    const ad = h.autoDiameter * H;
    this.auto.style.cssText = `position:absolute;display:${h.autoVisible && !hide && (!h.autoFollowsDialog || this.dialogShown) ? 'block' : 'none'};width:${ad}px;height:${ad}px;left:${W - h.autoRight * H - ad / 2}px;top:${h.autoTop * H - ad / 2}px;opacity:${h.autoAlpha * (this.autoOn ? 1 : 0.45)};transform:rotate(${this.spin}deg)`;
    this.logPanel.style.cssText = `position:absolute;pointer-events:auto;display:${this.logPanel.style.display === 'none' || hide ? 'none' : 'block'};left:${0.4 * H}px;right:${0.4 * H}px;top:${0.1 * H}px;bottom:${0.2 * H}px;overflow:auto;padding:${0.02 * H}px;border-radius:${0.015 * H}px;background:rgba(26,16,48,.9);color:#fff;font-size:${0.028 * H}px;line-height:1.6`;
  }

  dispose(): void {
    this.ro.disconnect();
    this.el.remove();
  }
}
