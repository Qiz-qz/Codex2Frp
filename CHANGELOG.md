# Changelog

## [1.3.0] - 2026-07-13

This public snapshot corresponds to the internal Codex2Frp 2.3.0 capability line while preserving the public repository's independent version history.

- Codex compatibility now follows the current app-server protocol and an installed-schema drift gate.
- Added durable queued input, DPAPI persistence fixes, first-turn dispatch, reconciliation, and deadlock-safe concurrent flushes.
- Preserved window focus, placement, and minimized state around explicit mobile UI actions; passive realtime synchronization remains focus-free.
- Strengthened message privacy with safe structured activity metadata while excluding bodies, arguments, outputs, payloads, local paths, child sessions, and inter-agent content.
- Kept subagent presentation limited to sanitized name and lifecycle state.
