import { ToolResult } from '../hooks.js'
import { captureAriaSnapshot } from '../browser.js'

interface TransportParams {
    origin: string
    destination: string
    mode?: 'driving' | 'transit' | 'walking'
}

/**
 * Estimate travel time and distance between two places using a Google Maps page snapshot.
 *
 * Builds a Google Maps directions URL for the given origin and destination, captures a textual ARIA snapshot of the page, and returns a concise summary plus the snapshot URL.
 *
 * @param params.origin - Start location
 * @param params.destination - End location
 * @param params.mode - Mode of transport; defaults to `'driving'`. Allowed values: `'driving' | 'transit' | 'walking'`
 * @returns A ToolResult containing a human-readable summary in `data`. On success `raw.url` contains the snapshot URL; on failure `data` contains an error message and `success` is `false`.
 */
export async function getTransportEstimate(params: TransportParams): Promise<ToolResult> {
    const { origin, destination, mode = 'driving' } = params

    try {
        const url = `https://www.google.com/maps/dir/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}`

        // We use the snapshot to get the text content. 
        // Google Maps is complex, but often the duration/distance is in the title or approachable text.
        // Ideally we would use Distance Matrix API, but this is a browser scraping demo.

        const snapshot = await captureAriaSnapshot(url)

        if (!snapshot.content) {
            return {
                success: false,
                data: 'Failed to retrieve transport info from Google Maps.',
            }
        }

        // Simplistic text parsing from the snapshot
        // Google Maps usually puts "20 min (5.0 miles)" prominently.
        // This is brittle but demonstrates the "Aria Snapshot" usage.

        // We'll limit the content to first 500 chars to avoid noise
        const summary = snapshot.content.slice(0, 500).replace(/\s+/g, ' ')

        return {
            success: true,
            data: `Transport estimate from ${origin} to ${destination} (${mode}):\nSource: Google Maps\nSnapshot Text: ${summary}...`,
            raw: { url: snapshot.url }
        }

    } catch (error: any) {
        console.error('[Compare Tool] Error:', error)
        return {
            success: false,
            data: `Error checking transport: ${error.message}`,
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