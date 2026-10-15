// Shapes shared by the pure helpers. The runner's result JSON is specified in DESIGN.md; the values
// kept in state (`PilotRun`, `PilotFlow`) live in ../../types and are re-exported here.

import type { PilotFlow, PilotOutcome } from '../../types'

export type { PilotFlow, PilotOutcome }

export type Trust = 'shadow' | 'on'

/** The parts of q-pilot.config.json the mod reads. */
export type PilotConfig = {
  baseURL?: string
  flowsDir?: string
  ignore?: string[]
}

/** The parts of a flow file the impact map needs. */
export type FlowDef = {
  id: string
  covers?: string[]
  tags?: string[]
}

export type FlowSelection = {
  mode: 'none' | 'flows' | 'all'
  ids: string[]
  why: string[]
}

/** The last stdout line of the runner. */
export type RunnerResult = {
  ok: boolean
  command: string
  runId?: string
  runDir?: string
  durationMs?: number
  flows?: (PilotFlow & { suggestedVerify?: unknown })[]
  error?: string
  [key: string]: unknown
}

/** What the gate does with one flow result. */
export type Action = 'ok' | 'block' | 'accept' | 'notify' | 'note'
