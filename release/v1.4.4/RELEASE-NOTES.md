# Codex2Frp v1.4.4

This backend-only public snapshot corresponds to the internal Codex2Frp 2.4.4 capability line.

- Canonicalizes model settings against the current desktop catalog before renderer RPC, including valid single-segment ids such as `o3`, and exposes only reasoning efforts supported by the selected model.
- Protects confirmed model, reasoning, and speed changes with a bounded 15-second per-field, per-task lease while stale desktop samples converge.
- Preserves live desktop model metadata and option provenance through loading, status, and config responses without guessed choices.
- Starts queued first turns on newly created desktop tasks during their bounded `notLoaded` initialization state.
- Removes desktop-hidden plugin and workspace bootstrap context from phone-visible user history and fallback titles while preserving the real user request.
- Passes 709 side-effect-free public backend tests.

Only the Windows backend installer and its SHA-256 checksum are intended as GitHub Release assets. Mobile packages, signing materials, screenshots, local runtime state, private logs, tokens, and user data are not included.
