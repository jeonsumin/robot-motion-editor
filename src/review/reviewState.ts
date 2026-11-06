import { create } from 'zustand'
import type { ReviewVerdict } from '../model/types'

// 검수 목록 (§13): 문제 있음 verdicts that the last check of their target no longer finds (해결됨). Worked out at check time, not saved:
// the timeline draws these grey instead of red. Keyed by clip + range + time of the verdict, so a new verdict is open again.
export const resolvedKey = (v: ReviewVerdict) => `${v.clipId}:${v.from}-${v.to}:${v.at}`
export const useReview = create<{ resolved: Set<string> }>(() => ({ resolved: new Set() }))

/** After a check of [from, to) of a clip: these 'bad' verdicts are 해결됨, the other 'bad' ones of that range are open. */
export function noteCheck(inRange: ReviewVerdict[], resolved: ReviewVerdict[]) {
  const next = new Set(useReview.getState().resolved)
  for (const v of inRange) next.delete(resolvedKey(v))
  for (const v of resolved) next.add(resolvedKey(v))
  useReview.setState({ resolved: next })
}
