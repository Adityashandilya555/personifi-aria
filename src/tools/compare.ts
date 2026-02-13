import type { ToolExecutionResult } from '../hooks.js'
import { captureAriaSnapshot } from '../browser.js'

interface TransportParams {
    origin: string
    destination: string
    mode?: 'driving' | 'transit' | 'walking'
}

/**
 * Get transport estimate using Google Maps (web scraping)
 */
export async function getTransportEstimate(params: TransportParams): Promise<ToolExecutionResult> {
    const { origin, destination, mode = 'driving' } = params

    try {
        const modeMap: Record<string, string> = { driving: '0', transit: '3', walking: '2' }
        const modeParam = modeMap[mode] || '0'
        const url = `https://www.google.com/maps/dir/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/data=!4m2!4m1!3e${modeParam}`

        // We use the snapshot to get the text content. 
        // Google Maps is complex, but often the duration/distance is in the title or approachable text.
        // Ideally we would use Distance Matrix API, but this is a browser scraping demo.

        const snapshot = await captureAriaSnapshot(url)

        if (!snapshot.content) {
            return {
                success: false,
                data: null,
                error: 'Failed to retrieve transport info from Google Maps.',
            }
        }

        // Simplistic text parsing from the snapshot
        // Google Maps usually puts "20 min (5.0 miles)" prominently.
        // This is brittle but demonstrates the "Aria Snapshot" usage.

        // We'll limit the content to first 500 chars to avoid noise
        const summary = snapshot.content.slice(0, 500).replace(/\s+/g, ' ')

        return {
            success: true,
            data: { formatted: `Transport estimate from ${origin} to ${destination} (${mode}):\nSource: Google Maps\nSnapshot Text: ${summary}...`, raw: { url: snapshot.url } },
        }

    } catch (error: any) {
        console.error('[Compare Tool] Error:', error)
        return {
            success: false,
            data: null,
            error: `Error checking transport: ${error.message}`,
        }
    }
}

export const compareToolDefinition = {
    name: 'get_transport_estimate',
    description: 'Get travel time/distance estimate between two places.',
    parameters: {
        type: 'object',
        properties: {
            origin: {
                type: 'string',
                description: 'Start location',
            },
            destination: {
                type: 'string',
                description: 'End location',
            },
            mode: {
                type: 'string',
                enum: ['driving', 'transit', 'walking'],
                description: 'Mode of transport (default: driving)',
            },
        },
        required: ['origin', 'destination'],
    },
}
