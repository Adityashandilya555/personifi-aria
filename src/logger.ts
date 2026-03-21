/**
 * Shared logger — single instance used across the entire codebase.
 *
 * Dev:  pretty-printed, colorized output via pino-pretty
 * Prod: structured JSON — pipe to Datadog / CloudWatch / Loki
 *
 * Usage:
 *   import { logger } from '../logger.js'
 *   const log = logger.child({ module: 'sentinel' })
 *   log.info({ userId }, 'cycle started')
 *   log.warn({ latencyMs }, 'bedrock slow — falling back')
 *   log.error({ err }, 'fatal error')
 */

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    ...(isDev && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
            },
        },
    }),
})
