# Codex2Frp v1.4.3

This backend-only public snapshot corresponds to the internal Codex2Frp 2.4.3 capability line.

- Binds explicit phone controls to the Codex renderer process verified for the controlled CDP port.
- Selects tasks through Codex's native `windows.show_thread` renderer action with exact route readback, even when no matching sidebar row is mounted.
- Reads the authoritative in-window route for bidirectional task synchronization and protected-task mutation guards.
- Recognizes the current desktop `Light` and `轻度` reasoning labels while retaining exact selection confirmation.
- Preserves same-task RPC-confirmed model, reasoning, and speed readback when the desktop trigger temporarily exposes only a generic custom label.
- Opens the native Codex home for deferred new-task creation and applies a bounded 15-second initialization timeout to explicit immediate `thread/start` requests.
- Allows explicit task selection to leave the native home route without inventing an active source task, while preserving destination guards and focus restoration.
- Keeps mismatched, unsupported, and unconfirmed navigation or control results fail closed.
- Replaces repeated per-operation PowerShell/C# bridge startup with a SHA-256-named native focus helper executable. The helper is compiled atomically, validated before use, rebuilt only once if corrupt, and receives operation data exclusively through stdin.
- Passes the verified CDP process id into native window enumeration so unrelated windows are discarded before expensive process-name and title reads; unbound discovery retains a per-PID process-name cache.
- Bridges current Codex command, file-change, and permission approval requests through the renderer's native RPC channel so a paired phone can approve or reject them without simulated desktop clicks.
- Exposes only privacy-safe approval summaries to the phone, reconciles renderer reloads and resolved requests, and rejects stale or duplicate responses.
- Persists RPC-confirmed model, reasoning, and service-tier settings atomically per task, while failed RPC calls and task switches cannot leak stale settings.
- Passes all 695 side-effect-free public backend tests, including strict helper input, approval lifecycle, duplicate-response, confirmed-settings, protected-task-safe new-task discovery, exact desktop binding after native task creation, cache recovery, stdin-only transport, process-filter range checks, and bound-window selection coverage.

Only the Windows backend installer and its SHA-256 checksum are intended as GitHub Release assets. Mobile client packages, signing materials, screenshots, local runtime state, and user data are not included.
