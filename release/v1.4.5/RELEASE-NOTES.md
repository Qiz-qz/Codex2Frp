# Codex2Frp v1.4.5

Backend-only compatibility release for the current ChatGPT/Codex Desktop application and Codex CLI `0.145.0-alpha.18`.

## Highlights

- Restores verified desktop controls after the executable rename to ChatGPT, including task switching, new task, model, reasoning, Standard/Fast speed, send, stop, and approval responses.
- Keeps passive synchronization non-activating and restores the original foreground, focus, placement, and minimized state after explicit phone actions.
- Adds complete cursor-based history pagination and adaptive reverse reads without dropping or duplicating messages.
- Scans the current Add menu deeply enough to find real plugins while filtering unknown rows and subagent names.
- Pins the current app-server schema and safely rebinds control after a desktop process restart.
- Passes all 730 side-effect-free backend tests.

The mobile CodexHM package is intentionally not included in this repository or GitHub release.
