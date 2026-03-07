export { pulseService, PulseService } from './pulse-service.js'
export { extractEngagementSignals } from './signal-extractor.js'
export { applyDecay, clampScore, stateForScore, transitionState } from './state-machine.js'
export * from './types.js'
export * from './engagement-types.js'
export {
    initializeMetrics,
    updateMetric,
    getMetrics,
    getCategoryWeight,
    getWeightMap,
    syncEngagementState,
    recordInteraction,
} from './engagement-metrics.js'

