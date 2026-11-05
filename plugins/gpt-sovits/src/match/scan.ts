/** Reads a GPT-SoVITS install folder: trained weights and reference audio (with the text each reference says). */
import fs from 'node:fs';
import path from 'node:path';
import { mp3Seconds } from './mp3';
import { runOf, stemOf, stripTags, versionIn } from './names';
import { splitBareTag } from './tags';

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
  /** The experiment: file name before `-e<N>` / `_e<N>` (GPT and SoVITS of one training run share it). */
  stem: string;
  /** Model version, lowercase (`v4`): from the SoVITS file's first two bytes, else from a version in the folder names; '' when unknown. */
  version: string;
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
  /** The name starts with a run of Chinese the tag list did not resolve (simplified characters): the text is probably not Japanese. */
  textSuspect?: boolean;
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

const RVC = /rvc/i;

function walk(dir: string, depth: number, out: string[], skipRvc = false): void {
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
    if (e.isDirectory()) {
      if (skipRvc && RVC.test(e.name)) continue; // RVC voice-conversion models also end in .pth
      walk(full, depth + 1, out, skipRvc);
    }
    else if (e.isFile()) out.push(full);
  }
}

const familyOf = (folder: string, prefix: string): string => folder.slice(prefix.length).replace(/^[_-]+/, '') || 'v1';

/** First two bytes of a SoVITS .pth -> model version (`head2version` in GPT-SoVITS process_ckpt.py); '' for a plain torch zip or unknown. */
const HEAD2VERSION: Record<string, string> = { '00': 'v1', '01': 'v2', '02': 'v3', '03': 'v3', '04': 'v4', '05': 'v2pro', '06': 'v2proplus', '07': 'v5dev', '08': 'v5turbo' };
export function sovitsVersion(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    const n = fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return n === 2 ? HEAD2VERSION[buf.toString('latin1')] ?? '' : '';
  } catch {
    return '';
  }
}

function weightOf(root: string, base: string, f: string, family: string, names: readonly string[], seen: Set<string>): WeightFile | null {
  const key = path.resolve(f).toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key);
  const parts = path.relative(base, f).split(path.sep);
  const run = runOf(path.basename(f));
  let mtime = 0;
  try {
    mtime = fs.statSync(f).mtimeMs;
  } catch { /* unreadable */ }
  const version = (/\.pth$/i.test(f) ? sovitsVersion(f) : '') || versionIn(names.join(' '));
  return { path: f, rel: path.relative(root, f).split(path.sep).join('/'), parts, family, epoch: run.epoch, step: run.step, mtime, stem: stemOf(path.basename(f)), version };
}

function weights(root: string, prefixRe: RegExp, prefix: string, ext: RegExp, seen: Set<string>): WeightFile[] {
  const out: WeightFile[] = [];
  let top: string[];
  try {
    top = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && prefixRe.test(d.name) && !RVC.test(d.name)).map((d) => d.name);
  } catch {
    return out;
  }
  for (const folder of top) {
    const files: string[] = [];
    walk(path.join(root, folder), 0, files, true);
    for (const f of files) {
      if (!ext.test(f)) continue;
      const w = weightOf(root, path.join(root, folder), f, familyOf(folder, prefix), [folder], seen);
      if (w) out.push(w);
    }
  }
  return out;
}

/** Weights that sit in a reference folder the person added (a downloaded pack kept where it is). GPT and SoVITS of one folder form one family. */
function extraWeights(root: string, dirs: readonly string[], ext: RegExp, seen: Set<string>): WeightFile[] {
  const out: WeightFile[] = [];
  for (const dir of dirs) {
    if (RVC.test(path.basename(dir))) continue;
    const files: string[] = [];
    walk(dir, 0, files, true);
    for (const f of files) {
      if (!ext.test(f)) continue;
      const w = weightOf(root, dir, f, `pack:${path.basename(dir)}`, [path.basename(dir)], seen);
      if (w) out.push(w);
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
      let tag = /【([^】]*)】/.exec(raw)?.[1] ?? '';
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
      let base = stripTags(raw);
      const bare = splitBareTag(base);
      const suspect = bare.suspect;
      if (bare.tag) tag = tag || bare.tag;
      base = bare.rest;
      if (!text && looksLikeSentence(base)) {
        text = base;
        textFrom = 'filename';
      }
      out.push({ path: f, rel: path.relative(root, f).split(path.sep).join('/'), folders, base, text, lang: lang || (text ? guessLang(text) : ''), seconds: /\.wav$/i.test(f) ? wavLength(f) : /\.mp3$/i.test(f) ? mp3Seconds(f) : null, tag, ...(suspect && textFrom === 'filename' ? { textSuspect: true } : {}), textFrom });
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
  const seen = new Set<string>();
  const extra = [...new Set(extraRefDirs.filter((e) => e.trim() && fs.existsSync(e)).map((e) => path.resolve(e)))];
  const gpt = weights(root, /^GPT_weights/i, 'GPT_weights', /\.ckpt$/i, seen);
  const sovits = weights(root, /^SoVITS_weights/i, 'SoVITS_weights', /\.pth$/i, seen);
  gpt.push(...extraWeights(root, extra, /\.ckpt$/i, seen));
  sovits.push(...extraWeights(root, extra, /\.pth$/i, seen));
  if (gpt.length === 0 && sovits.length === 0) warnings.push('没有在 GPT_weights* / SoVITS_weights* 里找到 .ckpt / .pth 权重');
  return { gpt, sovits, refs: refs(root, refFolders(root, extraRefDirs)), warnings };
}
