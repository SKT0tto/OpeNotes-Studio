/** Chinese display names for enum values and resource ids. The raw id always stays available as a tooltip / secondary text. */
import type { CostumeInfo } from './costume';
import { parseExpressionName } from './expressionNames';
import { parseMotionName } from './motionNames';

export const SHOT_LABEL: Record<string, string> = {
  establishing: '空镜', group: '群像', two_shot: '双人', ms: '中景', mcu: '胸像', cu: '近景', ecu: '大特写', insert: '插入',
  closeup: '近景（旧）', bust: '胸像（旧）', medium: '中景（旧）', wide: '远景（旧）',
};
/** Short names for narrow places (storyboard cards, timeline blocks). */
export const SHOT_SHORT: Record<string, string> = {
  establishing: '空镜', group: '群像', two_shot: '双人', ms: '中景', mcu: '胸像', cu: '近景', ecu: '特写', insert: '插入', closeup: '近景', bust: '胸像', medium: '中景', wide: '远景',
};
export const BEAT_KIND_LABEL: Record<string, string> = {
  dialogue: '对白', narration: '旁白', action: '动作', pause: '停顿', establishing: '空镜', silent: '无声', empty: '空景',
};
export const MOVE_LABEL: Record<string, string> = { static: '固定', push_in: '推近', pull_out: '拉远', pan: '横摇', track: '跟随', shake: '抖动' };
export const TRANSITION_LABEL: Record<string, string> = {
  cut: '硬切', dip_black: '黑场眨眼', scene_black: '换场黑场', fade_black: '黑场', fade_white: '白场', crossfade: '交叉溶解', wipe: '擦除',
};
export const CAMERA_SYSTEM_LABEL: Record<string, string> = { classic: '经典（硬切）', travel: '运镜（Our Notes / MyGO 式）', inherit: '跟随项目' };
export const SHOT_TRANSITION_LABEL: Record<string, string> = { auto: '自动', cut: '硬切', glide: '滑移', travel: '运镜' };
/** A travel decision's reason without its own "运镜：" lead-in, so a label such as "运镜决定：" does not repeat it. */
export const travelReasonText = (reason: string): string => reason.replace(/^\s*运镜(决定)?[：:]\s*/, '');
export const TRAVEL_KIND_LABEL: Record<string, string> = { cut: '硬切', glide: '滑移', distance: '景距推拉', lateral: '横移', regroup: '重组（双人/群像↔单人）', settle: '收势推近', reframe: '入场重构图', drift: '空景慢漂', cutDrift: '切入缓移' };
/** Depth-of-field text of a shot (timeline block, storyboard card): a travel scene blurs by shot distance unless the author set a level. */
export const dofText = (travel: boolean, manual: number | undefined, level: number) => (travel && manual === undefined ? '景深 按景距' : `景深 ${level}`);
export const EMOTION_LABEL: Record<string, string> = { happy: '开心', sad: '难过', angry: '生气', surprised: '惊讶', shy: '害羞', thinking: '思考', serious: '认真', neutral: '平静' };

const EXPRESSION_FAMILY: Record<string, string> = {
  angry: '生气', bsmile: '苦笑', cry: '哭泣', grinning: '咧嘴笑', idle: '平常', kime: '帅气', pain: '痛苦', pale: '苍白', sad: '难过',
  salk: '低落', serious: '认真', shadow: '阴沉', shy: '害羞', smile: '微笑', surprised: '惊讶',
};
const MOTION_FAMILY: Record<string, string> = {
  angry: '生气', bye: '挥手', check: '查看', cry: '哭泣', denial: '否定', idle: '待机', join: '合掌', kime: '摆姿势', look: '张望', nervous: '紧张',
  nod: '点头', note: '看手账', question: '疑问', sad: '难过', serious: '认真', smile: '微笑', surprised: '惊讶', thinking: '思考', misc: '其它',
};
const SIDE: Record<string, string> = { L: '左', C: '中', R: '右' };

/** `exp_angry01` -> 生气，`exp_smile02` -> 微笑 2. Unknown families keep their raw family name. */
export function expressionLabel(raw: string | null | undefined): string {
  if (!raw) return '无';
  const p = parseExpressionName(raw);
  const fam = EXPRESSION_FAMILY[p.family] ?? p.family;
  return p.index !== null && p.index > 1 ? `${fam} ${p.index}` : fam;
}

/** `mtn_nod01_L` -> 点头 左，`mtn_nod02_R` -> 点头 2 右. */
export function motionLabel(raw: string | null | undefined): string {
  if (!raw) return '无';
  const p = parseMotionName(raw);
  const m = /^(.*?)(\d+)$/.exec(p.family);
  const stem = (m?.[1] ?? p.family).replace(/_$/, '');
  const fam = MOTION_FAMILY[stem] ?? MOTION_FAMILY[stem.split('_')[0] ?? ''] ?? stem;
  const n = m ? Number(m[2]) : 1;
  return `${fam}${n > 1 ? ` ${n}` : ''}${p.side ? ` ${SIDE[p.side]}` : ''}`;
}

const BASE: Record<string, string> = { casual: '便服', school: '校服', roomwear: '居家服', live: '演出服', suits: '西装', virtual: '虚拟形象', other: '' };
const SEASON: Record<string, string> = { spring: '春', summer: '夏', winter: '冬' };
const TAG: Record<string, string> = {
  hairdown: '散发', hat: '帽子', mask: '面具', silhouette: '剪影', arbeit: '打工服', caretaker: '管理员', detective: '侦探', idol: '偶像', child: '儿童', sweat: '运动服', ring: 'RiNG',
};
/** Chinese costume name, e.g. 校服 · 冬 · 高中 · 1 年 · 眼镜. `variant` (the trailing number of the costume id) tells apart same-named outfits. */
export function costumeLabelZh(info: CostumeInfo, costume?: string): string {
  const parts: string[] = [];
  if (info.base === 'other') parts.push(TAG[info.tags[0] ?? ''] ?? info.tags[0] ?? '其它服装');
  else parts.push(BASE[info.base] ?? info.base);
  if (info.season) parts.push(SEASON[info.season] ?? info.season);
  if (info.school) parts.push(info.school === 'hs' ? '高中' : '初中');
  if (info.grade) parts.push(`${info.grade} 年`);
  if (info.glasses) parts.push('眼镜');
  for (const t of info.base === 'other' ? info.tags.slice(1) : info.tags) parts.push(TAG[t] ?? t);
  if (info.still) parts.push('立绘');
  const variant = costume ? /(?:^|_)(\d{1,2})(?:_|$)/.exec(costume)?.[1] : undefined;
  if (variant && Number(variant) > 0) parts.push(`#${Number(variant)}`);
  return parts.join(' · ');
}
