export type Limit = { kind: string; pct: number; resetsAt?: string }

export type Snapshot = {
  ctxPct: number
  ctxTokens: number
  window: number
  costUsd: number | null
  model: string
  limits: Limit[]
  updatedAt: number
}

export type Stats = {
  turns: number
  turnsSinceCompact: number
  agentCalls: number
  lastGrowth: number
  lastOutput: number
  lastTools: number
  quietTurns: number
  lastActivity: number
}

export type OtherSession = {
  id: string
  cwd: string
  ctxPct: number
  costUsd: number | null
  model: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    tokenchik: {
      snap: Shaped<Snapshot | null>
      stats: Shaped<Stats>
      muted: Shaped<string[]>
      others: Shaped<OtherSession[]>
      now: number
    }
  }
}
