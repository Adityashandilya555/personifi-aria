/**
 * Safe error logging utility.
 * In production, strips stack traces and internal details to avoid
 * leaking sensitive information to logs that may be forwarded externally.
 */

export function safeError(error: unknown): string | Record<string, unknown> {
  if (process.env.NODE_ENV !== 'production') {
    return error as any
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }

  if (typeof error === 'string') {
    return error
  }

  return '[non-Error thrown]'
}
