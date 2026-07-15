# Codex2Frp v1.4.0

Codex2Frp v1.4.0 is a backend-only public release corresponding to the internal 2.4.0 capability line. It does not contain a phone client, application package, signing material, screenshots, account data, or local runtime state.

## Highlights

- Negotiates the Codex 0.144.2 app-server schema from observed schema hashes and critical union shapes.
- Keeps desktop-visible commentary, plans, reasoning summaries, safe operation detail, and lifecycle duration in the public timeline while excluding hidden reasoning and raw tool payloads.
- Groups commands, file edits, image views, and related operations only while they are visibly consecutive; narrative messages create the same boundaries seen on the desktop.
- Confirms exact desktop task selection and fails closed rather than publishing stale or guessed selection state.
- Reports capability availability, runtime readiness, confirmed mutations, and readback support separately.
- Preserves stable user-message and same-name attachment identity across snapshots, deltas, history reconciliation, and restart paths.
- Exposes subagents only as sanitized names and lifecycle states, including safe running updates. Prompts, messages, tool data, child identifiers, and inter-agent content are never forwarded.
- Retains only complete authoritative collaboration presets; incomplete future rows, plugins, and subagents never become invented modes.
- Persists authoritative turn diffs across restarts, including binary changes and safe decoding of real Git paths with spaces or quoted UTF-8 names.
- Filters Codex internal environment context per message part while preserving ordinary visible XML, user text, and supported attachments.
- Covers current desktop image-view, file-edit, command, mixed-operation, transient thought, and attachment message shapes with stable chronological identity.

## Security and privacy

Public event and history DTOs use allowlists. Local paths, raw command output, raw arguments, payloads, hidden reasoning, tokens, child-session content, and private attachment sources are excluded from public JSON. Attachment downloads use short-lived public capability URLs.

## Verification

Verify `Codex2FrpSetup-v1.4.0.exe` against `SHA256SUMS.txt` before installation.

The Windows installer is distributed without an Authenticode signature; verify its SHA-256 checksum before running it.
