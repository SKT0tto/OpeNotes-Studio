/** User-uploaded backgrounds: content-derived ids, display names from the file name, target size. */
export const USER_BG_ID_RE = /^user_[0-9a-f]{12}$/;
export const isUserBg = (id: string): boolean => USER_BG_ID_RE.test(id);
/** `user_` + the first 12 hex chars of the file's sha256: the same picture always gets the same id. */
export const userBgId = (sha256hex: string): string => `user_${sha256hex.slice(0, 12).toLowerCase()}`;

/** Display name = file name without extension, trimmed, whitespace collapsed, max 40 chars. */
export function uploadBgName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\s+/g, ' ').trim();
  return Array.from(stem).slice(0, 40).join('').trim() || '上传的背景';
}

export const UPLOAD_MIN_SIDE = 320;
export const UPLOAD_COVER = { w: 2560, h: 1440 } as const;
/** Shrink only when larger than needed to cover a 2560x1440 stage; never enlarge. */
export function uploadTargetSize(w: number, h: number): { width: number; height: number } {
  const k = Math.max(UPLOAD_COVER.w / w, UPLOAD_COVER.h / h);
  return k < 1 ? { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) } : { width: w, height: h };
}

const clip = (t: string, n: number) => (Array.from(t).length > n ? `${Array.from(t).slice(0, n).join('')}…` : t);

/** Confirm text for deleting an uploaded background; names the projects (max 5, titles clipped) that still use it. */
export function deleteBgWarning(projects: ReadonlyArray<{ title: string; scenes: number }>): string {
  if (projects.length === 0) return '删除这张上传的背景？删除后无法撤销。';
  const names = projects.slice(0, 5).map((p) => clip(p.title.trim() || '未命名项目', 20));
  const list = names.join('、') + (projects.length > names.length ? `等 ${projects.length} 个项目` : '');
  const scenes = projects.reduce((n, p) => n + p.scenes, 0);
  return `这张背景正在被 ${projects.length} 个项目使用：${list}（共 ${scenes} 个场景）。删除后这些场景会显示为缺失背景，且无法撤销。确定删除吗？`;
}

/** Notice for dropped / picked files that are not pictures; '' when there are none. */
export function ignoredFilesNotice(names: readonly string[]): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, 3).map((n) => clip(n, 30)).join('、') + (names.length > 3 ? ' 等' : '');
  return `已忽略 ${names.length} 个非图片文件：${shown}（支持 PNG / JPG / WebP）`;
}
