// 검수 목록 2단계·3단계 (수정변동사항.md §13 · §14): verdicts (Project.review, on clip frames) against what a check finds. Pure.
//  - 'ok'  (안무여서 놔둠): a found item on that range is not a problem (not 미처리, no export warning) but stays listed as 안무.
//  - 'bad' (문제 있음): open while a check still finds a jump on that range; 해결됨 once it does not (worked out at check time, not stored).
import type { RobotDefs } from '../model/pose'
import type { Item, Project, ReviewVerdict } from '../model/types'
import type { Warning } from '../export/validate'
import { detectSuspects, type Suspect } from './detect'
import { REVIEW_SLACK, reviewFamily, reviewSame } from '../model/review'
import { targetPoses, type ReviewTarget } from './targets'

const SLACK = REVIEW_SLACK
// the same spot: same clip, same family (관절 튐 / 자가충돌 / 손 맞닿음 §14 / 발 미끄러짐 · 마찰 부족 §16), same foot, ranges overlapping
// within SLACK. 무대 이탈 (§18) takes no verdict: where a piece stands depends on the piece, not on the clip's frames.
const same = (v: ReviewVerdict, clipId: string, s: Pick<Suspect, 'kind' | 'foot'>, r: { from: number; to: number }) =>
  s.kind !== 'stage' && reviewSame(v, { clipId, kind: s.kind, foot: s.foot, ...r })

/** A found item on clip frames: clipFrom = the target's clip frame of its pose 0. */
export const clipRange = (s: Pick<Suspect, 'from' | 'to'>, clipFrom: number) => ({ from: clipFrom + s.from, to: clipFrom + s.to })

export function verdictOf(review: ReviewVerdict[] | undefined, clipId: string, s: Pick<Suspect, 'from' | 'to' | 'kind' | 'foot'>, clipFrom: number): ReviewVerdict | undefined {
  const r = clipRange(s, clipFrom)
  return review?.find(v => same(v, clipId, s, r))
}

/** 'bad' verdicts inside [clipFrom, clipFrom + n) of the clip that no found item overlaps any more: 해결됨. */
export function resolvedBad(review: ReviewVerdict[] | undefined, clipId: string, found: Suspect[], clipFrom: number, n: number): ReviewVerdict[] {
  return (review ?? []).filter(v => v.clipId === clipId && v.verdict === 'bad' && v.to >= clipFrom && v.from < clipFrom + n
    && !found.some(s => same(v, clipId, s, clipRange(s, clipFrom))))
}

/** The clip of a review target (a piece's clip, or the clip itself). */
export function targetClipId(p: Project, t: ReviewTarget): string | undefined {
  return t.kind === 'clip' ? t.id : p.sequence.tracks.flatMap(x => x.items).find(i => i.id === t.id)?.refId
}

/** 'ok' ranges of a piece's clip, in sequence frames (the frames export warnings use). */
function okSeqRanges(p: Project, it: Item): [number, number][] {
  return (p.review ?? []).filter(v => v.clipId === it.refId && v.verdict === 'ok' && reviewFamily(v.kind) === 'jump' && v.to >= it.trimIn && v.from < it.trimOut) // only 관절 튐 verdicts answer for speed / jump warnings
    .map(v => [it.start + v.from - it.trimIn, it.start + v.to - it.trimIn])
}
const JUMPS: Warning['kind'][] = ['jointVelocity', 'jointJump', 'jointJumpError', 'rootJump'] // 튐 warnings (root too: 첫 프레임 튐 moves the root)

/** Export warnings of a piece split: speed / jump (joint or root) warnings inside an 안무여서 놔둠 range go to `ok` (listed apart, not counted). */
export function splitWarnings<W extends Pick<Warning, 'kind' | 'frame'>>(p: Project, it: Item, ws: W[]): { kept: W[]; ok: W[] } {
  const rs = okSeqRanges(p, it), kept: W[] = [], ok: W[] = []
  for (const w of ws) (JUMPS.includes(w.kind) && rs.some(([a, b]) => w.frame >= a - SLACK && w.frame <= b + SLACK) ? ok : kept).push(w)
  return { kept, ok }
}

/** 문제 있음 verdicts on a piece that a fresh check still finds (미해결), as sequence frames. */
export function openProblems(p: Project, defs: RobotDefs, it: Item): { frame: number; verdict: ReviewVerdict }[] {
  const bad = (p.review ?? []).filter(v => v.clipId === it.refId && v.verdict === 'bad' && v.to >= it.trimIn && v.from < it.trimOut)
  if (!bad.length) return []
  const t: ReviewTarget = { key: `item:${it.id}`, kind: 'item', id: it.id, label: '', robot: p.clips[it.refId].robot, firstFrame: it.start, clipFrom: it.trimIn }
  const poses = targetPoses(p, defs, t)
  if (!poses) return []
  const found = detectSuspects(poses, defs[t.robot])
  return bad.filter(v => found.some(s => same(v, it.refId, s, clipRange(s, it.trimIn))))
    .map(v => ({ frame: it.start + Math.max(v.from, it.trimIn) - it.trimIn, verdict: v }))
}

const KIND: Record<Suspect['kind'], string> = { limit: '로봇 한계 초과', rel: '파일 기준 급변', start: '첫 프레임 튐', collision: '자가충돌', handTouch: '손 맞닿음', footSlip: '발 미끄러짐', friction: '마찰 부족', stage: '무대 이탈' }
const cell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

/** 판정 기록 CSV: every found item of a target with its measurements and verdict (미판정 = empty). Header row, UTF-8 BOM for Excel. */
export function recordCsv(clipName: string, t: ReviewTarget, found: Suspect[], review: ReviewVerdict[] | undefined, clipId: string): string {
  const head = ['클립', '대상', '종류', '시작 클립 프레임', '끝 클립 프레임', '최악 클립 프레임', 'CSV 행(최악)', '시간(초)', '구간 길이(프레임)', '부위', '관절',
    '최대 속도(rad/s)', '로봇 한계 대비 배수', '프레임 간 변화(rad)', '파일 기준 급변 점수', '한계 접촉', '겹친 부위', '최대 관통 깊이(mm)', '판정', '판정 시각',
    '등급', '미끄러진 거리(cm)', '체중 비율(%)', '발 회전(°)', '필요 마찰계수(최대)'] // §16 columns last: the earlier ones keep their places
  const rows = found.map(s => {
    const v = verdictOf(review, clipId, s, t.clipFrom), r = clipRange(s, t.clipFrom), w = t.clipFrom + s.worst
    const coll = s.depth !== undefined // 자가충돌 · 손 맞닿음: no speed values, the overlap instead
    const jump = s.kind === 'limit' || s.kind === 'rel' || s.kind === 'start', slip = s.kind === 'footSlip' // §16: 발 미끄러짐 · 마찰 부족 fill their own columns
    return [clipName, t.label, KIND[s.kind], r.from, r.to, w, w + 1, (w / 60).toFixed(2), s.to - s.from + 1, coll ? '' : s.parts.join('·'), s.joints.join(' '),
      jump ? s.speed.toFixed(1) : '', jump ? s.ratio.toFixed(2) : '', jump ? s.jump.toFixed(3) : '', jump ? s.score.toFixed(1) : '', jump ? s.atLimit ? '예' : '아니오' : '',
      coll ? s.parts.join(' · ') : '', coll ? s.depth!.toFixed(1) : '',
      v ? (v.verdict === 'bad' ? '문제 있음' : '안무여서 놔둠') : '', v?.at ?? '',
      s.level ? (s.level === 'warn' ? '경고' : '주의') : '', slip ? (s.travel! * 100).toFixed(1) : '', slip ? Math.round(s.load! * 100) : '',
      slip ? Math.round(s.turn!) : '', s.mu !== undefined ? s.mu.toFixed(2) : '']
  })
  return '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\n') + '\n'
}
