# Codex2Frp v1.1.0

Public release v1.1.0 syncs the public repository with the current Codex Desktop bridge implementation.

## Highlights

- Adds realtime desktop current-thread reporting in `/codex/threads`.
- Keeps the current desktop thread in thread-list responses even when the requested limit would otherwise omit it.
- Lets mobile and browser clients follow desktop-side thread switches without restarting.
- Supports current Codex sidebar thread ids that are exposed as `local:<thread-id>`.
- Improves Windows control panel responsiveness by moving long actions and periodic status refresh work off the UI thread.
- Keeps the browser console focused on thread viewing, message sending, and connection state.

## Verification

- `npm test` passed: 114 tests.
- `npm run check` passed.
- `npm run windows:build` passed.
- `npm run windows:installer` passed.

## Artifact

- `Codex2FrpSetup-v1.1.0.exe`
- SHA-256: `4e9ed4817c697fe0126957cddc39f39ae1e2bcb964af922b2a0ad08560458a0b`
