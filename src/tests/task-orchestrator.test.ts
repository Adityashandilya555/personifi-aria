import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentCategory } from '../media/contentIntelligence.js'
import { WORKFLOW_BY_KEY, TASK_WORKFLOWS } from '../task-orchestrator/workflows.js'
import {
    evaluateTaskReply,
    evaluateTaskCallback,
    shouldAbandonTask,
    isStepTerminal,
    canRollbackStep,
} from '../task-orchestrator/state-machine.js'
import {
    startTaskWorkflow,
    handleTaskReply,
    handleTaskCallback,
    expireStaleTaskWorkflows,
    matchWorkflowTrigger,
} from '../task-orchestrator/orchestrator.js'
import type { TaskStep, TaskStatus } from '../task-orchestrator/types.js'

// ─── DB Mock ────────────────────────────────────────────────────────────────

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../character/session-store.js', () => ({
    getPool: vi.fn(() => ({ query: mockQuery })),
}))

vi.mock('../influence-engine.js', () => ({
    selectStrategy: vi.fn(() => null),
    formatStrategyForPrompt: vi.fn(() => null),
}))

// ─── Workflow Definitions ───────────────────────────────────────────────────

describe('task workflow definitions', () => {
    it('all workflows have unique keys', () => {
        const keys = TASK_WORKFLOWS.map(w => w.key)
        expect(new Set(keys).size).toBe(keys.length)
    })

    it('all workflows have at least one step', () => {
        for (const workflow of TASK_WORKFLOWS) {
            expect(workflow.steps.length).toBeGreaterThan(0)
        }
    })

    it('all steps have unique IDs within workflow', () => {
        for (const workflow of TASK_WORKFLOWS) {
            const ids = workflow.steps.map(s => s.id)
            expect(new Set(ids).size).toBe(ids.length)
        }
    })

    it('WORKFLOW_BY_KEY contains all workflows', () => {
        expect(WORKFLOW_BY_KEY.size).toBe(TASK_WORKFLOWS.length)
        for (const workflow of TASK_WORKFLOWS) {
            expect(WORKFLOW_BY_KEY.get(workflow.key)).toBe(workflow)
        }
    })

    it('biryani deal flow has 4 steps', () => {
        const workflow = WORKFLOW_BY_KEY.get('biryani_deal_flow')
        expect(workflow).toBeDefined()
        expect(workflow!.steps.length).toBe(4)
        expect(workflow!.steps[0].type).toBe('present_reel')
        expect(workflow!.steps[1].type).toBe('compare_prices')
        expect(workflow!.steps[2].type).toBe('present_card')
        expect(workflow!.steps[3].type).toBe('confirm_action')
    })
})

// ─── State Machine ──────────────────────────────────────────────────────────

describe('task state machine', () => {
    const hookStep: TaskStep = {
        id: 'test_hook',
        type: 'present_reel',
        text: 'Check this out',
        choices: [
            { label: 'Compare', action: 'compare' },
            { label: 'Skip', action: 'skip' },
        ],
        nextOnChoice: { compare: 1 },
        intentKeywords: ['yes', 'sure', 'compare', 'want'],
        nextOnAnyReply: 1,
        abandonKeywords: ['skip', 'later'],
        ctaUrgency: 'soft',
    }

    const handoffStep: TaskStep = {
        id: 'test_handoff',
        type: 'collect_input',
        text: 'Send your area:',
        passThroughOnAnyReply: true,
    }

    describe('evaluateTaskReply', () => {
        it('advances on positive intent keyword', () => {
            const decision = evaluateTaskReply(hookStep, 'yes please compare')
            expect(decision.type).toBe('advance')
            if (decision.type === 'advance') {
                expect(decision.nextStepIndex).toBe(1)
            }
        })

        it('abandons on negative keyword', () => {
            const decision = evaluateTaskReply(hookStep, 'skip this')
            expect(decision.type).toBe('abandon')
        })

        it('abandons on global abandon pattern', () => {
            const decision = evaluateTaskReply(hookStep, 'no thanks')
            expect(decision.type).toBe('abandon')
        })

        it('stays on empty reply', () => {
            const decision = evaluateTaskReply(hookStep, '')
            expect(decision.type).toBe('stay')
        })

        it('passes through on handoff step', () => {
            const decision = evaluateTaskReply(handoffStep, 'Indiranagar')
            expect(decision.type).toBe('pass_through')
        })
    })

    describe('evaluateTaskCallback', () => {
        it('advances on valid choice', () => {
            const decision = evaluateTaskCallback(hookStep, 'compare')
            expect(decision.type).toBe('advance')
            if (decision.type === 'advance') {
                expect(decision.nextStepIndex).toBe(1)
            }
        })

        it('abandons on decline action', () => {
            const decision = evaluateTaskCallback(hookStep, 'skip')
            expect(decision.type).toBe('abandon')
        })

        it('abandons on global decline keywords', () => {
            const decision = evaluateTaskCallback(hookStep, 'cancel')
            expect(decision.type).toBe('abandon')
        })
    })

    describe('shouldAbandonTask', () => {
        it('detects global abandon patterns', () => {
            expect(shouldAbandonTask(hookStep, 'stop')).toBe(true)
            expect(shouldAbandonTask(hookStep, 'no thanks')).toBe(true)
            expect(shouldAbandonTask(hookStep, 'quit')).toBe(true)
        })

        it('detects step-level abandon keywords', () => {
            expect(shouldAbandonTask(hookStep, 'skip it')).toBe(true)
            expect(shouldAbandonTask(hookStep, 'later please')).toBe(true)
        })

        it('does not trigger on normal messages', () => {
            expect(shouldAbandonTask(hookStep, 'yes compare please')).toBe(false)
        })
    })

    describe('utilities', () => {
        it('isStepTerminal returns true for last step', () => {
            expect(isStepTerminal(4, 3)).toBe(true)
            expect(isStepTerminal(4, 2)).toBe(false)
            expect(isStepTerminal(4, 0)).toBe(false)
        })

        it('canRollbackStep checks step flag', () => {
            expect(canRollbackStep({ ...hookStep, canRollback: true })).toBe(true)
            expect(canRollbackStep(hookStep)).toBe(false)
        })
    })
})

// ─── Workflow Trigger Matching ──────────────────────────────────────────────

describe('workflow trigger matching', () => {
    it('matches biryani keywords', () => {
        expect(matchWorkflowTrigger('find me a biryani deal')).toBe('biryani_deal_flow')
        expect(matchWorkflowTrigger('best biryani near me')).toBe('biryani_deal_flow')
    })

    it('matches weekend plan keywords', () => {
        expect(matchWorkflowTrigger('help me with weekend food plan')).toBe('weekend_food_plan_flow')
    })

    it('matches recommendation keywords', () => {
        expect(matchWorkflowTrigger('recommend something good')).toBe('quick_recommendation_flow')
        expect(matchWorkflowTrigger('what should i eat')).toBe('quick_recommendation_flow')
    })

    it('returns null for unrelated messages', () => {
        expect(matchWorkflowTrigger('what is the weather')).toBeNull()
        expect(matchWorkflowTrigger('hello')).toBeNull()
    })
})

// ─── Orchestrator Integration ───────────────────────────────────────────────

describe('task orchestrator integration', () => {
    beforeEach(() => {
        mockQuery.mockReset()
    })

    it('starts a task workflow and sends first step', async () => {
        const activeRow = {
            id: 't1',
            platform_user_id: 'tg-user-1',
            internal_user_id: '11111111-1111-1111-1111-111111111111',
            chat_id: 'chat-1',
            workflow_key: 'biryani_deal_flow',
            status: 'ACTIVE' as TaskStatus,
            current_step_index: 0,
            context: {},
            last_event_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
        }

        const sendText = vi.fn(async (_chatId: string, _text: string, _choices?: Array<{ label: string; action: string }>) => true)

        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM task_workflows') && sql.includes("status IN ('ACTIVE'")) return { rows: [] }
            if (sql.includes('INSERT INTO task_workflows')) return { rows: [activeRow] }
            if (sql.includes('INSERT INTO task_workflow_events')) return { rows: [] }
            return { rows: [] }
        })

        const result = await startTaskWorkflow('tg-user-1', '11111111-1111-1111-1111-111111111111', 'chat-1', 'biryani_deal_flow', sendText)
        expect(result.started).toBe(true)
        if (result.started) {
            expect(result.workflowKey).toBe('biryani_deal_flow')
            expect(result.category).toBe(ContentCategory.FOOD_PRICE_DEALS)
        }
        expect(sendText).toHaveBeenCalledTimes(1)

        // Verify callback actions are prefixed with task:
        const choices = (sendText.mock.calls[0]?.[2] as Array<{ label: string; action: string }> | undefined) ?? []
        expect(Array.isArray(choices)).toBe(true)
        expect(String(choices[0]?.action ?? '')).toMatch(/^task:biryani_deal_flow:/)
    })

    it('rejects start when active task already exists', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM task_workflows') && sql.includes("status IN ('ACTIVE'")) {
                return {
                    rows: [{
                        id: 't-existing',
                        platform_user_id: 'tg-user-1',
                        internal_user_id: '11111111-1111-1111-1111-111111111111',
                        chat_id: 'chat-1',
                        workflow_key: 'biryani_deal_flow',
                        status: 'ACTIVE',
                        current_step_index: 0,
                        context: {},
                        last_event_at: new Date(),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                }
            }
            return { rows: [] }
        })

        const result = await startTaskWorkflow('tg-user-1', '11111111-1111-1111-1111-111111111111', 'chat-1', 'biryani_deal_flow')
        expect(result.started).toBe(false)
    })

    it('handles task reply pass-through at handoff step', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM task_workflows') && sql.includes("status IN ('ACTIVE'")) {
                return {
                    rows: [{
                        id: 't2',
                        platform_user_id: 'tg-user-1',
                        internal_user_id: '11111111-1111-1111-1111-111111111111',
                        chat_id: 'chat-1',
                        workflow_key: 'biryani_deal_flow',
                        status: 'ACTIVE',
                        current_step_index: 3, // confirm_order step with passThroughOnAnyReply
                        context: {},
                        last_event_at: new Date(),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                }
            }
            if (sql.includes('UPDATE task_workflows')) return { rowCount: 1, rows: [] }
            if (sql.includes('INSERT INTO task_workflow_events')) return { rows: [] }
            return { rows: [] }
        })

        const result = await handleTaskReply('tg-user-1', 'Indiranagar')
        expect(result.handled).toBe(false)
        expect(result.passThrough).toBe(true)
    })

    it('handles task reply abandon', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM task_workflows') && sql.includes("status IN ('ACTIVE'")) {
                return {
                    rows: [{
                        id: 't3',
                        platform_user_id: 'tg-user-1',
                        internal_user_id: '11111111-1111-1111-1111-111111111111',
                        chat_id: 'chat-1',
                        workflow_key: 'biryani_deal_flow',
                        status: 'ACTIVE',
                        current_step_index: 0,
                        context: {},
                        last_event_at: new Date(),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                }
            }
            if (sql.includes('UPDATE task_workflows')) return { rowCount: 1, rows: [] }
            if (sql.includes('INSERT INTO task_workflow_events')) return { rows: [] }
            return { rows: [] }
        })

        const result = await handleTaskReply('tg-user-1', 'not now, maybe later')
        expect(result.handled).toBe(true)
        expect(result.response?.text).toContain('pause')
    })

    it('expires stale task workflows', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('UPDATE task_workflows') && sql.includes("status = 'EXPIRED'")) {
                return {
                    rows: [
                        { id: 't-exp-1', platform_user_id: 'tg-1', current_step_index: 0 },
                        { id: 't-exp-2', platform_user_id: 'tg-2', current_step_index: 1 },
                    ],
                }
            }
            if (sql.includes('INSERT INTO task_workflow_events')) return { rows: [] }
            return { rows: [] }
        })

        const expired = await expireStaleTaskWorkflows(30)
        expect(expired).toBe(2)
    })

    it('handles task callback advance', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM task_workflows') && sql.includes("status IN ('ACTIVE'")) {
                return {
                    rows: [{
                        id: 't4',
                        platform_user_id: 'tg-user-1',
                        internal_user_id: '11111111-1111-1111-1111-111111111111',
                        chat_id: 'chat-1',
                        workflow_key: 'biryani_deal_flow',
                        status: 'ACTIVE',
                        current_step_index: 0,
                        context: {},
                        last_event_at: new Date(),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                }
            }
            if (sql.includes('UPDATE task_workflows')) return { rowCount: 1, rows: [] }
            if (sql.includes('INSERT INTO task_workflow_events')) return { rows: [] }
            return { rows: [] }
        })

        const result = await handleTaskCallback('tg-user-1', 'task:biryani_deal_flow:compare')
        expect(result).not.toBeNull()
        expect(result!.text).toContain('Comparing')
    })

    it('returns null for no active task', async () => {
        mockQuery.mockImplementation(async () => ({ rows: [] }))
        const result = await handleTaskReply('tg-unknown', 'hello')
        expect(result.handled).toBe(false)
    })
})
