/**
 * Storyboard thumbnails. One picture per line, taken from the live player at the middle of the line (the player seeks,
 * the finished frame is copied into a 320x180 canvas). Pictures are cached by the compiled scene they came from, so any
 * edit that changes a scene's compile result invalidates exactly that scene's thumbnails. One picture per pass of the
 * queue, the preview is restored afterwards, and nothing runs while the player is playing.
 */
import { useEffect, useState } from 'react';
import type { CompiledScene } from '@shared/timeline/types';
import type { usePlayerHost } from '../../play/usePlayerHost';

type Host = ReturnType<typeof usePlayerHost>;
export const THUMB_W = 320;
export const THUMB_H = 180;
const MAX_CACHED = 600;

const isBlack = (c: HTMLCanvasElement): boolean => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4 * 97) if (d[i]! + d[i + 1]! + d[i + 2]! > 24) return false;
  return true;
};

const cache = new Map<string, string>();
const sigs = new WeakMap<CompiledScene, string>();

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
const sigOf = (s: CompiledScene): string => {
  let v = sigs.get(s);
  if (!v) sigs.set(s, (v = hash(JSON.stringify(s))));
  return v;
};
export const thumbKey = (s: CompiledScene, beatId: string) => `${s.id}|${beatId}|${sigOf(s)}`;
export const cachedThumb = (s: CompiledScene, beatId: string): string | undefined => cache.get(thumbKey(s, beatId));

/** Fill the thumbnail cache for every stored line while `active`; returns progress and a version that changes per new picture. */
export function useThumbnails(host: Host, storedKey: string, active: boolean): { version: number; pending: number } {
  const { compiled, ready, playerRef, playing } = host;
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const player = playerRef.current;
    if (!active || !ready || !player || !compiled || playing) return;
    const storedIds = new Set(storedKey.split(','));
    const todo = compiled.scenes.flatMap((s) => s.beats.filter((b) => storedIds.has(b.id) && !cache.has(thumbKey(s, b.id))).map((b) => ({ s, b })));
    setPending(todo.length);
    if (todo.length === 0) return;
    let dead = false;
    const t0 = player.t;
    (async () => {
      for (const [n, { s, b }] of todo.entries()) {
        if (dead) return;
        const mid = (b.start + b.end) / 2;
        let canvas = await player.grab(mid, THUMB_W, THUMB_H);
        // a frame grabbed while the scene was still being (re)entered is black: look once more before believing it
        if (isBlack(canvas)) {
          await new Promise((r) => setTimeout(r, 300));
          canvas = await player.grab(mid, THUMB_W, THUMB_H);
        }
        if (dead || player.compiled.scenes[s.index] === undefined || sigOf(player.compiled.scenes[s.index]!) !== sigOf(s)) return;
        cache.set(thumbKey(s, b.id), canvas.toDataURL('image/jpeg', 0.82));
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
        setPending(todo.length - n - 1);
        setVersion((v) => v + 1);
        await new Promise((r) => requestAnimationFrame(r));
      }
    })()
      .catch((e) => console.error('thumbnail failed', e))
      .finally(() => {
        if (!dead) void player.seek(t0);
      });
    return () => {
      dead = true;
      void player.seek(t0);
    };
  }, [active, ready, compiled, playing, playerRef, storedKey]);
  return { version, pending };
}
