/**
 * Handler Router — Phase 6 cleanup (Issue #125)
 *
 * handler-legacy.ts and handler-alpha.ts have been deleted.
 * handler.ts is now the sole message handler.
 *
 * This file is kept as a thin re-export so that any existing imports
 * of handler-router continue to work without changes.
 */

export { handleMessage, type MessageResponse, type HandleMessageOptions } from './handler.js'
