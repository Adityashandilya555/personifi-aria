feat: Implement Brain/Router (DEV 1) handoff

## Description
Implements the Brain / Router layer for Personifi Aria (DEV 1 handoff).
This PR includes:
- **Hook Implementation**: `BrainHooks` in `src/brain/index.ts` to route messages and execute tool pipelines.
- **Routing Logic**: Regex-based parameter extraction for `search_flights` and `search_hotels`.
- **Tool Execution**: Orchestrates calls to `BodyHooks` (DEV 2) and formats output for Layer 8 injection.
- **Tests**: Comprehensive unit tests in `src/brain/router.test.ts`.
- **Integration**: Registered hooks in `src/index.ts`.

## Checklist
- [x] Implemented `BrainHooks` interface
- [x] Added unit tests for routing and execution
- [x] Registered hooks in entry file
- [x] Verified build (`npm run build`)
- [x] Verified tests (`npm test`)

## Verification
- Run `npm test` to verify logic.
- Run `npm run build` to verify types.
