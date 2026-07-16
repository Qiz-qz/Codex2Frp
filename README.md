# Codex2Frp

Codex2Frp is a Windows backend bridge for controlling an existing Codex Desktop session from a phone or browser. It exposes a local HTTP API, a browser console, a Windows control panel, and optional remote-link access for off-LAN use.

Current version: `v1.4.3`.

This public release corresponds to the feature set developed on the internal Codex2Frp 2.4.3 capability line while retaining the repository's independent `v1.x` public version history.

## What It Does

- Bridges Codex Desktop threads, history, status, attachments, model controls, reasoning controls, and speed controls to HTTP clients.
- Provides a reduced built-in browser console for viewing threads, sending messages, and checking connection status without the mobile app.
- Ships a Windows control panel for starting and stopping the local backend, copying access links, saving a remote-link route, opening logs, and enabling Codex control.
- Uses Codex Desktop through the real UI when sending text or changing model, reasoning, speed, and composer menu actions.
- Keeps passive `/codex/status` and `/codex/config` polling read-only; those calls do not open Codex menus or launch extra Codex clients.
- Supports local, LAN, and manually configured remote-link routes.

Codex2Frp is not a hosted chat service and does not include a model. It operates your local Codex Desktop session.

## Repository Layout

```text
bin/                         Smoke-test helpers
lib/                         Backend utilities
public/                      Built-in browser console
scripts/                     Windows runtime and build scripts
test/                        Node test suite
windows/launcher/            Windows control panel source
windows/installer/           Windows installer source
release/v1.4.3/              Latest public installer release
server.js                    Backend HTTP server
```

## Install

Download the latest installer from this repository:

```text
release/v1.4.3/Codex2FrpSetup-v1.4.3.exe
```

Verify the installer with:

```text
release/v1.4.3/SHA256SUMS.txt
```

The current SHA-256 is recorded in:

```text
release/v1.4.3/SHA256SUMS.txt
```

The installer can be run graphically, or silently:

```powershell
Codex2FrpSetup-v1.4.3.exe --silent --install-dir E:\Codex2Frp
```

## Run

Start the control panel:

```powershell
E:\Codex2Frp\Codex2Frp.exe
```

The backend service does not start automatically when the control panel opens. Click **Start Service** in the control panel when you want the backend to listen on port `8988`.

Default local URLs:

```text
http://127.0.0.1:8988/?token=YOUR_LOCAL_TOKEN
http://192.168.x.x:8988/?token=YOUR_LOCAL_TOKEN
```

The token is generated locally and stored in:

```text
E:\Codex2Frp\.runtime\mobile-token.txt
```

For unattended local startup:

```powershell
E:\Codex2Frp\Codex2Frp.exe --silent --start-service
```

## Remote Link Access

Remote access is manual. Configure your own trusted TCP/HTTPS tunnel that forwards to:

```text
127.0.0.1:8988
```

Then fill the remote host and remote port in the control panel. Codex2Frp verifies the remote route by calling:

```text
/codex/health
```

If the configured remote link is unreachable, startup checks and the copy-remote-link button show:

```text
远程连接网络未启动，当前仅支持局域网连接。
```

Until the remote link becomes reachable, use the LAN link instead.

## API Overview

All API calls require the local access token.

Common endpoints:

- `GET /codex/health`
- `GET /codex/v3/meta`
- `GET /codex/v3/diagnostics`
- `GET /codex/v3/threads`
- `GET /codex/v3/threads/:id/status`
- `GET /codex/v3/threads/:id/events`
- `GET /codex/v3/threads/:id/events/snapshot`
- `GET /codex/v3/threads/:id/events/cursor`
- `POST /codex/v3/threads/:id/input`
- `GET /codex/v3/threads/:id/queue`
- `PUT /codex/v3/threads/:id/protection`
- `GET /codex/v3/catalogs/models`
- `GET /codex/v3/catalogs/collaboration-modes`
- `GET /codex/config`
- `GET /codex/status`
- `GET /codex/threads`
- `GET /codex/history`
- `GET /codex/attachment`
- `POST /send`
- `POST /codex/stop`
- `POST /codex/new-thread`
- `POST /codex/thread-action`
- `GET /codex/composer-plus-menu`
- `POST /codex/composer-action`
- `POST /codex/model-switch`
- `POST /codex/reasoning-mode`
- `POST /codex/speed-mode`
- `POST /codex/control-port`

Some route names keep legacy compatibility for existing clients, but user-facing text refers to remote links.

## Codex Control

Model switching, reasoning switching, speed switching, message sending, attachment insertion, and composer menu actions require a controllable Codex Desktop window.

The control panel can enable Codex control by restarting Codex Desktop into a single controlled client. This is intentionally explicit because it closes existing Codex client windows before starting the controlled one.

Codex2Frp refuses unsafe UI automation when it detects stop, cancel, terminate, submit, or similar dangerous controls in the wrong context.

## Development

Requirements:

- Windows
- Node.js 18 or newer
- .NET Framework C# compiler available through Windows

Useful commands:

```powershell
npm test
node --check server.js
npm run windows:installer
```

The installer build writes:

```text
dist/Codex2FrpSetup.exe
dist/Codex2FrpSetup-vX.Y.Z.exe
```

For a public release, copy the versioned installer into:

```text
release/vX.Y.Z/
```

and update `SHA256SUMS.txt`.

## Security

- Keep the access token private.
- Do not publish full access URLs that contain `token=...`.
- Do not commit `.runtime/`, logs, private tunnel details, signing material, account data, or local-only configuration.
- Treat remote-link access as exposing your local Codex control surface to a network endpoint.
- Use remote access only through trusted devices and trusted network routes.
- Keep Codex control enabled only on a trusted desktop session.

## Release Notes

### v1.4.3

- Binds explicit phone controls to the Codex renderer process verified for the active CDP port, preventing another Codex window from receiving the action.
- Uses Codex's native `windows.show_thread` renderer action with exact route readback, so task selection works even when no matching sidebar row is mounted.
- Reads the authoritative in-window route for desktop-to-phone task synchronization and exact mutation guards.
- Recognizes the current desktop `Light` and `轻度` reasoning labels while retaining fail-closed selection confirmation.
- Preserves same-task RPC-confirmed model, reasoning, and speed readback when the desktop trigger temporarily reports only a generic custom label.

### v1.4.2

- Adds exact Codex CLI 0.144.5 compatibility only when its generated app-server schema matches the pinned 0.144.2/0.144.5 profile.
- Routes supported desktop controls through the installed renderer RPC bridge with confirmed readback, while unknown or unavailable controls continue to fail closed.
- Keeps passive synchronization focus-free and confines explicit phone actions to a short activation transaction that restores the original window, focus, and minimized state.
- Preserves desktop-visible transient status while commands, edits, images, and subagent lifecycle rows arrive, replacing that status only when the desktop replaces or clears it.
- Groups only visibly consecutive command, file, and image activity, and keeps subagents limited to sanitized names plus lifecycle state.
- Restores historical image previews when a supported filename suffix disagrees with verified PNG/JPEG/GIF/WebP/BMP magic, while rejecting spoofed HEIC/HEIF content.
- Adds confirmed native task navigation and renderer-backed task creation/settings controls without relying on unverified simulated clicks.

### v1.4.0

- Negotiates the Codex 0.144.2 app-server schema from observed schema hashes and critical union shapes instead of relying only on a CLI version label.
- Publishes the desktop-visible timeline with narrative boundaries and consecutively grouped safe operation details, while suppressing hidden reasoning, raw tool payloads, local paths, and subagent content.
- Fails closed when desktop task selection cannot be confirmed, preventing stale or guessed cross-device task state.
- Distinguishes method availability, runtime readiness, confirmed mutations, and readback support so clients expose only verified controls.
- Preserves stable user-message and same-name attachment identity across snapshots, deltas, history reconciliation, and backend restarts.
- Publishes safe desktop lifecycle duration and repeated subagent lifecycle updates while limiting every subagent event to a sanitized name and state.
- Filters collaboration catalogs to complete authoritative presets; incomplete future rows, plugins, and subagents never become invented collaboration modes.
- Persists authoritative per-turn diffs, including binary changes and safely decoded Git paths, so clients can reproduce the desktop file disclosure after restart.
- Rejects Codex internal environment context per message part while preserving ordinary visible user text, XML examples, and supported attachments.

### v1.3.0

- Adapts the public backend to the current Codex app-server protocol with fail-closed schema compatibility checks and expanded structured message types.
- Adds a durable next-turn queue with safe first-turn dispatch, idempotency, reconciliation, concurrent flush coalescing, and DPAPI-protected persistence.
- Keeps background synchronization focus-free and restores the original Codex window placement, minimized state, and foreground focus after explicit mobile actions.
- Exposes allowlisted operation and tool metadata while excluding raw bodies, arguments, outputs, payloads, local paths, child sessions, and inter-agent messages. Subagents expose only a sanitized name and lifecycle state.

### v1.2.0

- Model, reasoning, and speed switches now save the requested mode while Codex is replying, instead of failing the mobile action. The current running reply is left untouched and later tasks use the saved mode.
- Explicit Codex controls now restore a minimized Codex Desktop window before reading the composer plus menu, focusing the composer, switching threads, or sending a stop command.
- Mobile control failures no longer get mistaken for LAN or remote-link failures by the paired app.

### v1.1.0

- `/codex/threads` now reports the current desktop Codex thread id and metadata, so mobile clients can follow desktop-side thread switches without restarting.
- The thread list keeps the current desktop thread in the response even when it would otherwise fall outside the requested list limit.
- Realtime mobile sync now observes desktop thread selection without auto-opening additional Codex clients, including current Codex builds that expose sidebar ids as `local:<thread-id>`.
- The Windows control panel now keeps periodic status refreshes, log reads, remote-link checks, and long Codex-control actions off the WinForms UI thread for smoother clicking and less UI freezing.

## License

See [LICENSE](LICENSE).
