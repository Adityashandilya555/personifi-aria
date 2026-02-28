export type AgendaGoalType =
  | 'trip_plan'
  | 'food_search'
  | 'price_watch'
  | 'recommendation'
  | 'onboarding'
  | 're_engagement'
  | 'upsell'
  | 'general'

export type AgendaGoalStatus = 'active' | 'completed' | 'abandoned'

export type AgendaGoalSource =
  | 'classifier'
  | 'agenda_planner'
  | 'funnel'
  | 'task_orchestrator'
  | 'manual'

export type AgendaPulseState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
export type AgendaMessageComplexity = 'simple' | 'moderate' | 'complex'
export type AgendaClassifierGoal =
  | 'inform'
  | 'recommend'
  | 'clarify'
  | 'empathize'
  | 'redirect'
  | 'upsell'
  | 'plan'
  | 'reassure'

export interface AgendaGoal {
  id: number
  userId: string
  sessionId: string
  goal: string
  status: AgendaGoalStatus
  context: Record<string, unknown>
  goalType: AgendaGoalType
  priority: number
  nextAction: string | null
  deadline: string | null
  parentGoalId: number | null
  source: AgendaGoalSource
  createdAt: string
  updatedAt: string
}

export interface AgendaContext {
  userId: string
  sessionId: string
  message: string
  displayName?: string
  homeLocation?: string
  pulseState?: AgendaPulseState
  classifierGoal?: AgendaClassifierGoal
  messageComplexity?: AgendaMessageComplexity
  activeToolName?: string
  hasToolResult?: boolean
  now?: Date
}

export interface AgendaEvalResult {
  stack: AgendaGoal[]
  createdGoalIds: number[]
  completedGoalIds: number[]
  abandonedGoalIds: number[]
  promotedGoalIds: number[]
  actions: string[]
}

