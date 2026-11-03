/** Reads a GPT-SoVITS install folder: trained weights and reference audio (with the text each reference says). */
import fs from 'node:fs';
import path from 'node:path';
import { runOf, stripTags } from './names';

export interface WeightFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the install folder (what the AI sees). */
  rel: string;
  /** Names between the weights folder and the file (a per-character subfolder), then the file name. */
  parts: string[];
  /** Version family from the folder name: `GPT_weights_v2Pro` -> v2Pro; a bare `GPT_weights` is v1. */
  family: string;
  epoch: number;
  step: number;
  mtime: number;
}
export interface RefFile {
  path: string;
  rel: string;
  /** Folders between the reference folder and the file (a per-character subfolder). */
  folders: string[];
  /** File name without extension, emotion tags removed. */
  base: string;
  text: string;
  lang: string;
  seconds: number | null;
  /** The emotion tag in the file name, if any. */
  tag: string;
  textFrom: 'txt' | 'list' | 'filename' | 'none';
}
export interface Scan {
  gpt: WeightFile[];
  sovits: WeightFile[];
  refs: RefFile[];
  warnings: string[];
}

const AUDIO = /\.(wav|mp3|flac|ogg)$/i;
const MAX_FILES = 6000;
const MAX_DEPTH = 5;

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (/^pretrained_models$/i.test(e.name)) continue;
    if (e.isDirectory()) walk(full, depth + 1, out);
    else if (e.isFile()) out.push(full);
  }
}

const familyOf = (folder: string, prefix: string): string => folder.slice(prefix.length).replace(/^[_-]+/, '') || 'v1';

function weights(root: string, prefixRe: RegExp, prefix: string, ext: RegExp): WeightFile[] {
  const out: WeightFile[] = [];
  let top: string[];
  try {
    top = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && prefixRe.test(d.name)).map((d) => d.name);
  } catch {
    return out;
  }
  for (const folder of top) {
    const files: string[] = [];
    walk(path.join(root, folder), 0, files);
    for (const f of files) {
      if (!ext.test(f)) continue;
      const parts = path.relative(path.join(root, folder), f).split(path.sep);
      const run = runOf(path.basename(f));
      let mtime = 0;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch { /* unreadable */ }
      out.push({ path: f, rel: path.relative(root, f).split(path.sep).join('/'), parts, family: familyOf(folder, prefix), epoch: run.epoch, step: run.step, mtime });
    }
  }
  return out;
}

/** `.list` lines: `path|speaker|lang|text`, by file name. */
function readLists(files: string[]): Map<string, { text: string; lang: string }> {
  const map = new Map<string, { text: string; lang: string }>();
  for (const f of files.filter((x) => /\.list$/i.test(x))) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const cols = line.split('|');
      if (cols.length < 4) continue;
      const [p, , lang, ...rest] = cols;
      const t = rest.join('|').trim();
      if (!p || !t) continue;
      map.set(path.basename(p.trim().replace(/\\/g, '/')).toLowerCase(), { text: t, lang: (lang ?? '').trim().toLowerCase() });
    }
  }
  return map;
}

const KANA = /[぀-ヿ]/;
const CJK = /[㐀-鿿]/;
export const guessLang = (text: string): string => (KANA.test(text) ? 'ja' : CJK.test(text) ? 'zh' : /[a-z]/i.test(text) ? 'en' : 'ja');

/** A file name that reads like something said rather than a label (`tomori_01`, `ref3`). */
export function looksLikeSentence(s: string): boolean {
  const t = s.trim();
  if ([...t].length < 4) return false;
  if (KANA.test(t) || CJK.test(t)) return true;
  return /\s/.test(t) && /[a-z]{2,}\s+[a-z]{2,}/i.test(t);
}

/** Seconds of a PCM wav from its 44-byte header and the file size (no decoding); null when unknown. */
function wavLength(file: string): number | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(44);
    const n = fs.readSync(fd, buf, 0, 44, 0);
    fs.closeSync(fd);
    if (n < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    const byteRate = buf.readUInt32LE(28);
    return byteRate > 0 ? Math.max(0, fs.statSync(file).size - 44) / byteRate : null;
  } catch {
    return null;
  }
}

function refs(root: string, dirs: string[]): RefFile[] {
  const out: RefFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const files: string[] = [];
    walk(dir, 0, files);
    const lists = readLists(files);
    for (const f of files) {
      if (!AUDIO.test(f) || seen.has(f)) continue;
      seen.add(f);
      // a folder the user added may itself be named after the character
      const own = /^(ref|参考音频)/i.test(path.basename(dir)) ? [] : [path.basename(dir)];
      const folders = [...own, ...path.relative(dir, f).split(path.sep).slice(0, -1)];
      const raw = path.basename(f).replace(/\.[^.]+$/, '');
      const tag = /【([^】]*)】/.exec(raw)?.[1] ?? '';
      let text = '';
      let lang = '';
      let textFrom: RefFile['textFrom'] = 'none';
      for (const ext of ['.txt', '.lab']) {
        try {
          const t = fs.readFileSync(f.replace(/\.[^.]+$/, ext), 'utf8').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
          if (t) {
            text = t;
            textFrom = 'txt';
            break;
          }
        } catch { /* none */ }
      }
      if (!text) {
        const l = lists.get(path.basename(f).toLowerCase());
        if (l) {
          text = l.text;
          lang = l.lang;
          textFrom = 'list';
        }
      }
      const base = stripTags(raw);
      if (!text && looksLikeSentence(base)) {
        text = base;
        textFrom = 'filename';
      }
      out.push({ path: f, rel: path.relative(root, f).split(path.sep).join('/'), folders, base, text, lang: lang || (text ? guessLang(text) : ''), seconds: /\.wav$/i.test(f) ? wavLength(f) : null, tag, textFrom });
    }
  }
  return out;
}

/** Folders that hold reference audio: `ref*`, `参考音频*` under the install folder, and the extra folders. */
export function refFolders(root: string, extra: readonly string[]): string[] {
  const dirs: string[] = [];
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && (/^ref/i.test(d.name) || /^参考音频/.test(d.name))) dirs.push(path.join(root, d.name));
  } catch { /* unreadable root */ }
  for (const e of extra) if (e.trim() && fs.existsSync(e)) dirs.push(path.resolve(e));
  return [...new Set(dirs)];
}

export function scanInstall(root: string, extraRefDirs: readonly string[] = []): Scan {
  const warnings: string[] = [];
  if (!root.trim()) throw new Error('还没有填 GPT-SoVITS 文件夹');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`找不到文件夹：${root}（自动匹配只能在 GPT-SoVITS 和本软件在同一台电脑上时使用）`);
  const gpt = weights(root, /^GPT_weights/i, 'GPT_weights', /\.ckpt$/i);
  const sovits = weights(root, /^SoVITS_weights/i, 'SoVITS_weights', /\.pth$/i);
  if (gpt.length === 0 && sovits.length === 0) warnings.push('没有在 GPT_weights* / SoVITS_weights* 里找到 .ckpt / .pth 权重');
  return { gpt, sovits, refs: refs(root, refFolders(root, extraRefDirs)), warnings };
}
