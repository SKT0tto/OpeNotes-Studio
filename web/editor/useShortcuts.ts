/** Keyboard shortcuts of the workspace (the table is shown by the `?` sheet; keep both in sync). */
import { useEffect, useRef } from 'react';
import type { usePlayerHost } from '../play/usePlayerHost';
import { copyKeys, deleteBeat, deleteKeys, pasteKeys } from '../store/actions';
import { useProject } from '../store/projectStore';
import { useUi } from '../store/uiStore';

type Host = ReturnType<typeof usePlayerHost>;

export const SHORTCUTS: Array<[string, string]> = [
  ['空格', '播放 / 暂停（逐句模式：播放中进入下一句）'],
  ['K', '暂停'],
  ['L', '播放；连按加速 1× / 2× / 4×'],
  ['J', '倒放（逐步回跳）；连按加速'],
  ['← / →', '后退 / 前进一帧（Shift：1 秒）'],
  ['↑ / ↓', '上一句 / 下一句'],
  ['Home / End', '回到开头 / 结尾'],
  ['Ctrl+Z', '撤销'],
  ['Ctrl+Y / Ctrl+Shift+Z', '重做'],
  ['Ctrl+S', '保存'],
  ['Delete', '删除选中的关键帧 / 分镜卡片 / 剧本中的台词'],
  ['Ctrl+C / Ctrl+V', '复制关键帧 / 在播放头粘贴'],
  ['V / C', '选择工具 / 相机工具'],
  ['Esc', '取消选择'],
  ['?', '打开这份快捷键表'],
];

const isTyping = (el: EventTarget | null): boolean => {
  const e = el as HTMLElement | null;
  if (!e) return false;
  if (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable) return true;
  if (e.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes((e as HTMLInputElement).type);
  return false;
};

export function useShortcuts(host: Host, fps: number): void {
  const live = useRef({ host, fps });
  const reverse = useRef<{ timer: ReturnType<typeof setInterval>; speed: number } | null>(null);
  useEffect(() => {
    live.current = { host, fps };
  });

  useEffect(() => {
    const stopReverse = () => {
      if (reverse.current) clearInterval(reverse.current.timer);
      reverse.current = null;
    };
    const setRate = (r: number) => {
      useUi.getState().set({ rate: r });
      const p = live.current.host.playerRef.current;
      if (p) p.rate = r;
    };
    const onKey = (e: KeyboardEvent) => {
      const { host: h, fps: rate } = live.current;
      const st = useProject.getState();
      const ui = useUi.getState();
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        if (k === 'z' && !e.shiftKey) st.undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') st.redo();
        else if (k === 's') void st.save();
        else if ((k === 'c' || k === 'v') && !isTyping(e.target)) {
          const sceneId = st.selection.sceneId;
          if (!sceneId) return;
          if (k === 'c') copyKeys(sceneId, ui.keySel);
          else pasteKeys(sceneId, h.info.t);
        } else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target) || e.altKey) return;
      const p = h.playerRef.current;
      const go = (t: number) => h.seek(Math.min(h.info.duration, Math.max(0, t)));
      const target = e.target as HTMLElement;
      const beats = (): Array<{ id: string; start: number }> => p?.compiled.scenes.flatMap((s) => s.beats) ?? [];
      switch (e.key) {
        case ' ':
          target.blur?.();
          stopReverse();
          if (!h.auto && p?.isPlaying) h.advance();
          else h.toggle();
          break;
        case 'k': case 'K':
          stopReverse();
          if (p?.isPlaying) h.toggle();
          break;
        case 'l': case 'L':
          stopReverse();
          if (p?.isPlaying) setRate(p.rate >= 4 ? 1 : p.rate * 2);
          else {
            setRate(1);
            h.toggle();
          }
          break;
        case 'j': case 'J': {
          if (p?.isPlaying) h.toggle();
          const speed = reverse.current ? Math.min(4, reverse.current.speed * 2) : 1;
          stopReverse();
          reverse.current = {
            speed,
            timer: setInterval(() => {
              const t = live.current.host.playerRef.current?.t ?? 0;
              if (t <= 0) stopReverse();
              else go(t - 0.25 * speed);
            }, 250),
          };
          break;
        }
        case 'ArrowLeft': case 'ArrowRight': {
          stopReverse();
          const d = e.shiftKey ? 1 : 1 / rate;
          go((p?.t ?? h.info.t) + (e.key === 'ArrowLeft' ? -d : d));
          break;
        }
        case 'ArrowUp': case 'ArrowDown': {
          const t = p?.t ?? h.info.t;
          const list = beats();
          const next = e.key === 'ArrowDown' ? list.find((b) => b.start > t + 0.02) : [...list].reverse().find((b) => b.start < t - 0.02);
          if (next) go(next.start);
          break;
        }
        case 'Home': go(0); break;
        case 'End': go(h.info.duration); break;
        case 'Delete': case 'Backspace': {
          const sceneId = st.selection.sceneId;
          if (!sceneId) return;
          if (ui.keySel.length > 0) deleteKeys(sceneId, ui.keySel);
          else if (ui.centerView === 'storyboard' && ui.cards.length > 0) {
            for (const id of ui.cards) {
              const owner = st.project?.scenes.find((s) => s.beats.some((b) => b.id === id));
              if (owner) deleteBeat(owner.id, id);
            }
            ui.set({ cards: [] });
          } else if (st.selection.beatId && document.activeElement?.closest('.ws-left')) deleteBeat(sceneId, st.selection.beatId);
          else return;
          break;
        }
        case 'v': case 'V': ui.set({ tool: 'select' }); break;
        case 'c': case 'C': ui.set({ tool: 'camera' }); break;
        case 'Escape': ui.set({ keySel: [], cards: [], helpOpen: false }); st.select({ castId: null }); break;
        case '?': ui.set({ helpOpen: !ui.helpOpen }); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stopReverse();
    };
  }, []);
}
