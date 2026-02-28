import type { AgendaGoal } from './types.js'

export interface AgendaFormatOptions {
  maxGoals?: number
  maxChars?: number
}

const DEFAULT_MAX_GOALS = 3
const DEFAULT_MAX_CHARS = 600 // ~150 tokens

function compactText(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLen) return normalized
  return `${normalized.slice(0, Math.max(0, maxLen - 1)).trim()}…`
}

/**
 * Sanitize user-sourced text before injecting into the system prompt.
 * Strips markdown headers, instruction/role-play patterns, and control characters
 * to prevent prompt injection via goal.goal or goal.nextAction fields.
 */
function sanitizeForPrompt(value: string): string {
  return value
    // Strip markdown heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Strip instruction-like patterns (ignore, forget, pretend, you are, system:, etc.)
    .replace(/\b(ignore|forget|disregard|override|bypass)\b.*?(instructions?|rules?|above|previous|prior)/gi, '[filtered]')
    .replace(/\b(you are|act as|pretend|role[- ]?play|system\s*:)/gi, '[filtered]')
    // Strip code fences and HTML tags
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]+>/g, '')
    // Strip control characters (except newline/tab)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
}

export function formatAgendaForPrompt(
  goals: AgendaGoal[] | undefined,
  opts: AgendaFormatOptions = {},
): string {
  if (!goals || goals.length === 0) return ''

  const maxGoals = Math.max(1, opts.maxGoals ?? DEFAULT_MAX_GOALS)
  const maxChars = Math.max(120, opts.maxChars ?? DEFAULT_MAX_CHARS)
  const top = goals
    .filter(goal => goal.status === 'active')
    .sort((a, b) => (b.priority - a.priority) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, maxGoals)

  if (top.length === 0) return ''

  const header = '## Conversation Agenda\nPrioritize these goals in order:'
  const lines: string[] = [header]
  let usedChars = header.length

  for (let i = 0; i < top.length; i += 1) {
    const goal = top[i]
    const parentSuffix = goal.parentGoalId ? ` | parent:${goal.parentGoalId}` : ''
    const baseLine = `${i + 1}. [${goal.goalType}|P${goal.priority}] ${compactText(sanitizeForPrompt(goal.goal), 110)}${parentSuffix}`
    const nextLine = goal.nextAction
      ? `   next: ${compactText(sanitizeForPrompt(goal.nextAction), 90)}`
      : ''

    const projectedLength = usedChars + 1 + baseLine.length + (nextLine ? (1 + nextLine.length) : 0)
    if (projectedLength > maxChars) break

    lines.push(baseLine)
    if (nextLine) lines.push(nextLine)
    usedChars = projectedLength
  }

  if (lines.length === 1) return ''
  return lines.join('\n')
}

