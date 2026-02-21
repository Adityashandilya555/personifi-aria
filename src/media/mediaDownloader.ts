/**
 * Media Downloader — Download-first pipeline for Telegram delivery
 *
 * CDN URLs from Instagram, TikTok, etc. expire within hours.
 * Telegram can't reliably follow redirects or handle auth-gated CDN URLs.
 *
 * The correct pattern:
 *   Scraper → CDN URL → Download to buffer → Upload to Telegram via multipart
 *
 * This module handles:
 * 1. Downloading video/image from CDN to in-memory Buffer
 * 2. Uploading via multipart FormData to Telegram Bot API
 * 3. file_id caching for re-sends (Telegram stores files permanently)
 * 4. sendAnimation for GIF/silent MP4 (auto-play, loop)
 * 5. 20MB URL limit guard → always use multipart for videos
 *
 * Constraints (Telegram Bot API v9.4):
 *   - URL-based sending: 20 MB max (unreliable for CDN URLs anyway)
 *   - Multipart upload: 50 MB max (standard API)
 *   - file_id re-send: no size limit, instant
 */

import { markMediaSent } from './reelPipeline.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DownloadedMedia {
    buffer: Buffer
    mimeType: string
    fileName: string
    sizeBytes: number
    hasAudio: boolean | null  // null = unknown
}

export interface TelegramSendResult {
    success: boolean
    fileId?: string         // Telegram's file_id for re-sending
    messageId?: number
    error?: string
}

/** Cached file_ids: key = "source:reelId", value = Telegram file_id */
const fileIdCache = new Map<string, string>()

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024  // 50 MB (Telegram multipart limit)
const DOWNLOAD_TIMEOUT = 30_000              // 30 seconds
const MAX_CAPTION_LENGTH = 1024              // Telegram limit

// ─── Download from CDN ──────────────────────────────────────────────────────

/**
 * Download a media file from a CDN URL into memory.
 * Returns null if download fails, is too large, or times out.
 *
 * Instagram CDN URLs have `oe=` hex expiry — download IMMEDIATELY.
 * TikTok CDN URLs may require specific headers (handled here).
 */
export async function downloadMedia(
    url: string,
    source: 'instagram' | 'tiktok' | 'youtube'
): Promise<DownloadedMedia | null> {
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT)

        // Set appropriate headers for each platform's CDN
        const headers: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        }

        if (source === 'tiktok') {
            headers['Referer'] = 'https://www.tiktok.com/'
        } else if (source === 'instagram') {
            headers['Referer'] = 'https://www.instagram.com/'
        }

        const resp = await fetch(url, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!resp.ok) {
            console.error(`[MediaDownloader] HTTP ${resp.status} for ${source} URL`)
            return null
        }

        // Check Content-Length before downloading fully
        const contentLength = parseInt(resp.headers.get('content-length') || '0')
        if (contentLength > MAX_DOWNLOAD_SIZE) {
            console.warn(`[MediaDownloader] File too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB`)
            return null
        }

        const arrayBuffer = await resp.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        if (buffer.length > MAX_DOWNLOAD_SIZE) {
            console.warn(`[MediaDownloader] Downloaded buffer too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)
            return null
        }

        if (buffer.length < 1024) {
            console.warn(`[MediaDownloader] Downloaded file suspiciously small: ${buffer.length} bytes`)
            return null
        }

        // Detect MIME type from response headers or magic bytes
        const contentType = resp.headers.get('content-type') || ''
        const mimeType = detectMimeType(buffer, contentType)
        const ext = mimeExtension(mimeType)
        const fileName = `aria_${source}_${Date.now()}.${ext}`

        console.log(`[MediaDownloader] Downloaded ${(buffer.length / 1024).toFixed(0)} KB ${mimeType} from ${source}`)

        return {
            buffer,
            mimeType,
            fileName,
            sizeBytes: buffer.length,
            hasAudio: null, // would need ffprobe to detect; assume unknown
        }
    } catch (err: any) {
        if (err?.name === 'AbortError') {
            console.error(`[MediaDownloader] Download timed out for ${source}`)
        } else {
            console.error(`[MediaDownloader] Download failed for ${source}:`, err?.message)
        }
        return null
    }
}

// ─── MIME Detection ─────────────────────────────────────────────────────────

function detectMimeType(buffer: Buffer, contentType: string): string {
    // Check magic bytes first (more reliable than Content-Type)
    if (buffer.length >= 8) {
        // MP4: ftyp at offset 4
        if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
            return 'video/mp4'
        }
        // WebM: 0x1A 0x45 0xDF 0xA3
        if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
            return 'video/webm'
        }
        // GIF: GIF89a or GIF87a
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
            return 'image/gif'
        }
        // JPEG: FF D8 FF
        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
            return 'image/jpeg'
        }
        // PNG: 89 50 4E 47
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            return 'image/png'
        }
        // WebP: RIFF....WEBP
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
            && buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
            return 'image/webp'
        }
    }

    // Fall back to Content-Type header
    if (contentType.includes('mp4') || contentType.includes('video')) return 'video/mp4'
    if (contentType.includes('gif')) return 'image/gif'
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'image/jpeg'
    if (contentType.includes('png')) return 'image/png'
    if (contentType.includes('webp')) return 'image/webp'
    if (contentType.includes('webm')) return 'video/webm'

    // Default to mp4 for unknown (most social media reels are MP4)
    return 'video/mp4'
}

function mimeExtension(mime: string): string {
    const map: Record<string, string> = {
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'image/gif': 'gif',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
    }
    return map[mime] || 'mp4'
}

// ─── Telegram Multipart Upload ──────────────────────────────────────────────

/**
 * Upload a downloaded video to Telegram via multipart FormData.
 * This is the ONLY reliable way to send social media content.
 *
 * Uses the Blob API available in Node 18+.
 */
export async function uploadVideoToTelegram(
    chatId: string,
    media: DownloadedMedia,
    caption: string,
    options: {
        supportsStreaming?: boolean
        hasSpoiler?: boolean
    } = {}
): Promise<TelegramSendResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return { success: false, error: 'No bot token' }

    const truncatedCaption = caption.slice(0, MAX_CAPTION_LENGTH)

    // Determine whether to use sendVideo or sendAnimation
    const isGif = media.mimeType === 'image/gif'
    const method = isGif ? 'sendAnimation' : 'sendVideo'
    const fieldName = isGif ? 'animation' : 'video'

    try {
        const formData = new FormData()
        formData.append('chat_id', chatId)

        // Create a Blob from the buffer for multipart upload
        const blob = new Blob([new Uint8Array(media.buffer)], { type: media.mimeType })
        formData.append(fieldName, blob, media.fileName)

        formData.append('caption', truncatedCaption)
        formData.append('parse_mode', 'HTML')

        if (!isGif) {
            formData.append('supports_streaming', String(options.supportsStreaming !== false))
        }
        if (options.hasSpoiler) {
            formData.append('has_spoiler', 'true')
        }

        const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            body: formData,
        })

        const data = await resp.json() as any

        if (!data.ok) {
            console.error(`[MediaDownloader] Telegram ${method} failed:`, data.description)
            return { success: false, error: data.description }
        }

        // Extract file_id for future re-sends
        const result = data.result
        const fileId = isGif
            ? result?.animation?.file_id
            : result?.video?.file_id
        const messageId = result?.message_id

        console.log(`[MediaDownloader] Telegram ${method} success: file_id=${fileId?.slice(0, 20)}...`)

        return { success: true, fileId, messageId }
    } catch (err: any) {
        console.error(`[MediaDownloader] Telegram upload error:`, err?.message)
        return { success: false, error: err?.message }
    }
}

/**
 * Upload a downloaded photo to Telegram via multipart FormData.
 */
export async function uploadPhotoToTelegram(
    chatId: string,
    media: DownloadedMedia,
    caption: string
): Promise<TelegramSendResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return { success: false, error: 'No bot token' }

    try {
        const formData = new FormData()
        formData.append('chat_id', chatId)

        const blob = new Blob([new Uint8Array(media.buffer)], { type: media.mimeType })
        formData.append('photo', blob, media.fileName)

        formData.append('caption', caption.slice(0, MAX_CAPTION_LENGTH))
        formData.append('parse_mode', 'HTML')

        const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST',
            body: formData,
        })

        const data = await resp.json() as any

        if (!data.ok) {
            console.error(`[MediaDownloader] Telegram sendPhoto failed:`, data.description)
            return { success: false, error: data.description }
        }

        const fileId = data.result?.photo?.slice(-1)?.[0]?.file_id
        return { success: true, fileId, messageId: data.result?.message_id }
    } catch (err: any) {
        console.error(`[MediaDownloader] Telegram photo upload error:`, err?.message)
        return { success: false, error: err?.message }
    }
}

/**
 * Re-send a previously uploaded file using its file_id.
 * Instant, no size limits, no re-upload needed.
 */
export async function resendByFileId(
    chatId: string,
    fileId: string,
    type: 'video' | 'photo' | 'animation',
    caption: string
): Promise<TelegramSendResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return { success: false, error: 'No bot token' }

    const methodMap = { video: 'sendVideo', photo: 'sendPhoto', animation: 'sendAnimation' }
    const fieldMap = { video: 'video', photo: 'photo', animation: 'animation' }
    const method = methodMap[type]
    const field = fieldMap[type]

    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                [field]: fileId,
                caption: caption.slice(0, MAX_CAPTION_LENGTH),
                parse_mode: 'HTML',
                ...(type === 'video' ? { supports_streaming: true } : {}),
            }),
        })

        const data = await resp.json() as any
        if (!data.ok) {
            return { success: false, error: data.description }
        }
        return { success: true, fileId, messageId: data.result?.message_id }
    } catch (err: any) {
        return { success: false, error: err?.message }
    }
}

// ─── file_id Cache ──────────────────────────────────────────────────────────

/** Cache a Telegram file_id for a reel (source:reelId → file_id) */
export function cacheFileId(source: string, reelId: string, fileId: string): void {
    fileIdCache.set(`${source}:${reelId}`, fileId)
    // Cap cache at 1000 entries
    if (fileIdCache.size > 1000) {
        const keys = Array.from(fileIdCache.keys())
        for (let i = 0; i < 200; i++) {
            fileIdCache.delete(keys[i])
        }
    }
}

/** Get a cached file_id for a reel */
export function getCachedFileId(source: string, reelId: string): string | undefined {
    return fileIdCache.get(`${source}:${reelId}`)
}

// ─── High-Level: Download + Upload Pipeline ─────────────────────────────────

/**
 * The full download-first pipeline for sending media to Telegram.
 *
 * 1. Check file_id cache → instant re-send if available
 * 2. Download from CDN URL to buffer
 * 3. Upload to Telegram via multipart FormData
 * 4. Cache the returned file_id
 *
 * Returns: whether it was sent successfully.
 */
export async function sendMediaViaPipeline(
    chatId: string,
    reel: {
        id: string
        source: 'instagram' | 'tiktok' | 'youtube'
        videoUrl: string | null
        thumbnailUrl: string | null
        type: 'video' | 'image'
    },
    caption: string
): Promise<boolean> {
    // Step 1: Check file_id cache
    const cachedId = getCachedFileId(reel.source, reel.id)
    if (cachedId) {
        console.log(`[MediaPipeline] Re-sending via file_id for ${reel.source}:${reel.id}`)
        const mediaType = reel.type === 'video' ? 'video' : 'photo'
        const result = await resendByFileId(chatId, cachedId, mediaType, caption)
        if (result.success) return true
        // file_id might be stale → fall through to re-download
        console.warn(`[MediaPipeline] file_id re-send failed, re-downloading`)
    }

    // Step 2: Determine the download URL
    const downloadUrl = reel.type === 'video' ? reel.videoUrl : (reel.thumbnailUrl || reel.videoUrl)
    if (!downloadUrl) {
        console.error(`[MediaPipeline] No URL available for ${reel.source}:${reel.id}`)
        return false
    }

    // YouTube URLs are not direct CDN links — can't download the actual video
    // Send as text link instead
    if (reel.source === 'youtube' && reel.videoUrl) {
        return sendTextFallback(chatId, caption, reel.videoUrl)
    }

    // Step 3: Download from CDN
    console.log(`[MediaPipeline] Downloading ${reel.type} from ${reel.source} CDN...`)
    const downloaded = await downloadMedia(downloadUrl, reel.source)
    if (!downloaded) {
        console.warn(`[MediaPipeline] Download failed, trying thumbnail fallback`)

        // Try thumbnail as fallback for videos
        if (reel.type === 'video' && reel.thumbnailUrl) {
            const thumbDownload = await downloadMedia(reel.thumbnailUrl, reel.source)
            if (thumbDownload && thumbDownload.mimeType.startsWith('image/')) {
                const result = await uploadPhotoToTelegram(chatId, thumbDownload, caption)
                if (result.success && result.fileId) {
                    cacheFileId(reel.source, reel.id, result.fileId)
                }
                return result.success
            }
        }

        // Final fallback: send as text with URL
        if (reel.videoUrl) {
            return sendTextFallback(chatId, caption, reel.videoUrl)
        }
        return false
    }

    // Step 4: Upload to Telegram
    const isVideo = downloaded.mimeType.startsWith('video/') || downloaded.mimeType === 'image/gif'
    let result: TelegramSendResult

    if (isVideo) {
        result = await uploadVideoToTelegram(chatId, downloaded, caption, {
            supportsStreaming: true,
        })
    } else {
        result = await uploadPhotoToTelegram(chatId, downloaded, caption)
    }

    // Step 5: Cache the file_id for instant re-sends
    if (result.success && result.fileId) {
        cacheFileId(reel.source, reel.id, result.fileId)
        // Write telegram_file_id back to scraped_media DB for persistent re-sends
        markMediaSent(reel.id, result.fileId).catch(() => {})
        console.log(`[MediaPipeline] Cached file_id for ${reel.source}:${reel.id}`)
    }

    return result.success
}

// ─── Text fallback ──────────────────────────────────────────────────────────

async function sendTextFallback(chatId: string, caption: string, url: string): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return false

    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `${caption}\n\n${url}`,
                parse_mode: 'HTML',
                disable_web_page_preview: false, // let Telegram show link preview
            }),
        })
        const data = await resp.json() as any
        return data.ok === true
    } catch {
        return false
    }
}
