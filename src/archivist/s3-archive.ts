/**
 * Archivist — S3 Session Archiver
 *
 * Archives completed sessions to S3 as JSONL files for downstream
 * supervised learning / fine-tuning pipelines.
 *
 * Each file: s3://{bucket}/sessions/{userId}/{sessionId}.jsonl
 * Each line: JSON-encoded { role, content, timestamp }
 *
 * Fully optional — if AWS_S3_BUCKET is not set, all functions are no-ops.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

// ─── S3 Client (lazy singleton) ───────────────────────────────────────────────

let s3Client: S3Client | null = null

function getS3Client(): S3Client | null {
    if (!process.env.AWS_S3_BUCKET) return null

    if (!s3Client) {
        s3Client = new S3Client({
            region: process.env.AWS_REGION ?? 'ap-south-1',
            credentials: process.env.AWS_ACCESS_KEY_ID
                ? {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
                }
                : undefined, // Falls back to IAM role / env if on AWS infra
        })
    }

    return s3Client
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArchivableMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp?: string
}

export interface ArchiveResult {
    success: boolean
    s3Key?: string
    error?: string
}

// ─── Archive ─────────────────────────────────────────────────────────────────

/**
 * Upload a session's messages to S3 as a JSONL file.
 * Returns the S3 key on success, or the error message on failure.
 * Is a no-op (returns success) if AWS_S3_BUCKET is not configured.
 */
export async function archiveSession(
    sessionId: string,
    userId: string,
    messages: ArchivableMessage[]
): Promise<ArchiveResult> {
    const client = getS3Client()
    if (!client) {
        // S3 not configured — silently succeed
        return { success: true }
    }

    if (messages.length === 0) {
        return { success: true }
    }

    const bucket = process.env.AWS_S3_BUCKET!
    const s3Key = `sessions/${userId}/${sessionId}.jsonl`

    // Serialize to JSONL — one JSON object per line
    const jsonl = messages
        .map(msg => JSON.stringify({
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp ?? new Date().toISOString(),
        }))
        .join('\n')

    try {
        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: s3Key,
                Body: jsonl,
                ContentType: 'application/x-ndjson',
                Metadata: {
                    sessionId,
                    userId,
                    messageCount: String(messages.length),
                    archivedAt: new Date().toISOString(),
                },
            })
        )

        console.log(`[archivist/s3] Archived session ${sessionId} → s3://${bucket}/${s3Key}`)
        return { success: true, s3Key }
    } catch (err) {
        const msg = (err as Error).message
        console.error(`[archivist/s3] Failed to archive session ${sessionId}:`, msg)
        return { success: false, error: msg }
    }
}

/**
 * Returns true if S3 archiving is configured.
 */
export function isS3Enabled(): boolean {
    return !!process.env.AWS_S3_BUCKET
}
