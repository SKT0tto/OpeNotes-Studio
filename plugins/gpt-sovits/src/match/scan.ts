/** Reads a GPT-SoVITS install folder: trained weights and reference audio (with the text each reference says). */
import fs from 'node:fs';
import path from 'node:path';
import { cleanPath } from '../paths';
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
  /** What each scanned folder held (for explaining an empty result). */
  report: ScanReport[];
  /** The folders that were scanned (the only places a reference clip may be streamed from). */
  dirs: string[];
}

const AUDIO = /\.(wav|mp3|flac|ogg)$/i;
/** Weights, audio and the text files that sit next to audio. Everything else is not looked at (and is not counted). */
const WANTED = /\.(ckpt|pth|wav|mp3|flac|ogg|list|txt|lab)$/i;
/** Weights and audio per scanned folder (each folder has its own budget: a big install cannot use up the budget of a pack). */
const MAX_FILES = 6000;
/** Directory entries looked at per scanned folder (a guard for trees that hold very many files of no interest). */
const MAX_ENTRIES = 60000;
const MAX_DEPTH = 5;

const RVC = /rvc/i;
/** Trees that never hold models or references (pretrained base models, a bundled Python, tools, caches, logs). */
const SKIP_DIR = /^(pretrained_models|runtime|tools|node_modules|__pycache__|site-packages|\.git|\.?venv|temp|tmp|logs?|output|\$recycle\.bin|system volume information)$/i;
/** A GPT-SoVITS install also keeps its own source here. */
const INSTALL_CODE_DIR = /^(GPT_SoVITS|GPT-SoVITS|tools|docs|i18n)$/i;

export interface Collected { files: string[]; counted: number; entries: number; truncated: boolean }

function walk(dir: string, depth: number, c: Collected, opts: { skipRvc: boolean; skip?: RegExp }): void {
  if (depth > MAX_DEPTH || c.counted >= MAX_FILES || c.entries >= MAX_ENTRIES) {
    if (c.counted >= MAX_FILES || c.entries >= MAX_ENTRIES) c.truncated = true;
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    c.entries++;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name) || opts.skip?.test(e.name)) continue;
      if (opts.skipRvc && RVC.test(e.name)) continue; // RVC voice-conversion models also end in .pth
      walk(full, depth + 1, c, opts);
    } else if (e.isFile() && WANTED.test(e.name)) {
      c.files.push(full);
      if (!/\.(list|txt|lab)$/i.test(e.name)) c.counted++;
    }
  }
}

/** The weights / audio / text files under `dir`. */
export function collect(dir: string, opts: { skipRvc?: boolean; skip?: RegExp } = {}): Collected {
  const c: Collected = { files: [], counted: 0, entries: 0, truncated: false };
  walk(dir, 0, c, { skipRvc: opts.skipRvc ?? false, ...(opts.skip ? { skip: opts.skip } : {}) });
  return c;
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

function weightOf(base: string, f: string, family: string, names: readonly string[], seen: Set<string>, lead: readonly string[], rel: string): WeightFile | null {
  const key = path.resolve(f).toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key);
  const parts = [...lead, ...path.relative(base, f).split(path.sep)];
  const run = runOf(path.basename(f));
  let mtime = 0;
  try {
    mtime = fs.statSync(f).mtimeMs;
  } catch { /* unreadable */ }
  const version = (/\.pth$/i.test(f) ? sovitsVersion(f) : '') || versionIn(names.join(' '));
  return { path: f, rel, parts, family, epoch: run.epoch, step: run.step, mtime, stem: stemOf(path.basename(f)), version };
}

/** Path shown for a file: relative to the first folder the person gave when it is inside it, else `<scanned folder>/<rest>`. */
const relIn = (primary: string | undefined, dir: string, f: string): string => {
  const inPrimary = primary ? path.relative(primary, f) : '';
  const r = primary && inPrimary && !inPrimary.startsWith('..') && !path.isAbsolute(inPrimary) ? inPrimary : path.join(path.basename(dir), path.relative(dir, f));
  return r.split(path.sep).join('/');
};

/** The install's own weight folders (`GPT_weights_v2Pro/...`): the family is the version in the folder name. */
function installWeights(primary: string | undefined, dir: string, prefixRe: RegExp, prefix: string, ext: RegExp, seen: Set<string>): WeightFile[] {
  const out: WeightFile[] = [];
  let top: string[];
  try {
    top = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && prefixRe.test(d.name) && !RVC.test(d.name)).map((d) => d.name);
  } catch {
    return out;
  }
  for (const folder of top) {
    const c = collect(path.join(dir, folder), { skipRvc: true });
    for (const f of c.files) {
      if (!ext.test(f)) continue;
      const w = weightOf(path.join(dir, folder), f, familyOf(folder, prefix), [folder], seen, [], relIn(primary, dir, f));
      if (w) out.push(w);
    }
  }
  return out;
}

/** Weights found anywhere in a folder (a downloaded pack kept where it is, a character folder, a parent of installs). */
function packWeights(primary: string | undefined, dir: string, files: readonly string[], ext: RegExp, seen: Set<string>): WeightFile[] {
  const out: WeightFile[] = [];
  for (const f of files) {
    if (!ext.test(f)) continue;
    const segs = path.relative(dir, f).split(path.sep).slice(0, -1);
    const wf = segs.find((x) => /^(GPT|SoVITS)_weights/i.test(x));
    const family = wf ? familyOf(wf, /^GPT/i.test(wf) ? 'GPT_weights' : 'SoVITS_weights') : `pack:${path.basename(dir)}`;
    const w = weightOf(dir, f, family, [path.basename(dir), ...segs], seen, [path.basename(dir)], relIn(primary, dir, f));
    if (w) out.push(w);
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

function refsFrom(primary: string | undefined, dir: string, files: readonly string[], seen: Set<string>): RefFile[] {
  const out: RefFile[] = [];
  const lists = readLists([...files]);
  for (const f of files) {
    if (!AUDIO.test(f)) continue;
    const key = path.resolve(f).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
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
    out.push({ path: f, rel: relIn(primary, dir, f), folders, base, text, lang: lang || (text ? guessLang(text) : ''), seconds: /\.wav$/i.test(f) ? wavLength(f) : /\.mp3$/i.test(f) ? mp3Seconds(f) : null, tag, ...(suspect && textFrom === 'filename' ? { textSuspect: true } : {}), textFrom });
  }
  return out;
}

/** Reference folders inside an install: `ref*`, `参考音频*`. */
function refFoldersIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && (/^ref/i.test(d.name) || /^参考音频/.test(d.name))).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

export interface ScanReport {
  path: string;
  role: 'primary' | 'extra';
  ckpt: number;
  pth: number;
  audio: number;
  /** The folder holds more than the scan reads (the files after the limit were not looked at). */
  truncated: boolean;
}

const dirOk = (d: string): boolean => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Scans the folders the person gave: a GPT-SoVITS install (GPT_weights* / SoVITS_weights* / ref*), a downloaded pack, a single
 * character's folder, or a folder that holds several of them. Every folder is read recursively (the install's own weight and reference
 * folders first, so they keep their version); each folder has its own file budget.
 */
export function scanInstall(rootInput: string, extraInput: readonly string[] = []): Scan {
  const warnings: string[] = [];
  const root = cleanPath(rootInput);
  const extras = extraInput.map(cleanPath).filter(Boolean);
  if (!root && extras.length === 0) throw new Error('还没有填模型文件夹（GPT-SoVITS 安装目录、整合包文件夹，或某个角色的文件夹）');
  const wanted: Array<{ dir: string; role: 'primary' | 'extra' }> = [];
  const known = new Set<string>();
  const add = (raw: string, role: 'primary' | 'extra') => {
    const key = path.resolve(raw).toLowerCase();
    if (known.has(key)) return;
    if (!fs.existsSync(raw)) {
      warnings.push(`找不到文件夹：${raw}（已跳过；自动匹配只能在 GPT-SoVITS 和本软件在同一台电脑上时使用）`);
      return;
    }
    if (!dirOk(raw)) {
      warnings.push(`这不是文件夹：${raw}（请填文件夹，不是某个文件；已跳过）`);
      return;
    }
    known.add(key);
    wanted.push({ dir: path.resolve(raw), role });
  };
  if (root) add(root, 'primary');
  for (const e of extras) add(e, 'extra');
  if (wanted.length === 0) throw new Error(warnings.join('；') || '没有可以扫描的文件夹');

  const primary = wanted.find((w) => w.role === 'primary')?.dir ?? wanted[0]!.dir;
  const seenW = new Set<string>();
  const seenR = new Set<string>();
  const gpt: WeightFile[] = [];
  const sovits: WeightFile[] = [];
  const refs: RefFile[] = [];
  const report: ScanReport[] = [];
  for (const { dir, role } of wanted) {
    // the install's own folders first (they carry the version), then everything else in the folder
    gpt.push(...installWeights(primary, dir, /^GPT_weights/i, 'GPT_weights', /\.ckpt$/i, seenW));
    sovits.push(...installWeights(primary, dir, /^SoVITS_weights/i, 'SoVITS_weights', /\.pth$/i, seenW));
    for (const rd of refFoldersIn(dir)) {
      const c = collect(rd);
      refs.push(...refsFrom(primary, rd, c.files, seenR));
    }
    const isInstall = ['api_v2.py', 'webui.py', 'api.py'].some((n) => fs.existsSync(path.join(dir, n)));
    const c = collect(dir, { skipRvc: true, ...(isInstall ? { skip: INSTALL_CODE_DIR } : {}) });
    gpt.push(...packWeights(primary, dir, c.files, /\.ckpt$/i, seenW));
    sovits.push(...packWeights(primary, dir, c.files, /\.pth$/i, seenW));
    refs.push(...refsFrom(primary, dir, c.files, seenR));
    report.push({ path: dir, role, ckpt: c.files.filter((f) => /\.ckpt$/i.test(f)).length, pth: c.files.filter((f) => /\.pth$/i.test(f)).length, audio: c.files.filter((f) => AUDIO.test(f)).length, truncated: c.truncated });
    if (c.truncated) warnings.push(`文件夹里的文件太多，只读了一部分：${dir}（请直接填模型所在的更小的文件夹）`);
  }
  if (gpt.length === 0 && sovits.length === 0) warnings.push('没有找到 .ckpt / .pth 权重');
  return { gpt, sovits, refs, warnings, report, dirs: wanted.map((w) => w.dir) };
}
