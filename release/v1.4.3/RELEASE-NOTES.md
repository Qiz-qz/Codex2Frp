# Codex2Frp v1.4.3

This backend-only public snapshot corresponds to the internal Codex2Frp 2.4.3 capability line.

- Binds explicit phone controls to the Codex renderer process verified for the controlled CDP port.
- Selects tasks through Codex's native `windows.show_thread` renderer action with exact route readback, even when no matching sidebar row is mounted.
- Reads the authoritative in-window route for bidirectional task synchronization and protected-task mutation guards.
- Recognizes the current desktop `Light` and `轻度` reasoning labels while retaining exact selection confirmation.
- Preserves same-task RPC-confirmed model, reasoning, and speed readback when the desktop trigger temporarily exposes only a generic custom label.
- Keeps mismatched, unsupported, and unconfirmed navigation or control results fail closed.

Only the Windows backend installer and its SHA-256 checksum are intended as GitHub Release assets. Mobile client packages, signing materials, screenshots, local runtime state, and user data are not included.
