# KPet Technical Documentation

This document covers KPet's system architecture, rendering pipeline, host plugin, daemon, communication protocol, source layout, and development workflow. For gameplay and feature introductions, see the [README](../README.md) at the repository root.

## System Architecture

KPet consists of two resident processes — the daemon and the renderer — plus a relay mode of the same executable that is temporarily launched on every host event hook:

```text
Kimi Code CLI
      │ launched once per event hook
      ▼
kpetd.exe --relay           short-lived relay (same executable as the daemon)
      │ event named pipe (one-way)
      ▼
kpetd.exe --daemon          resident daemon
      │ control named pipe (bidirectional)
      ▼
Pet.exe                         UE5 renderer
      ├─ Win32 per-pixel transparent pet window
      └─ WebUI session panel / settings panel (CEF SWebBrowser popups)
```

Kimi Code's event hooks are short-lived commands and cannot bear long-term state management. The relay is therefore responsible only for fast event delivery; the daemon handles cross-session state, event recovery, and the renderer's lifecycle; the UE5 process focuses on character presentation and desktop interaction.

## Host Plugin & Relay

The plugin manifest lives at [`bridge/packaging/kpet/kimi.plugin.json`](../bridge/packaging/kpet/kimi.plugin.json). It listens for the following 12 kinds of Kimi Code events:

- Sessions: `SessionStart`, `SessionEnd`, `UserPromptSubmit`.
- Tools: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`.
- Execution: `Stop`, `StopFailure`, `Interrupt`.
- Subagents & notifications: `SubagentStart`, `SubagentStop`, `Notification`.

Some events carry matcher filters: `SessionStart` matches `startup|resume`, `SessionEnd` matches `exit`, and `Notification` matches `task\.completed`. Each event launches `kpetd.exe --relay` once (on a WSL host, via `bin/kpet-relay.sh --relay`, see "Plugin Directory").

The relay reads the host event JSON from standard input, wraps the raw text verbatim into a `host_event` envelope (`payload._raw` passes the original through untouched — no parsing, no reordering), and writes it to the event pipe per session. Business fields are parsed defensively by the daemon; the relay does not depend on the host event's full field set.

The relay follows a fail-open policy: the combined connect-and-write timeout is 200 milliseconds; if the daemon is not running, it is launched detached; events that still fail to deliver are staged into `%TEMP%\kpet-events\` (files numbered in event order so the daemon can replay them in order at startup). Whatever the delivery outcome, the relay exits with code 0 so the Kimi Code main flow is never blocked.

Concurrent hooks are coordinated with a lock file, a delivery lease, and a recovery handoff: an occupied event pipe name is treated as an existing instance (single instance); after a user shutdown, the next `SessionStart` triggers a recovery batch — the recovery worker waits for the old pipe to be released and consumes the shutdown marker before launching a new daemon, preserving event ordering between the user shutdown and the next session recovery.

## Daemon

`kpetd.exe` is implemented in TypeScript with Node.js 22 and ESM, depending only on the Node.js standard library at runtime. It is not a Windows service and does not register for startup; it runs on demand when the first valid host event arrives.

The single executable dispatches its mode from the first argument ([`bridge/src/launcher/main.ts`](../bridge/src/launcher/main.ts)): `--relay` (or no arguments — relay), `--daemon` (daemon), `--stop` (stops the daemon, used during plugin upgrades), `--kpet-recover` (detached recovery worker).

The daemon's main responsibilities:

- Maintain active sessions, working status, unread status, and the task set keyed by `session_id`.
- Aggregate the global `Idle` and `Working` states and act as the single authority for the pet state (`pet_state` is the only authoritative message for state transitions).
- Convert tool-call, subagent, and notification events into task and notification protocol messages, coalescing high-frequency task events of the same session within a 200 ms window.
- Read the Kimi Code session catalog (`session_index.jsonl` + each session's `state.json`) and merge history with real-time active session state.
- Manage `Pet.exe` startup, heartbeat, disconnection, exit, and exponential-backoff restarts.
- Resend session, task, pet-state, and configuration snapshots after the renderer reconnects (ending the handshake with `config_snapshot`).
- Replay events staged by the relay, and persist the pet window position before exiting.
- Respond to `open_tui`, opening the specified Kimi Code session or continuing the most recent one; re-send an error bubble if the launch fails.
- Respond to `update_config` (saved from the settings WebUI): validate and merge the config → write back to `config.json` → push back `config_snapshot`; reply `protocol_error` when no field is valid.

The global state follows the rule "any session busy → `Working`, all sessions idle → `Idle`". A busy session with no new events for 10 minutes by default is force-idled (`staleMinutes`, so a missed end event cannot leave it stuck forever); a session is only removed from the active set when it has had no events for 60 consecutive minutes (`cleanupMinutes`).

When the renderer exits abnormally (control pipe disconnect or heartbeat timeout), the daemon restarts it with a backoff sequence of 1, 2, 4, 8 seconds, then capped at 8 seconds, at most 5 attempts within a 60-second window; when the window limit is exceeded it stops and waits for the next host event to start a new round. If the renderer path does not exist, it logs the error without spamming backoff retries, and likewise waits for a host event.

## Renderer

The renderer is an Unreal Engine 5.8 C++ Runtime project. The character uses a Skeletal Mesh, Animation Blueprint, and Control Rig; the scene is output to a transparent desktop window through a dedicated capture component.

### Pet Body Rendering Pipeline

```text
UE scene, lighting & skeletal animation
      ▼
SceneCaptureComponent2D
      ▼
BGRA8 RenderTarget scaled by monitor DPI
      ▼
FRHIGPUTextureReadback async readback of the previous frame
      ▼
Invert alpha, clear the RGB of fully transparent pixels
      ▼
UpdateLayeredWindow
      ▼
Windows desktop
```

`USceneCaptureComponent2D` uses `SCS_FinalColorLDR` with a `PF_B8G8R8A8` target texture. The pet is a fixed `320 × 320` logical pixels; the RenderTarget, DIB, and native window are all scaled to physical pixels according to the monitor's DPI — e.g. `480 × 480` at 150% scaling and `640 × 640` at 200%. `FRHIGPUTextureReadback` asynchronously copies the previous frame on the render thread so a synchronous GPU readback never blocks the game thread; on a cross-monitor `WM_DPICHANGED` it waits for the old copy to finish and rebuilds the readback resource, preserving RHI row-pitch semantics when presenting row by row.

Scene Capture outputs premultiplied RGB with inverted opacity alpha. On the CPU side, `A = 255 - A` is applied and the RGB of fully transparent pixels is cleared before handing the data to `UpdateLayeredWindow`. This guarantees the data satisfies the premultiplied alpha semantics of layered windows while eliminating color contamination of the transparent background from tone-mapping jitter.

The pet window uses the following Win32 extended styles:

- `WS_EX_LAYERED`: per-pixel transparent compositing.
- `WS_EX_TOPMOST`: stays above normal application windows.
- `WS_EX_TOOLWINDOW`: not shown as a regular taskbar window.
- `WS_EX_NOACTIVATE`: does not actively steal foreground focus on interaction.

The window hit test reads the current frame's alpha. Opaque pixels return `HTCLIENT` and receive clicks, drags, and camera operations; transparent pixels return `HTTRANSPARENT` and input passes through to the window below on the desktop.

### Default Window Hidden

The daemon starts the renderer with the following arguments:

```text
-NOSPLASH -windowed -ResX=16 -ResY=16
```

A project module hides the default game window before its first draw via a Slate `OnPreTick` guard. The renderer does not use offscreen rendering mode (`RenderOffScreen`), because the session panel needs real platform windows; the startup directory is the executable's own directory, and UE needs to load pak files relative to its own location.

### Session Panel

The session panel does not go through the GPU readback pipeline and has only the WebUI path (the UMG path has been removed — no fallback): an `SWebBrowser` (CEF, see `FPetSessionWebPanel`) is embedded in a `Notification`-type Slate popup `SWindow` created by `FPetSessionWindowHost`, which loads `Content/UI/Web/session-panel.html` to render the session list. That HTML is a non-asset file, staged verbatim into the package's `Content` at packaging time via `+DirectoriesToAlwaysStageAsNonUFS=(Directory="UI/Web")`; currently only CEF3/Win64 is staged.

- `FPetSessionWebPanel` loads the page and mirrors session data as C++ → JS calls (`window.KPetPanel.*`), receiving JS → C++ callbacks (session selected, panel closed) through `UPetSessionWebBridge`; a failed `FPetSessionWebPanel::Create()` (WebBrowser module unavailable / CEF failed to load) only logs an error and no longer falls back to UMG.
- `FPetSessionWindowHost` manages the window lifecycle, show/hide, left/right anchoring, work-area constraints, and window-level animations, hosting the WebUI panel's `SWebBrowser`.

The window uses `ActivationPolicy::Never` and does not actively activate the app when shown automatically. The panel picks the left or right side based on the available space on the pet's monitor. `SWindow::GetSizeInScreen`, `MoveWindowTo`, `FSlateApplication::GetWorkArea`, and the Win32 layered window all use platform screen physical pixels; the panel's design size, spacing, and slide-in distance are DPI-converted against the current monitor before participating in layout, avoiding anchor misalignment from double scaling.

The session and settings panels are mutually exclusive via stack-based navigation: opening one while the other is visible stashes the visible one, and the stashed panel pops back automatically when the current one closes — at most one panel is visible at a time. The stack state machine `FPetPanelStack` is pure logic (`EPetPanel` + Visible/Stashed states + Close/Open steps); every panel open/close funnels into `ApplyPanelStackStep`, with automated tests (`Pet.UI.PanelStack`). While stashed, a panel receives no incremental JS (the `ExecutePanelScript` funnel gate); theme, snapshot, and FPS changes only go into a local cache; on restoring visibility the full state is replayed first, and the page's `refreshSurface` forces a complete CEF redraw with a two-frame full-page opacity change, covering up the rounded-corner color noise and black background left by the software texture's initial dirty-rect-only upload.

The transparency compositing pipeline (shared by both WebUI popups): `-nocefaccelpaint` is appended before creating the browser to force CEF down the software `OnPaint` bitmap upload path — accelerated shared textures carry no alpha, and CEF's occasional fallback to the software path causes partial texture uploads, producing garbled ghosting when switching themes rapidly. The D3D11 swap chain sets `r.D3D11.UseAllowTearing=0` (flip→blit) via `[SystemSettings]` in `DefaultEngine.ini` so DWM redirection works on layered windows — that CVar is `ECVF_ReadOnly` and is latched into a static variable at first viewport construction, so a runtime `Set` is ineffective; it must land through ini before RHI initialization (deferred-dummy takeover), and panel creation only reads back the effective value and logs it. Window-level `SetLayeredWindowAttributes` enables both `LWA_COLORKEY` (pure-black key) and `LWA_ALPHA` per-pixel transparency — CEF's premultiplied transparent pixels come out exactly pure black and are keyed out, letting the area outside the cards show the desktop through. On the Windows side, `SetWindowRgn` additionally clips the native window with the same 14px radius as the page, so a rare color-key failure never degrades into a rectangular black background. When the window recovers from fully hidden, it pre-warms at zero opacity for about three frames and replays the composite color key and rounded rect immediately after `ShowWindow` creates the viewport, avoiding an uninitialized black rectangle on rapid toggling. Page-side constraints: the body must be transparent; cards must not use outer box-shadows (stale shadow pixels are not correctly overwritten, leaving color bands at the edges when switching themes rapidly); and pure black RGB(0,0,0) must not appear in the page (it would be keyed through).

### Settings Panel

The settings panel is the second WebUI popup, parallel to the session panel, opened with `Ctrl+,` (`PetLayeredWindow` installs a `WH_KEYBOARD_LL` low-level keyboard hook to observe the combo, firing only when the cursor rests on an opaque pet pixel — the same semantics as ESC/R: observe only, no interception, no global hijack; holding the key fires it only once). It is implemented by `FPetSettingsWebPanel` / `UPetSettingsWebBridge`: it loads `Content/UI/Web/settings.html` and reuses `FPetSessionWindowHost` for the window (with a configurable client-area size — the settings panel uses a compact 340×270 client area with cards filling the window, keeping no outer transparent buffer that would show black). It is a transparent Slate popup that never steals focus; positional anchoring, the transparency compositing pipeline, and stack navigation all match the session panel (see the previous section).

- C++ → JS: after the page loads or the snapshot updates, `ExecuteJavascript` calls `window.KPetSettings.applySettings({open_target, open_web_url, ui_theme, fps_monitor})`; snapshots are cached until the page is ready and replayed after load. `open_web_url` is display-only; the settings page has no JS callback that modifies it.
- JS → C++: lowercase methods under `window.ue.petsettings` — `setopentarget` / `settheme` / `setfpsmonitor` / `closesettings` / `reportfps` (`BindUObject` exposes function names lowercased by default).
- The three mutating callbacks are wired at the Pawn's assembly point: after optimistically updating local settings, a single-field `update_config` (only `open_target` / `ui_theme` / `fps_monitor`) is sent via `FPetControlClient`; the daemon pushes back `config_snapshot` after merging and writing back, and the Pawn reconciles. `closesettings` closes the window; `reportfps` feeds into the WebUI frame rate.

### FPS Monitor

With the settings page's "Show frame rates" toggle (`fps_monitor`) on, an FPS overlay is drawn at the pet window's top-right corner, distinguishing two sources:

- **3D world frame rate**: `APetCapturePawn::Tick` counts frames once per second as the `3D` value.
- **WebUI frame rate**: the session and settings pages each report the CEF frame rate once per second via `reportfps(n)` driven by `requestAnimationFrame`; the most recent report is used as the `UI` value, or `--` when there is none.

The overlay reads like `3D:120 UI:30`. Because the layered window uses a 32bpp premultiplied BGRA DIB, GDI `DrawText` would zero the destination pixels' alpha and make text invisible, so `PetLayeredWindow` writes the overlay pixel by pixel with a built-in 4×6 pixel font on the `Present` path: green glyphs on a semi-transparent dark background stay readable over any backdrop; the glyph set covers digits, `D/U/I`, space, and colon/hyphen (`PetPixelFont`, pure logic with automated tests). When `fps_monitor` changes, the overlay toggle and both pages stay in sync (the session panel via `KPetPanel.setFpsMonitor`; the settings page starts/stops through `applySettings` itself).

## Inter-Process Communication

KPet uses two named pipes within the same Windows user session:

```text
\\.\pipe\KPet.H2D.<username>   relay → daemon (event pipe, one-way)
\\.\pipe\KPet.PET.<username>   daemon ↔ renderer (control pipe, bidirectional)
```

In the username segment, `\ / : * ? " < > |` and control characters are replaced with `_`; `default` is used when everything gets replaced (node:net named pipe paths disallow `\`). Pipes are created by `node:net` and inherit the process's default security descriptor — the daemon runs as the current user, whose default DACL only allows that user access, so no extra ACL setup is done.

The protocol is a UTF-8 JSON text stream; each compact JSON object ends with a newline (`\n`) (node:net named pipes are byte streams rather than message mode, so line framing is handled by `StringDecoder` to keep multibyte characters from breaking across chunks). A single message is capped at 64 KB (`MAX_MESSAGE_BYTES`). The message envelope:

```json
{
  "v": 1,
  "type": "pet_state",
  "id": "message id",
  "ts": "timestamp",
  "session_id": null,
  "payload": {}
}
```

The current protocol major version is 1 (`PROTOCOL_VERSION`). Unknown message types are ignored and logged; an invalid envelope gets a `protocol_error` reply (`raw_excerpt` truncated to 256 characters) without interrupting subsequent messages; repeated invalid input is warned at a threshold of 10 per minute. Once the control pipe connection is established, both sides first exchange `hello` and capability lists; `hello.role` must be `renderer`; when major versions differ, both sides degrade to the lower version.

### Message Types

The protocol has 19 message types in total, mapping one-to-one to `MESSAGE_TYPES` in [`bridge/src/protocol/types.ts`](../bridge/src/protocol/types.ts):

| Type | Direction | Trigger | Key Fields |
|---|---|---|---|
| `host_event` | relay → daemon | each event hook | The only inbound type; `payload._raw` carries the host's raw JSON text verbatim, parsed and mapped inside the daemon |
| `hello` | both ways | first message after connect | Handshake and version negotiation: `protocol_version`, `role`(daemon/renderer), `pid`, `version`, `capabilities[]` |
| `session_start` | daemon → renderer | `SessionStart` | `cwd`, `resume` (whether the session is resumed) |
| `session_end` | daemon → renderer | `SessionEnd` | `reason` |
| `session_state` | daemon → renderer | a session's working/unread state changes | `working`, `unread` (keyed by the envelope's `session_id`) |
| `pet_state` | daemon → renderer | daemon state derivation | The only authoritative message for state transitions: `state`(Idle/Working), `reason` |
| `task_start` | daemon → renderer | `PreToolUse` / `SubagentStart` | Floating-card list item: `task_id`, `title`, `tool` |
| `task_end` | daemon → renderer | `PostToolUse` / `PostToolUseFailure` / `SubagentStop` | Triggers the completion bubble: `task_id`, `status`(success/failure), `title`, `summary?` |
| `tasks_snapshot` | daemon → renderer | connection established / after renderer restart | Full task recovery: `tasks[]` |
| `sessions_snapshot` | daemon → renderer | connection established / after renderer restart | CLI history and active session catalog: `sessions[]` |
| `config_snapshot` | daemon → renderer | connection established / after config update | Full config snapshot (settings WebUI initialization): `open_target`, `ui_theme`, `fps_monitor`, `open_web_url` |
| `notify` | daemon → renderer | task completion/failure, `Notification` | Message bubble: `text`, `level`(info/success/error), `ttl_ms?`, `task_id?` |
| `open_tui` | renderer → daemon | pet clicked / bubble clicked | Requests opening a terminal: `session_id?`(empty = most recent session), `source`(pet/bubble), `task_id?` |
| `heartbeat` | renderer → daemon | every 3 seconds | Keep-alive heartbeat: `pid`, `uptime_s`, `state` |
| `pet_moved` | renderer → daemon | drag ends | Position persistence: `x`, `y`, `monitor_id` |
| `close_pet` | renderer → daemon | user requests closing the pet | `payload.reason=user` |
| `update_config` | renderer → daemon | settings WebUI save | Requests updating the daemon config: `open_target?` / `ui_theme?` / `fps_monitor?` (at least one valid field) |
| `shutdown` | daemon → renderer | before the daemon exits | Notifies the renderer to exit: `reason`(host_gone/user/error) |
| `protocol_error` | both ways | invalid message received | Log-only: `description`, `raw_excerpt`(truncated to 256 characters) |

The UE control client exchanges pipe data over an `FRunnable` worker thread with Win32 overlapped I/O, handing complete messages to the game thread for parsing. The renderer sends a heartbeat every 3 seconds; the daemon considers the connection lost when no valid message arrives for 10 seconds by default (`heartbeat_timeout_ms`, 0 = disabled). While disconnected, UE keeps the last authoritative state and never derives a new `Idle` or `Working` on its own.

### Host Event → Protocol Message Mapping & Throttling

The daemon state machine ([`bridge/src/daemon/state.ts`](../bridge/src/daemon/state.ts)) maps host events to protocol messages:

| Host Event | State Machine Behavior | Messages Sent |
|---|---|---|
| `SessionStart` | Create/activate the session; repeated starts are idempotent (busy/tasks not reset); `resume` merges monotonically, never overrides backwards | `session_start` + `session_state` |
| `UserPromptSubmit` | Session set busy → Working | `session_state` + `pet_state`(Working) |
| `PreToolUse` / `SubagentStart` | Session set busy → Working, add a task (title from `tool_input.command`, falling back to the subagent name / tool name / "Working…") | `session_state` + `pet_state`(Working) + `task_start` (throttled) |
| `PostToolUse` / `PostToolUseFailure` / `SubagentStop` | End the task (matched to the most recent task in the same session by tool name / subagent name) | `task_end` (throttled; failure also sends a `notify` failure bubble) |
| `Stop` | Session idle, tasks silently cleared, `unread=true` | `session_state` + `pet_state`(Idle), no more `task_end` |
| `StopFailure` | Same as above + an error bubble | Same as above + `notify`(task error) |
| `Interrupt` | Session idle, no completion bubble, `unread` unchanged | `session_state` + `pet_state`(Idle) |
| `Notification` | Completion notice: success bubble, main state unchanged | `notify`(success) |
| `SessionEnd` | Remove the session, drop its throttle buffer; no active sessions → Idle and start the exit countdown | `session_end` (+ `pet_state`(Idle) if all sessions ended) |

High-frequency task events such as `PreToolUse`/`PostToolUse` are coalesced per session within a 200 ms window; a `task_start`+`task_end` pair in the same window folds into a single `task_end`, avoiding UI jitter in the renderer.

### Key Timings

- **Handshake and snapshot replay**: after the renderer connects to the control pipe, it first sends `hello` (role=renderer); the daemon replies `hello` (role=daemon), then replays in order `sessions_snapshot` → `session_start`+`session_state` for each active session → `pet_state` → `tasks_snapshot`, closing with `config_snapshot` (the full config the settings WebUI needs for initialization).
- **Config delivery**: settings WebUI saves → renderer→daemon `update_config` (partial patch) → the daemon validates and merges field by field (valid fields overwrite; invalid ones warn and keep current values) → writes back `config.json` → daemon→renderer `config_snapshot` pushes the full config back; `protocol_error` is returned when no field is valid.
- **open_tui**: empty session id → most recent active session (otherwise the first catalog entry) → cwd comes from the session's cwd, falling back in order to the runtime session directory, the CLI directory, and the user home; the session is marked read after launching; a failed launch re-sends a `notify` error bubble.
- **Exit**: last `SessionEnd` with no active sessions → a `host_grace_seconds` (default 120 s) countdown starts, and any new host event during it cancels the countdown. When the countdown ends or `close_pet` / a signal / an error occurs → the daemon first stops renderer restarts, sends the final `shutdown`, releases both pipes, and after a 3-second grace period force-terminates the renderer and exits (stays resident with `auto_quit_with_host=false`).

## Terminal & Session Catalog

When a session row is clicked, the renderer sends `open_tui` and the daemon opens the target (`bridge/src/daemon/terminal.ts`). See "Key Timings" above for `cwd` and session-id resolution.

With `open_target=cli`, the terminal is launched according to the `terminal` config:

- `terminal=wt`: `wt.exe -d <cwd> cmd /k kimi --session <session id>`; without a session id, `kimi --continue` resumes the most recent session. When `wt.exe` is unavailable (spawn ENOENT), falls back to `cmd /c start "" cmd /k kimi ...`.
- `terminal=cmd`: `cmd /c start "" cmd /k kimi --session <session id>` (the outer cmd stub stays hidden; the real window is opened by `start`).
- `terminal=wsl` (cross-platform Form 1: CLI in WSL, daemon on Windows): `wt.exe -d <Windows cwd> wsl.exe [-d <distro>] --cd <Linux cwd> -- kimi --session <session id>` — when cwd is a Linux path it is first converted to a Windows path via `wslToWindowsPath` for `wt -d`, while `wsl.exe`'s `--cd` keeps the original Linux path; the distro comes from `wsl_distro`, with an empty value meaning WSL's default distro. When `wt.exe` is missing, falls back to `cmd /c start "" wsl.exe [-d <distro>] --cd <Linux cwd> --exec bash -lc "kimi ..."` (the whole command is packed as a single argv to bash to avoid argument splitting).

With `open_target=web`, the template URL from `open_web_url` (supporting the `{session_id}` placeholder) is opened in the system default browser. Official docs confirm that `kimi web` serves a web UI locally (default port 58627), but no URL format for "opening a specific CLI session directly by session id" is published; the default therefore points only at the local web home page, and session-resuming URLs are an unverified assumption you can configure yourself via `open_web_url`. Loopback and non-loopback behavior:

- **Loopback URLs** (`127.0.0.1` / `localhost` / `::1`): before opening the browser, KPet first ensures the kimi web service is available and that the port occupant is "one of us". Starting from the URL-configured port (default 58627, `127.0.0.1`), it tries up to 10 candidate ports (`basePort`..`basePort+9`): if a TCP probe finds `host:port` free, it launches `kimi web --no-open --port <candidate>` in a visible terminal window (with `terminal=wt`, `wt.exe new-tab --reloadEnvironment` explicitly opens a new tab and refreshes the environment so Windows Terminal's cached PATH doesn't miss a freshly installed kimi; the `terminal=wsl` branch instead runs `wsl.exe ... -- kimi web ...` inside WSL to stay in the same WSL environment as the CLI; falls back to `cmd /c start` when `wt.exe` is missing), polls the port every 250 ms for readiness, waits at most about 10 seconds, then opens the URL of the chosen candidate (the port is rewritten to the actually used one, path and query preserved). An occupied port is not automatically treated as "service already running" — when a token was read successfully, ownership is verified first (see below), and a confirmed foreign occupant moves on to the next candidate port for a fresh probe and launch; if all 10 candidate ports are occupied by foreign processes, it returns a failure with a hint (the error message contains no token). That terminal window *is* the service's lifetime: closing it stops the service, and the next session click re-launches it automatically when the probe finds a free port. A launch failure or timeout logs an error and re-sends a failure bubble to the renderer.
- **Token-free login & port ownership verification**: kimi web's web UI requires a bearer token by default; the official mechanism is the URL's `#token=` fragment for automatic authentication. For loopback URLs only, the daemon reads the token file `%KIMI_CODE_HOME%\server.token` before opening the browser (falling back to `~/.kimi-code/server.token` when `KIMI_CODE_HOME` is unset). When a non-empty token is read and the TCP probe finds the port occupied, one `GET /api/v1/sessions` verification request is sent to the same address with that token (`Authorization: Bearer`, ~1.5 s timeout): a response with a status other than 401 → the occupant is a kimi web instance of the same home; append `#token=<token>` to the URL (stripping an existing `#` fragment first) and open the browser directly. A 401 → a foreign-environment occupant (typically a kimi web running inside WSL whose `server.token` differs from the Windows side — observed in practice to stall at "Server token required"), so move on to the next candidate port; a request error or timeout → likewise move on. A missing file, blank content, or read failure (token null) keeps the old behavior entirely: probe the original port and open the bare URL if occupied, with no verification and no port shifting (the user can copy the token from the launched service's terminal window banner and fill it in manually).
- **Non-loopback URLs**: open the browser directly as before — no verification, no auto-launch, and never append a token (prevents token leakage to remote hosts, and a remote service cannot be managed anyway).

Security red line: no log or error message may ever output a full URL containing a token, and the token verification request itself leaves no trace in any log.

The session catalog comes from `%KIMI_CODE_HOME%\session_index.jsonl` plus each session directory's `state.json` (see [`bridge/src/daemon/session-catalog.ts`](../bridge/src/daemon/session-catalog.ts)). The daemon filters out invalid or archived records, deduplicates and sorts by update time, and folds history records by working directory (only the most recent entry per project is kept to avoid duplicate accumulation; active sessions are not folded so parallel sessions stay individually openable), sending at most 50 records to the renderer. A corrupted line or `state.json` is skipped so catalog damage never blocks the daemon handshake.

## Data & Configuration

The daemon reads `%KIMI_CODE_HOME%\kpet\config.json` (see [`bridge/src/daemon/config.ts`](../bridge/src/daemon/config.ts)). Without `KIMI_CODE_HOME` set, the path falls back to `%USERPROFILE%\.kimi-code\kpet\config.json`. A missing file or invalid JSON falls back to defaults wholesale; a missing field or invalid type falls back to its default per-item with a warning. The default config (all fields):

```json
{
  "renderer_path": "D:\\Apps\\KPet\\renderer\\Pet.exe",
  "heartbeat_interval_ms": 3000,
  "heartbeat_timeout_ms": 10000,
  "restart_max_attempts": 5,
  "restart_window_s": 60,
  "host_grace_seconds": 120,
  "auto_quit_with_host": true,
  "terminal": "wt",
  "wsl_distro": "",
  "open_target": "cli",
  "open_web_url": "http://127.0.0.1:58627/",
  "ui_theme": "dark-glass",
  "fps_monitor": false,
  "session": {
    "staleMinutes": 10,
    "cleanupMinutes": 60
  },
  "log_level": "info"
}
```

Field semantics and values:

- `renderer_path`: the renderer path, supporting `%VAR%` / `$VAR` / `${VAR}` environment variable expansion; defaults to `renderer/Pet.exe` resolved via `KIMI_PLUGIN_ROOT` (falls back to `renderer/` under cwd during development).
- `terminal`: how the terminal is launched — `wt` (Windows Terminal, default), `cmd` (legacy console), or `wsl` (a WSL distro's terminal, cross-platform Form 1).
- `wsl_distro`: the WSL distro name used when `terminal=wsl`; empty means wsl.exe's default distro.
- `open_target`: what to open after clicking a session — `cli` (launch the kimi terminal, default) or `web` (open the browser).
- `open_web_url`: URL template for the web target, defaulting to `http://127.0.0.1:58627/`, supporting the `{session_id}` placeholder.
- `ui_theme`: the settings WebUI theme — `dark-glass` (default), `light-minimal`, `cute-pet`.
- `fps_monitor`: whether the FPS monitor overlay is shown, off by default.
- `session.staleMinutes` / `session.cleanupMinutes`: the stuck-fallback and cleanup durations (minutes), accepting both the "flat dotted-key" and "nested object" spellings; `cleanupMinutes` must be greater than `staleMinutes`, defaulting to `staleMinutes + 1` when not configured.
- Remaining fields: heartbeat interval/timeout, restart window and attempt cap, host exit countdown and whether to quit with the host, log level (debug/info/warn/error).

The config the settings panel can change is delivered via `update_config` — only the three fields `open_target` / `ui_theme` / `fps_monitor` (`config_snapshot` additionally carries the read-only `open_web_url` for display). Valid fields are validated individually at runtime: valid ones overwrite; invalid ones warn and keep current values (never falling back to defaults, so a slip cannot reset the user's choices); afterwards only the actually applied subset of fields is written back to the config file (unknown fields already present in the file are preserved).

Runtime file locations:

| Content | Path |
|---|---|
| Daemon log | `%KIMI_CODE_HOME%\kpet\logs\kpetd.log` |
| Pet window state | `%APPDATA%\KPet\pet-state.json` |
| Staged events | `%TEMP%\kpet-events\` |
| User shutdown marker | `%TEMP%\kpet\pet.disabled` |
| Launch/recovery handoff markers | `%TEMP%\kpet\daemon.lock`, `pet.recovering`, etc. |

These files may contain working directories, session info, or command excerpts. Inspect and redact them before filing an issue or sharing test samples.

## Tech Stack

| Layer | Technology |
|---|---|
| Host integration | Kimi Code CLI plugin, event hooks, stdin JSON |
| Relay & daemon | TypeScript 5, Node.js 22, ESM, Node.js standard library |
| Communication | Windows named pipes, UTF-8 JSON, newline framing, protocol version 1 |
| Rendering | Unreal Engine 5.8, C++, Scene Capture, RHI, RenderCore, GPU Readback |
| Desktop presentation | Win32, DIB, `UpdateLayeredWindow`, per-pixel hit testing |
| Character animation | Skeletal Mesh, Animation Blueprint, Control Rig |
| UI | Slate, `SWindow`, SWebBrowser (CEF), MovieScene |
| Testing | Node.js Test Runner, UE Automation Test, PowerShell window verification |

## Source Layout

```text
KPet/
├─ bridge/                   Relay, daemon & protocol (TypeScript, Node 22 ESM)
│  ├─ packaging/kpet/        Kimi Code plugin bundle (manifest + deploy scripts + artifacts)
│  ├─ src/bridge/            Short-lived event relay
│  │  ├─ main.ts             Relay core: stdin → host_event → pipe, 200 ms timeout + staging fallback
│  │  ├─ daemon.ts           Launch lock / recovery handoff / suppression marker & detached recovery worker
│  │  ├─ pipe.ts             node:net pipe probing and writing
│  │  ├─ staging.ts          Event staging directory read/write
│  │  ├─ stop.ts             --stop mode: write the suppression marker to trigger a graceful exit, wait for the event pipe to be released
│  │  └─ user.ts             Username sanitization and derivation of the two pipe names
│  ├─ src/daemon/            Daemon, state machine & process management
│  │  ├─ app.ts              Assembly: two pipes, state machine, renderer guard, terminal launch, staging reclamation
│  │  ├─ config.ts           Config load / merge / write-back
│  │  ├─ control.ts          Control pipe session (hello handshake, message dispatch, protocol errors)
│  │  ├─ logger.ts / main.ts / petstate.ts / pipes.ts / staging.ts / wsl-path.ts
│  │  ├─ renderer.ts         Renderer supervision: exponential-backoff restart & per-window rate limit
│  │  ├─ session-catalog.ts  Session catalog reading & snapshot merge
│  │  ├─ state.ts            Pet state machine: event mapping, 200 ms throttle, stuck fallback
│  │  └─ terminal.ts         Terminal/browser launch (wt/cmd/wsl + kimi web launch & token)
│  ├─ src/launcher/main.ts   Single-exe mode dispatch: --relay / --daemon / --stop / --kpet-recover
│  ├─ src/protocol/          Shared protocol: envelope, types.ts (message table / envelope / constants)
│  └─ test/                  Bridge unit tests & Windows named-pipe integration tests
├─ Pet/
│  ├─ Content/               Character, animation, level assets
│  │  └─ UI/Web/             session-panel.html, settings.html (WebUI staged as non-UFS)
│  ├─ Source/Pet/            UE C++ Runtime module (Public/Private)
│  │  ├─ Animation/  Communication/  FunctionLibrary/  Game/  UI/
│  │  ├─ Platform/           Layered window, low-level keyboard hook, pixel font (PetLayeredWindow / PetPixelFont)
│  │  ├─ Player/             Capture Pawn, camera, movement components
│  │  └─ Tests/ under each module    UE Automation Tests (panel stack, pixel font, config protocol, window host, etc.)
│  └─ Pet.uproject           UE 5.8 project entry
├─ docs/                     This document & the cross-platform compatibility plan
├─ tools/                    Development & packaging tools
│  ├─ package.ts             Single entry for whole-package packaging (bridge single exe + UE Shipping assembly + zip)
│  ├─ mock-daemon.ts         Mock daemon on the control pipe (for iterating on the renderer in isolation)
│  ├─ verify-pet-operations.ps1 / window-watch.ps1   Window behavior verification & debugging
│  └─ blender-direct.ts      Tool script connecting directly to the Blender MCP socket
├─ dcc/                      Blender/FBX source assets (KPet.blend, KPetComputer.blend/.fbx, textures)
└─ dist-plugin/              Packaging output (kpet/ plugin directory & kpet.zip)
```

## Development Environment

- Windows 11.
- Unreal Engine 5.8.
- Visual Studio 2022, plus the UE C++ development components.
- Node.js 22 or later.
- Bun (only needed for compiling the single exe with `build:exe`).
- Kimi Code CLI.
- Optional Windows Terminal (`terminal=wt` preferred, falls back to `cmd` when missing).

## Build & Test

### Bridge

```powershell
cd bridge
npm ci
npm run build
npm test
```

`npm run build` compiles the relay, daemon, and protocol into `bridge/dist/` (`tsc -p tsconfig.json`). `npm test` runs `build` then `build:test` (compiling into `dist-test/`), after which the Node.js built-in test runner executes `dist-test/test/*.test.js`.

All **240 tests currently pass** (0 failures). Coverage includes protocol validation, config loading and merging, the state machine and event mapping, the 200 ms throttle, event staging and recovery, renderer supervision (backoff restart / window rate limit), terminal launch (wt/cmd/wsl plus web launch / token appending), WSL path conversion both ways, session catalog merging, `--stop`, and Windows named-pipe integration.

The `build:exe` target for the single exe (output `bin/kpetd.exe`, see `bridge/package.json`):

```powershell
cd bridge
npm run build
bun build --compile --windows-hide-console dist/launcher/main.js --outfile bin/kpetd.exe
```

### UE Project

Open `Pet/Pet.uproject` with Unreal Engine 5.8 and compile `PetEditor`, or run from a configured developer PowerShell:

```powershell
& "C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" PetEditor Win64 Development "D:\path\to\KPet\Pet\Pet.uproject" -WaitMutex
```

To debug only the renderer, run the mock daemon first:

```powershell
node --experimental-strip-types tools/mock-daemon.ts
```

The mock daemon sends session data and alternates `Working` and `Idle` (plus per-session working states) every 10 seconds, letting you inspect the panels, state transitions, and disconnect-reconnect behavior independently.

Automated verification entry points:

- `bridge/test/`: Node.js unit tests and Windows named-pipe integration tests.
- `Pet/Source/Pet/Private/**/Tests/`: UE Automation Tests for the panel stack, pixel font, config protocol, input, window host, etc.
- `tools/verify-pet-operations.ps1`: Windows window-behavior verification for the editor or packaged build.
- `tools/window-watch.ps1`: watches window visibility and rectangle changes of the Pet.exe process tree (debugging aid).

## Plugin Directory

The installable plugin's directory layout (see [`bridge/packaging/kpet/`](../bridge/packaging/kpet/)):

```text
kpet/
├─ kimi.plugin.json         # Windows host manifest (command launches .\bin\kpetd.exe --relay directly)
├─ kimi.plugin.wsl.json     # WSL host manifest (command goes through ./bin/kpet-relay.sh --relay)
├─ deploy.sh                # Cross-platform deploy script (on Windows via Git Bash, prompts to use deploy.ps1; the WSL branch stages the manifest)
├─ deploy.ps1               # Native Windows deploy script
├─ bin/
│  ├─ kpetd.exe             # Single exe, multi-mode (relay/daemon/--stop/recovery worker)
│  └─ kpet-relay.sh         # POSIX sh wrapper launching kpetd.exe from WSL via interop
└─ renderer/
   └─ Pet.exe and the UE packaged dependencies
```

To deploy, run the bundled deploy script in the plugin root first; it auto-detects the current platform and self-checks package integrity (`bin/kpetd.exe`, `renderer/Pet.exe`, and `bin/kpet-relay.sh` must exist):

- **Windows** (`deploy.ps1`): verifies that `kimi.plugin.json` is the Windows manifest; if the directory once ran `deploy.sh` in WSL (manifest contains `kpet-relay.sh`), restores the Windows version from the backup `kimi.plugin.json.bak` and verifies again (guards against a "fake restore" from a bad backup).
- **WSL** (`deploy.sh`, Form 1): overwrites the bundled `kimi.plugin.wsl.json` onto the plugin root's `kimi.plugin.json` (backing up the previous Windows version as `kimi.plugin.json.bak` first; idempotent when re-run) and self-heals the executable bit of `bin/kpet-relay.sh` (zip extraction drops POSIX permission bits); its hook commands go through `bin/kpet-relay.sh`, launching the Windows-side `bin/kpetd.exe` directly via WSL interop.
- **macOS / plain Linux**: not supported yet; the script says so explicitly (no build artifacts exist for other platforms).

Both entry points call `kpetd.exe --stop` (on the WSL side, via `kpet-relay.sh --stop`) after staging the manifest to stop any old daemon first — non-fatal, failure only warns. After a successful `--stop`, leftover renderer processes are also cleaned up by executable path prefix (the managed directory `plugins/managed/kpet/renderer`) — `Pet.exe` / `Pet-Win64-Shipping.exe` / `EpicWebHelper.exe` — covering the "launcher killed but the UE game body orphaned" scenario; the cleanup is likewise non-fatal and is skipped when `--stop` failed (an old daemon could still relaunch the renderer). Install instructions are then printed:

```text
Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1
WSL:      sh deploy.sh        # or ./deploy.sh
```

Then install the directory containing `kimi.plugin.json` in Kimi Code:

```text
/plugins install D:\Apps\kpet
/reload
```

The plugin starts its background components on demand with the first valid session event — there is no need to run the three executables manually. The whole package is produced by `tools/package.ts` at the repository root (`npm run package`; UE Shipping + bridge single exe assembly, optional `--zip`).

## Platform Boundaries

The full project targets Windows 11. The pet itself, control communication, and named pipes contain Windows-specific implementations; the session panel depends on WebBrowser (CEF, currently only Win64 staged in the package; the UMG path has been removed), and its Slate window host is comparatively portable, but the complete program still has no run baseline on other platforms. WSL Form 1 (CLI in WSL, daemon/renderer still on Windows) is supported via `kimi.plugin.wsl.json` + `deploy.sh` + `bin/kpet-relay.sh` + `wsl-path.ts`; see the [Cross-Platform Compatibility Plan (WSL & macOS)](跨平台兼容方案-WSL与Mac.md) for detailed research and the implementation path. macOS and plain Linux are not supported yet.

Named pipes use the process default security descriptor, and the protocol itself has no additional authentication token. Deployment environments should treat KPet as a local application within the same user session and must not expose the pipes as cross-user or remote interfaces.
