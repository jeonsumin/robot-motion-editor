// 검수 판정 ranges (Project.review, §13 · §14): two ranges of one clip are the same spot when they overlap within SLACK frames —
// a re-check may start or end an item a frame or two off (a return jump) — and are the same family: a 관절 튐 verdict does not
// answer for a 자가충돌 on the same frames (§14), nor for a 발 미끄러짐 / 마찰 부족 (§16). Shared by the store and src/review/verdicts.ts.
import type { ReviewVerdict } from './types'

export const REVIEW_SLACK = 2
export const reviewOverlap = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 + REVIEW_SLACK && b0 <= a1 + REVIEW_SLACK
export type ReviewFamily = 'jump' | 'collision' | 'handTouch' | 'footSlip' | 'friction'
export const reviewFamily = (k: ReviewVerdict['kind']): ReviewFamily => (k === 'limit' || k === 'rel' || k === 'start' ? 'jump' : k)
/** The same spot: same clip, same family, same foot (발 미끄러짐, §16), ranges overlapping within REVIEW_SLACK. */
export const reviewSame = (a: Pick<ReviewVerdict, 'clipId' | 'kind' | 'from' | 'to' | 'foot'>, b: Pick<ReviewVerdict, 'clipId' | 'kind' | 'from' | 'to' | 'foot'>) =>
  a.clipId === b.clipId && reviewFamily(a.kind) === reviewFamily(b.kind) && (a.foot ?? '') === (b.foot ?? '') && reviewOverlap(a.from, a.to, b.from, b.to)
export const REVIEW_KINDS: ReviewVerdict['kind'][] = ['limit', 'rel', 'start', 'collision', 'handTouch', 'footSlip', 'friction']
