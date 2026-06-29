# Codex2Frp

Codex2Frp is a Windows backend bridge for controlling an existing Codex Desktop session from a phone or browser. It exposes a local HTTP API, a browser console, a Windows control panel, and optional remote-link access for off-LAN use.

Current version: `v1.1.0`.

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
release/v1.1.0/              Latest public installer release
server.js                    Backend HTTP server
```

## Install

Download the latest installer from this repository:

```text
release/v1.1.0/Codex2FrpSetup-v1.1.0.exe
```

Verify the installer with:

```text
release/v1.1.0/SHA256SUMS.txt
```

The current SHA-256 is:

```text
4e9ed4817c697fe0126957cddc39f39ae1e2bcb964af922b2a0ad08560458a0b  Codex2FrpSetup-v1.1.0.exe
```

The installer can be run graphically, or silently:

```powershell
Codex2FrpSetup-v1.1.0.exe --silent --install-dir E:\Codex2Frp
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

### v1.1.0

- Syncs the public build with the current desktop-thread bridge, including realtime current-thread detection for Codex clients that expose sidebar ids as `local:<thread-id>`.
- `/codex/threads` now reports the current desktop Codex thread id and keeps that thread in the response even when it falls outside the requested list limit.
- Mobile and browser clients can follow desktop-side thread switches without restarting and without auto-opening additional Codex clients.
- The Windows control panel now keeps periodic status refreshes, log reads, remote-link checks, and long Codex-control actions off the WinForms UI thread for smoother clicking and less UI freezing.

### v1.0.0

- First public snapshot of the Windows Codex Desktop bridge, browser console, Windows control panel, and local/LAN/remote-link access flow.

## License

See [LICENSE](LICENSE).
