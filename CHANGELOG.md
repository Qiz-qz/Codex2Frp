# Changelog

## [1.4.22] - 2026-07-20

- Publishes a stable per-turn `presentationRevision`, so the phone refreshes in-place ChatGPT process changes even when the transport cursor or turn shell remains unchanged.
- Preserves the complete privacy-safe desktop timeline in realtime and completed-task projections, including ordered command, file, image, plan, commentary, and reconnect activities.
- Treats guidance as an explicit `mobile-steer-*` identity instead of inferring it from ordinary desktop delivery, preventing normal messages from being mislabeled as guided.
- Bounds the realtime revision journal and recovers lagging clients with an authoritative snapshot instead of allowing unbounded backend memory growth.
- Keeps subagent content private while retaining only the desktop-visible lifecycle identity required by the phone UI.

This public backend release corresponds to internal Codex2Frp 2.4.22 and remains backend-only.

## [1.4.18] - 2026-07-19

- Projects current ChatGPT computer-use activities as a dedicated privacy-safe surface kind, so mobile clients can display their desktop-equivalent identity instead of a generic Node.js tool row.
- Keeps computer-use app names, raw arguments, tool results, local paths and other private metadata outside the public DTO.
- Makes same-turn guidance atomic across request acknowledgement and queue state, preventing accepted guidance from being reported as unapplied during an active task.
- Preserves authoritative user/progress turn identity so mobile waiting-response shells can disappear as soon as real desktop progress begins.

This public backend release corresponds to internal Codex2Frp 2.4.18 and remains backend-only.

## [1.4.15] - 2026-07-18

- Prevents the Windows launcher from inheriting `CODEX_THREAD_ID` as an immutable mobile-control restriction.
- Merges every privacy-safe process narrative and action from guided turns before history paging and detail caching, preserving desktop-visible order in completed process sheets.
- Reads very large JSONL task histories in bounded UTF-8 chunks with stable backward cursors instead of loading the entire file.
- Allows an explicit phone-initiated task switch to use the native `codex://threads/<uuid>` route when CDP is unavailable, while restoring the original focus, placement, and minimized state.
- Keeps the public DTO boundary strict: no local paths, private reasoning payloads, user bodies, or subagent message content are exposed.

This public backend release corresponds to internal Codex2Frp 2.4.15 and remains backend-only.

## [1.4.13] - 2026-07-18

- Preserves the complete privacy-safe visible timeline for completed process details, including narrative, images, commands, file edits and subagent lifecycle rows in desktop order.
- Keeps raw paged command/file activity available as a secondary process-detail source while allowing mobile clients to render the desktop-equivalent timeline first.
- Replaces the consuming foreground-notice snapshot with a bounded persistent event ring and independent per-client cursors, so background task start/completion notifications survive reconnects and backend restarts.
- Persists only strict notification metadata and enriches process images through opaque capability URLs; local paths, user bodies, final text, raw events and subagent content remain private.
- Retains current ChatGPT/Codex Desktop control, dual-stack CDP discovery, task protection, queue/steer and focus-restoration behavior.

This public backend release corresponds to internal Codex2Frp 2.4.13 and remains backend-only.

## [1.4.11] - 2026-07-18

This public backend snapshot adapts explicit desktop control and image history to the current ChatGPT/Codex Desktop runtime while preserving the repository's independent `v1.x` history.

- Resolves the renderer CDP websocket against the address family that actually accepted the endpoint, including current IPv6 loopback listeners, so model, reasoning, speed, task selection, and other explicit controls reach the verified desktop window.
- Coalesces named user-image envelopes with their materialized capability representations by stable image order, preventing duplicate phone attachments without merging genuinely different images.
- Keeps next-turn model, reasoning, and speed settings scoped to the exact composer request instead of leaking stale defaults into a queued message.
- Expands the side-effect-free backend suite to 757 passing tests.

## [1.4.10] - 2026-07-18

This public backend snapshot targets the current ChatGPT/Codex Desktop message shapes while preserving the repository's independent `v1.x` version history.

- Restores real privacy-safe command details from current `shell_command` events instead of generic run placeholders.
- Projects current direct file-edit activity into repository-relative file labels, change kinds, and diff counts.
- Preserves command and file detail across completed-task projection and cursor pagination.
- Keeps raw arguments, output, absolute paths, credentials, and subagent message bodies private.
- Expands the side-effect-free backend suite to 752 passing tests.

## [1.4.9] - 2026-07-18

This public backend snapshot targets the current ChatGPT/Codex Desktop capability line while preserving the repository's independent `v1.x` version history.

- Adds bounded, cursor-based pagination for command, edit, and image process details, including completed-task image capabilities.
- Adds compact passive status responses and selection-only thread polling to keep realtime synchronization responsive on long, actively updating tasks.
- Keeps the latest desktop-visible transient status stable until ChatGPT replaces or clears it, while consecutive activity grouping still breaks at intervening thought or commentary.
- Preserves model, reasoning, and Standard/Fast speed settings across transient read gaps without overriding later desktop changes.
- Coalesces nested attachment and image envelopes in desktop source order and keeps public capability URLs opaque.
- Expands the side-effect-free backend contracts for process-detail caching, cursor pagination, compact polling, settings reconciliation, approvals, and protected task control.

## [1.4.7] - 2026-07-18

This public backend snapshot targets the current ChatGPT/Codex Desktop capability line while preserving the repository's independent `v1.x` version history.

- Long threads open from a compact 12-row cursor page and load older history on demand, avoiding a misleading retry state during normal large-history reads.
- Nested or indented ChatGPT file/image envelopes now coalesce with their desktop presentation in original source order, so an attachment-rich user message is not duplicated or reordered.
- Model, reasoning, and Standard/Fast speed state retains a same-thread, observed session fallback across transient CDP gaps, then refreshes when the desktop session changes; no global config or other thread is used as a substitute.
- Keeps output image capabilities bounded and opaque, including images in completed process details.
- The side-effect-free public backend suite passes 731 tests.

## [1.4.5] - 2026-07-17

This public snapshot corresponds to the internal Codex2Frp 2.4.5 capability line while preserving the public repository's independent version history.

- ChatGPT and Codex desktop process/window names are normalized for explicit control while preserving exact focus, minimized-state, and protected-task restoration.
- Supported models expose both Standard and Fast speed options; deep Add-menu scanning publishes classified plugins and suppresses unknown subagent names.
- Cursor pagination and adaptive reverse history reads remove the previous fixed-window ceiling without dropping or duplicating messages.
- The exact Codex CLI `0.145.0-alpha.18` schema is pinned, including environment status requests and environment connection notifications.
- Current renderer RPC discovery, process rebinding, and clean shutdown handling restore model, reasoning, speed, task switching, new-task, send, stop, and approval controls after the desktop application rename to ChatGPT.
- Expands the side-effect-free public backend suite to 730 passing tests.

## [1.4.4] - 2026-07-17

This public snapshot corresponds to the internal Codex2Frp 2.4.4 capability line while preserving the public repository's independent version history.

- Model and reasoning settings canonicalize against the live desktop catalog before renderer RPC, including valid single-segment model ids such as `o3`, and expose only efforts supported by the current model.
- A bounded 15-second confirmation lease prevents an older composer DOM sample from immediately reverting a confirmed model, reasoning, or speed change; matching readback converges early and desktop changes become authoritative after expiry.
- Loading and control compatibility preserve confirmed settings across older status/config snapshots, reject legacy writes without an exact task id, and isolate per-field confirmations between tasks.
- Live model metadata retains supported reasoning levels, defaults, speed tiers, and option provenance without guessed choices.
- Queued first turns can start on newly created desktop tasks during the bounded app-server `notLoaded` initialization state.
- Desktop-hidden plugin and workspace bootstrap context is removed from phone-visible history and fallback titles without hiding the real user request.
- Expands the side-effect-free public backend suite to 709 passing tests.

## [1.4.3] - 2026-07-16

This public snapshot corresponds to the internal Codex2Frp 2.4.3 capability line while preserving the public repository's independent version history.

- Binds explicit UI and process-control transactions to the Codex window owned by the process verified for the controlled CDP port.
- Selects tasks through the renderer-native `windows.show_thread` action and exact route readback instead of requiring a mounted sidebar row or dispatching a system-wide deep link.
- Reads the authoritative in-window route summary for bidirectional task synchronization and exact protected-task mutation guards.
- Recognizes the current desktop `Light` and `轻度` reasoning labels while preserving exact selected-effort confirmation.
- Stores confirmed control overrides against the exact task and uses them as explicitly labeled readback only when that same task's desktop trigger exposes no exact value.
- Preserves native plus-button semantics through renderer-bound `windows.show_home`, while immediate `thread/start` receives a dedicated bounded initialization timeout.
- Lets `thread.openDesktop` leave the native home route without fabricating an active source task; the requested destination remains protected before discovery and again under the global UI lock.
- Keeps unsupported, mismatched, and unconfirmed navigation or control results fail closed.
- Replaces per-operation PowerShell startup and C# recompilation with a SHA-256-named native focus helper; requests remain on stdin, cache writes are atomic, and a corrupt helper is rebuilt at most once before failing closed.
- Passes the CDP-bound process id into native window enumeration so unrelated HWNDs are rejected before process-name and title inspection, with process-name caching retained for unbound discovery.
- Bridges current renderer command, file-change, and permission approvals to paired phones with privacy-safe summaries and stale/duplicate-response protection.
- Persists RPC-confirmed model, reasoning, and service-tier settings atomically per task.
- Expands the side-effect-free public backend suite to 695 passing tests, including approval lifecycle, confirmed settings, protected-task-safe new-task discovery, exact desktop binding after native task creation, helper caching, corruption recovery, stdin-only requests, strict process-filter validation, and bound-window filtering.

## [1.4.2] - 2026-07-16

This public snapshot corresponds to the internal Codex2Frp 2.4.2 capability line while preserving the public repository's independent version history.

- Accepts installed Codex CLI 0.144.5 only through the exact pinned 0.144.2/0.144.5 schema hash and critical unions.
- Adds confirmed renderer-internal RPC controls for task navigation, creation, settings, sending, steering, interruption, archive, rename, pin, and related supported actions.
- Keeps explicit phone UI work inside focus-safe transactions and restores original foreground, focused HWND, placement, and minimized state.
- Retains one live desktop-visible reasoning/status row across durable operations until a later visible narrative or terminal event replaces it.
- Preserves desktop adjacency boundaries for commands, file edits, image views, mixed operations, and safe subagent lifecycle updates.
- Repairs historical image capability URLs by trusting verified supported image magic rather than a misleading legacy suffix, without weakening HEIC/HEIF validation.
- Strengthens native task selection confirmation, protected-task guards, and capability diagnostics for current Codex Desktop.

## [1.4.0] - 2026-07-16

This public snapshot corresponds to the internal Codex2Frp 2.4.0 capability line while preserving the public repository's independent version history.

- Codex 0.144.2 app-server schema negotiation now uses observed schema hashes and critical union shapes instead of treating the CLI version as a compatibility gate.
- The public timeline preserves desktop-visible narrative and safe operation detail while suppressing hidden reasoning, raw tool payloads, local paths, and subagent content.
- Adjacent command, file, image, and related operations are grouped only while visibly consecutive; narrative boundaries split later operations into a new group.
- Exact task selection observation fails closed when the desktop cannot confirm the requested UUID.
- Capability reporting distinguishes method availability, runtime readiness, confirmed mutations, and readback support.
- User-message and same-name attachment identities remain stable across snapshots, deltas, history reconciliation, and restarts.
- Desktop lifecycle duration and repeated subagent lifecycle updates are preserved without exposing subagent content or identifiers.
- Collaboration catalogs retain only complete authoritative presets and fail closed instead of treating plugins, subagents, or incomplete future rows as modes.
- Authoritative turn diffs persist across restarts, preserve binary changes, and safely decode real Git paths with spaces or quoted UTF-8 names.
- Strict per-part filtering removes Codex internal environment context without hiding ordinary user-authored XML or visible attachments.
- Desktop image-view, file-edit, command, mixed-operation, transient thought, and user-attachment shapes are projected with stable chronological identity.

## [1.3.0] - 2026-07-13

This public snapshot corresponds to the internal Codex2Frp 2.3.0 capability line while preserving the public repository's independent version history.

- Codex compatibility now follows the current app-server protocol and an installed-schema drift gate.
- Added durable queued input, DPAPI persistence fixes, first-turn dispatch, reconciliation, and deadlock-safe concurrent flushes.
- Preserved window focus, placement, and minimized state around explicit mobile UI actions; passive realtime synchronization remains focus-free.
- Strengthened message privacy with safe structured activity metadata while excluding bodies, arguments, outputs, payloads, local paths, child sessions, and inter-agent content.
- Kept subagent presentation limited to sanitized name and lifecycle state.
