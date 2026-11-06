import type { Pose } from '../model/evaluate'
import { quatAngle } from '../model/rootMath'
import type { RobotDef } from '../robot/types'

export interface Warning {
  kind: 'jointLimit' | 'jointVelocity' | 'rootJump' | 'gap' | 'physicsAssist' | 'jointJump' | 'jointJumpError' // jointJump*: RL 학습용 only (rlExport)
  frame: number
  channel: string
  message: string
  near?: boolean // jointJump*: within ±0.4 s of an edit range boundary (stressed in the list)
}

const FPS = 60
const POS_JUMP = 0.05
const ROT_JUMP = 0.1
const f3 = (v: number) => v.toFixed(3)

export function validatePoses(poses: Pose[], def: RobotDef, firstFrame: number): Warning[] {
  const out: Warning[] = []
  const active = new Set<string>() // kind|channel currently inside a violation run
  const check = (bad: boolean, kind: Warning['kind'], channel: string, frame: number, msg: () => string) => {
    const key = `${kind}|${channel}`
    if (!bad) active.delete(key)
    else if (!active.has(key)) {
      active.add(key)
      out.push({ kind, frame, channel, message: msg() })
    }
  }
  poses.forEach((p, i) => {
    const frame = firstFrame + i
    const prev = poses[i - 1]
    def.joints.forEach((j, k) => {
      const v = p.q[k]
      check(v < j.lower || v > j.upper, 'jointLimit', j.name, frame, () =>
        v < j.lower ? `${j.name} 한계 초과 (${f3(v)} < ${f3(j.lower)})` : `${j.name} 한계 초과 (${f3(v)} > ${f3(j.upper)})`)
      if (prev) {
        const sp = Math.abs(v - prev.q[k]) * FPS
        check(sp > j.velocity, 'jointVelocity', j.name, frame, () => `${j.name} 속도 초과 (${f3(sp)} > ${f3(j.velocity)} rad/s)`)
      }
    })
    if (prev) {
      const d = Math.hypot(p.rootPos[0] - prev.rootPos[0], p.rootPos[1] - prev.rootPos[1], p.rootPos[2] - prev.rootPos[2])
      const a = quatAngle(prev.rootQuat, p.rootQuat)
      check(d > POS_JUMP || a > ROT_JUMP, 'rootJump', 'root', frame, () => `루트 급변 (위치 ${f3(d)} m, 회전 ${f3(a)} rad)`)
    }
  })
  return out
}
