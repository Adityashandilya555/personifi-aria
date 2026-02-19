import { describe, it, expect } from 'vitest'
import { generateSixDigitCode } from './identity.js'

describe('generateSixDigitCode', () => {

    it('should generate a 6-digit string', () => {
        const code = generateSixDigitCode()
        expect(code).toMatch(/^\d{6}$/)
    })

    it('should be within the valid 6-digit range', () => {
        const code = generateSixDigitCode()
        const num = parseInt(code, 10)
        expect(num).toBeGreaterThanOrEqual(100000)
        expect(num).toBeLessThan(1000000)
    })

    it('should consistently produce 6-digit codes across many runs', () => {
        for (let i = 0; i < 100; i++) {
            const code = generateSixDigitCode()
            expect(code).toHaveLength(6)
            const num = parseInt(code, 10)
            expect(num).toBeGreaterThanOrEqual(100000)
            expect(num).toBeLessThan(1000000)
        }
    })

    it('should produce varying codes (not constant)', () => {
        const codes = new Set<string>()
        for (let i = 0; i < 20; i++) {
            codes.add(generateSixDigitCode())
        }
        // With 900,000 possible values, 20 draws should produce at least 2 unique codes
        expect(codes.size).toBeGreaterThan(1)
    })
})
