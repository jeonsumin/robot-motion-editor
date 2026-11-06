import { saveCsvFile } from '../fileio'
import { exportItemCsv } from './csv'
import { redWalks } from '../model/itemClip'
import { needsRun, physicsWarnings } from './physicsWarn'
import { usePhysics } from '../physics/physicsStore'
import { runItems, whenSettled } from '../physics/runItem'
import type { Project } from '../model/types'
import type { RobotDefs } from '../model/evaluate'

// Single-item export (local root, like every export). Returns the message to show, or null when the user cancelled.
export async function exportOne(project: Project, defs: RobotDefs, actorId: string, itemId: string,
  ask: (m: string) => boolean = m => window.confirm(m), title?: string): Promise<string | null> {
  try {
    const red = redWalks(project, defs, [itemId]) // §22 안정성 우선: a 한계 초과 walk (it stands instead) is not exported
    if (red.length) return `내보내지 않았습니다 — 한계 초과 걷기: ${red[0].text}`
    const { name, text, warnings } = exportItemCsv(project, defs, actorId, itemId, undefined, title)
    if (needsRun(project, defs, actorId, itemId, usePhysics.getState().byItem[itemId])) await runItems([{ actorId, itemId }])
    await whenSettled(itemId) // already queued/running (e.g. track run): wait for it
    const st = usePhysics.getState().byItem[itemId]
    const item = project.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId)!
    const n = warnings.length + physicsWarnings(project, defs, item, st).length
    const skipped = st?.status === 'error' ? ` (물리 검증 생략: ${st.message})` : ''
    if (n && !ask(`경고 ${n}개가 있습니다 (관절 한계·속도·루트·물리 보조력)${skipped}. 그래도 내보낼까요?`)) return null
    return (await saveCsvFile(name, text)) ? `${name} 을(를) 내보냈습니다${skipped}` : null
  } catch (e) { return `내보내기 실패: ${e instanceof Error ? e.message : e}` }
}
