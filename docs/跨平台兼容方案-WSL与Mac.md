# KimiPet 跨平台兼容方案：WSL 与 macOS

> 范围：本文只做调研与方案设计，不包含任何代码改动。所有结论均基于当前仓库真实代码并标注 `path:line` 引用。
>
> 现状定位：KimiPet 当前是「Windows 单平台」产品。守护进程（`kimi-petd`）与转发器是 Node.js 22 产物，渲染端是 UE5 C++ 的 Win32 分层窗口。本方案梳理其中所有 Windows 专属假设，并分别给出 WSL（两种形态）与 macOS 的落地路径。

---

## 1. 结论速览

| 目标 | 推荐形态 | 核心改动量 | 一句话判断 |
|------|----------|-----------|-----------|
| WSL | **形态一：CLI 在 WSL、守护进程仍在 Windows** | 中（转发器入口 + 路径转换 + 终端 profile） | 改动小、复用现有 Win32 渲染端，收益最大 |
| macOS | 守护进程/转发器移植 + 渲染端换 NSWindow 方案 | 大（管道传输、终端、分层窗口三处硬骨头） | 可做，但渲染端是重写级工作量，建议先做守护进程侧 |

---

## 2. Windows 专属假设盘点

### 2.1 bridge/ Node.js 侧

#### 2.1.1 进程间管道（命名管道）

- 事件/控制管道名硬编码为 Windows 命名管道：
  - `bridge/src/bridge/user.ts:39-48`：`getEventPipeName()` → `\\.\pipe\KimiPet.H2D.<用户名>`；`getControlPipeName()` → `\\.\pipe\KimiPet.PET.<用户名>`。
  - `bridge/src/bridge/user.ts:9-22`：`sanitizePipeUser` 过滤 `\ / : * ? " < > |` 与控制字符（Windows 命名管道/路径保留字符）。
  - `bridge/src/bridge/user.ts:29-37`：`getUserName` 取 `os.userInfo().username`，回退 `USERNAME`/`USER`（`USERNAME` 是 Windows 习惯变量）。
- 管道客户端（转发器侧）依赖 Windows 命名管道的错误语义：
  - `bridge/src/bridge/pipe.ts:13-14`：`PIPE_NOT_FOUND_CODES = ['ENOENT','ECONNREFUSED']`（node:net 连 `\\.\pipe\...` 不存在时的报错码）。
  - `bridge/src/bridge/pipe.ts:22-40` `probePipe`、`48-83` `writeToPipe`：`net.connect(pipePath)`，路径就是 `\\.\pipe\...`。
- 管道服务端（守护进程侧）：
  - `bridge/src/daemon/pipes.ts:63-70` `createLineFramedServer`：`net.createServer(...).listen(pipeName)`。
  - `bridge/src/daemon/app.ts:176-193`：`eventServer.listen(eventPipeName)`、`controlServer.listen(controlPipeName)`。
  - `bridge/src/daemon/control.ts:2`：控制管道注释 `\\.\pipe\KimiPet.PET.<用户名>`。
- 单实例用「管道名占用」实现：
  - `bridge/src/daemon/app.ts:7-9`、`bridge/src/daemon/main.ts:8-10`：同名管道创建失败即视为已有实例。
  - `bridge/src/daemon/app.ts:179`：`EADDRINUSE / EACCES / EEXIST` 判定 `SingleInstanceError`。

> 说明：Node 侧管道的「传输层」其实是 `node:net`，`server.listen(path)` / `net.connect(path)` 在 POSIX 上会自动变成 Unix domain socket，路径是唯一硬差异。真正卡跨平台的是 **UE 渲染端用 Win32 `CreateFileW` 连命名管道**（见 2.2），以及 WSL 下 Linux 进程能否直达 Windows 命名管道。

#### 2.1.2 终端唤起

- 只支持 `wt.exe` / `cmd.exe`：
  - `bridge/src/daemon/terminal.ts:27-41` `buildOpenTuiCommand`：
    - `wt`：`wt.exe -d <cwd> cmd /k kimi --session <会话id>`；
    - `cmd`：`cmd.exe /c start "" cmd /k kimi --session <会话id>`。
  - `bridge/src/daemon/terminal.ts:43,64`：spawn 选项含 `windowsHide: true`（Windows 专属，其他平台被忽略）。
  - `bridge/src/daemon/terminal.ts:71`：`wt.exe` ENOENT 回退 `cmd /c start`。
- 配置只有 `'wt' | 'cmd'`：
  - `bridge/src/daemon/config.ts:32-33,120-125,147`：`terminal` 类型与默认值 `'wt'`。
- 打开终端时 cwd 取会话 cwd，取不到回退 `os.homedir()`：
  - `bridge/src/daemon/app.ts:412-438`（`cwd` 兜底在 `app.ts:428`）。

#### 2.1.3 配置、路径与环境变量

- `%VAR%` 风格环境变量展开（Windows cmd 语法，非 `${VAR}`）：
  - `bridge/src/daemon/config.ts:46-49` `expandEnvVars`：`raw.replace(/%([^%]+)%/g, ...)`。
  - 依赖它的默认值：`bridge/src/daemon/config.ts:73-82` `resolveRendererPath`，默认 `%KIMI_PLUGIN_ROOT%\renderer\Pet.exe`。
- 默认渲染进程路径硬编码 `Pet.exe` 与反斜杠拼接：
  - `bridge/src/daemon/config.ts:79-81`：`path.join(root, 'renderer', 'Pet.exe')` 与 `path.join(process.cwd(), 'renderer', 'Pet.exe')`。
- 用户配置目录：`KIMI_CODE_HOME` 未设回退 `~/.kimi-code`：
  - `bridge/src/daemon/config.ts:43-56` `getKimipetHome`；注释里 Windows 默认 `C:\Users\<用户名>\.kimi-code`。
- 会话目录读取用 Windows 盘符/UNC 判断绝对路径：
  - `bridge/src/daemon/session-catalog.ts:73-77`：`KIMI_CODE_HOME/session_index.jsonl`，回退 `~/.kimi-code`。
  - `bridge/src/daemon/session-catalog.ts:236-239` `resolveSessionDir`：`path.isAbsolute` + `/^[A-Za-z]:[\\/]/` + `startsWith('\\\\')`。
- 宠物位置缓存用 `%APPDATA%`：
  - `bridge/src/daemon/petstate.ts:10-12` `getPetStatePath`：`process.env.APPDATA`，未设返回空串（macOS/Linux 无 `APPDATA`，位置持久化会失效）。

#### 2.1.4 守护进程/转发器可执行文件与拉起

- 硬编码 `.exe` 与 `kimi-petd.exe`：
  - `bridge/src/bridge/daemon.ts:18` `DAEMON_EXE = 'kimi-petd.exe'`。
  - `bridge/src/bridge/daemon.ts:45-53` `resolveDaemonPath`：`/\.exe$/i` 判定自身；`KIMI_PLUGIN_ROOT/bin/kimi-petd.exe`；`cwd()/bin/kimi-petd.exe`。
  - `bridge/src/bridge/daemon.ts:313-325` `resolveBridgeLauncher`：按 `.exe` / `.mjs/.cjs/.js/.ts` 判定运行时。
- spawn 带 `windowsHide: true`：
  - `bridge/src/bridge/daemon.ts:281-285`（恢复 worker）、`bridge/src/bridge/daemon.ts:455-460`（拉起守护进程）。
- 锁/标记文件用 `os.tmpdir()`（跨平台安全），但注释写 `%TEMP%`：
  - `bridge/src/bridge/daemon.ts:55-80`；文件锁 `fs.openSync 'wx'` 排他创建跨平台可用，`rename` 原子性在 POSIX 同样成立（`bridge/src/bridge/daemon.ts:384` 注释只提 Windows，不构成障碍）。

#### 2.1.5 转发器入口与插件清单

- 插件清单命令用 Windows 反斜杠相对路径：
  - `bridge/packaging/kimi-pet/kimi.plugin.json:6-17`：每条 hook 的 `command` 都是 `.\bin\kimi-petd.exe --relay`。
- 转发器从 stdin 读宿主事件、包装成 `host_event` 信封（跨平台，本身无 Windows 依赖）：
  - `bridge/src/bridge/main.ts:301-311` `readAllStdin`、`92-101` `relayHostEvent`。
- 宿主事件中的 `cwd` 字段透传（不做路径转换）：
  - `bridge/src/daemon/state.ts:44-45`（`cwd` 字段定义）、`state.ts:491-503`（从 `parsed['cwd']` 取 cwd）。

### 2.2 Pet/ UE5 C++ 渲染端

#### 2.2.1 Win32 分层窗口（核心硬依赖）

- 头文件直接 include `<Windows.h>`：
  - `Pet/Source/Pet/Private/Platform/PetLayeredWindow.h:5-7`、`Pet/Source/Pet/Private/Platform/PetLayeredWindow.cpp:1-8`。
- 自建窗口用 `WS_EX_LAYERED` + `UpdateLayeredWindow` 实现逐像素透明与透明像素鼠标穿透：
  - `PetLayeredWindow.h:9-15` 注释；`PetLayeredWindow.cpp:34-41` `CreateWindowEx(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, ...)`。
  - `PetLayeredWindow.cpp:43-68`：`CreateDIBSection` 建 32bpp 顶向下 DIB，`Present` 前清零。
  - `PetLayeredWindow.cpp:189-202` `UpdateOnScreen`：`UpdateLayeredWindow(..., ULW_ALPHA)`。
- 输入全部走 Win32 消息与钩子：
  - `PetLayeredWindow.cpp:76` `SetWindowsHookEx(WH_MOUSE_LL, ...)`（低层鼠标钩子）。
  - `PetLayeredWindow.cpp:226-460`：`WM_NCHITTEST / WM_LBUTTONDOWN / WM_MOUSEMOVE / WM_LBUTTONUP / WM_MOUSEWHEEL / WM_SETCURSOR / WM_DISPLAYCHANGE / WM_DWMCOMPOSITIONCHANGED` 等。
  - `PetLayeredWindow.cpp:312-313` `GetSystemMetrics(SM_CXDRAG/SM_CYDRAG)`；`PetLayeredWindow.cpp:117,247-248,286,444,465` 大量 `GetAsyncKeyState('R' / VK_ESCAPE)`。
  - `PetLayeredWindow.cpp:478-494` `IsOpaqueScreenPoint`：直接读 DIB alpha 判定点击穿透。
- 未做平台宏隔离，直接实例化：
  - `Pet/Source/Pet/Private/Player/PetCapturePawn.cpp:160-162`：`PetWindow = new PetLayeredWindow(); PetWindow->Create(RTSize, 150, 150)`。
  - `Pet/Source/Pet/Private/Player/PetCapturePawn.cpp:663`：`PetWindow->SetCameraCursorImage(...)`。

#### 2.2.2 控制管道客户端（Win32 命名管道）

- `Pet/Source/Pet/Private/Communication/PetControlClient.cpp:19-21` 与 `PetControlClient.h:7-9`：include `<Windows.h>` + `AllowWindowsPlatformTypes`。
- 连接用 Win32 API：
  - `PetControlClient.cpp:226-255` `TryConnect`：`CreateFileW` / `WaitNamedPipeW` / `ERROR_PIPE_BUSY`。
  - `PetControlClient.cpp:257-370` `ReadAndWriteLoop`：`OVERLAPPED` + `ReadFile` / `WriteFile` 重叠 IO。
- 管道名拼装用 `GetUserNameW`：
  - `PetControlClient.cpp:729-750` `BuildPipeName`：`GetUserNameW` → `USERNAME` → `USER`，拼 `\\.\pipe\KimiPet.PET.<用户名>`。
- 显示器 id 用 `MonitorFromPoint` / `GetMonitorInfoW`：
  - `PetControlClient.cpp:134-147` `SendPetMoved`。

#### 2.2.3 会话面板（这部分是跨平台 Slate，Mac 可直接复用）

- 会话面板是标准 Slate `SWindow`，不依赖 Win32：
  - `Pet/Source/Pet/Private/UI/PetSessionWindowHost.cpp:145-162`：`SWindow` + `EWindowType::Notification` + `IsTopmostWindow(true)` + `SupportsTransparency(EWindowTransparency::PerWindow)` + `ActivationPolicy(EWindowActivationPolicy::Never)`。
  - `Pet/Source/Pet/Private/Pet.cpp:13-137`：Slate 启动守卫（隐藏默认游戏窗口），跨平台 Slate API。
- DPI 坐标契约换算在 `PetCapturePawn.cpp:352-368`，使用跨平台 `FPlatformApplicationMisc::GetDPIScaleFactorAtPoint`，但注释写「Win32 物理像素」。

### 2.3 tools/ 与打包

- `tools/verify-pet-operations.ps1`：PowerShell + Win32 P/Invoke（`user32.dll` 的 `EnumWindows/WindowFromPoint/SendMessageW/PrintWindow/SetCursorPos` 等，`tools/verify-pet-operations.ps1:20-57`、`140-295`），纯 Windows 验收。
- `tools/window-watch.ps1`：PowerShell + Win32 `EnumWindows` + `Get-CimInstance Win32_Process`（`tools/window-watch.ps1:14-23`、`43`、`90`）。
- `tools/mock-daemon.ts:35`：`\\.\pipe\KimiPet.PET.<用户名>` 命名管道。
- `tools/create-session-widget-assets.py:9`：调用 `UnrealEditor-Cmd.exe`（Windows UE 命令行）。
- `tools/package.ts`：整包打包全 Windows：
  - `tools/package.ts:42` `UE_ENGINE = "C:\\Program Files\\Epic Games\\UE_5.8"`。
  - `tools/package.ts:43` `RunUAT.bat`；`187` `taskkill /F /IM UnrealEditor.exe`；`191-198` `-platform=Win64`。
  - `tools/package.ts:156` `cmd.exe /c npm ...`；`271-273` `powershell.exe Compress-Archive`。
  - `tools/package.ts:47` `GAME_EXE_NAMES = ['pet.exe','kimipet.exe']`；`256` 产出 `bin/kimi-petd.exe`。
  - `tools/package.ts:160-166` `bun build --compile --windows-hide-console`。
- `bridge/package.json:12` `build:exe`：`bun build --compile --windows-hide-console dist/launcher/main.js --outfile bin/kimi-petd.exe`。
- `tools/blender-direct.ts`、`tools/extract-camera-cursor-image.ts`：跨平台（`node:net` / `node:zlib`），无实质 Windows 依赖（`extract-camera-cursor-image.ts:33-34` 的 CRLF 只是生成头文件的既有约定）。

---

## 3. WSL 兼容方案

WSL 有两种截然不同的部署形态，改造点完全不同。先明确一个关键事实：

> **WSL2 interop（默认开启）允许在 WSL 内直接启动 Windows 可执行文件**，例如 `/mnt/c/.../kimi-petd.exe` 或 `wt.exe`、`wslpath.exe`。Windows 进程被拉起后，其运行环境是 Windows（能连 Windows 命名管道、能拉起 `Pet.exe`），但入参/工作目录/cwd 字符串仍是 Linux 语义，需要显式转换。

### 3.1 形态一：CLI 会话在 WSL、守护进程仍在 Windows（推荐）

此形态下：kimi CLI 跑在 WSL 发行版里；守护进程 `kimi-petd --daemon` 与渲染端 `Pet.exe` 继续跑在 Windows。转发器需要能「从 WSL 把事件交到 Windows 守护进程」。

**核心问题有三个：**

1. **插件 hook 命令在 WSL 里是 `.\bin\kimi-petd.exe --relay`，这个命令无法直接执行**（bash 不认反斜杠，且 Linux 里没有 `.exe` 语义）。见 `bridge/packaging/kimi-pet/kimi.plugin.json:6-17`。
2. **宿主事件里的 `cwd` 与 `KIMI_CODE_HOME` 是 Linux 路径**，守护进程在 Windows 侧要用 Windows 路径（渲染端回显、`open_tui` 的 `-d`、会话目录读取）。见 `bridge/src/daemon/state.ts:491-503`、`bridge/src/daemon/session-catalog.ts:73-77,236-239`。
3. **点击会话唤起终端时，`open_tui` 目前只会 `wt.exe -d <Windows cwd>`**，无法在 WSL 目录里开一个 wsl profile。见 `bridge/src/daemon/terminal.ts:27-41`。

**推荐方案：hook 经 interop 直启 Windows 转发器，路径转换集中在守护进程入口与转发器入口。**

- hook 命令改为跨发行版的互操作写法（在 WSL 内能定位到 Windows 插件目录）。两种可行做法：
  - （推荐）插件清单增加 WSL 专用清单（或运行时探测），command 用 `/mnt/<drive>/<path>/bin/kimi-petd.exe --relay`（把 `.\bin\...` 换成 interop 绝对路径）。
  - 或者用 `wslpath` / 环境变量 `KIMI_PLUGIN_ROOT_WIN` 在安装时写入 Windows 路径。
- 事件里的 cwd 是 Linux 路径。转换点建议放在**守护进程 `resolveRendererPath`/会话读取之后、真正使用 cwd 之前**（`app.ts:424-434` 的 `open_tui` cwd 与 `state.ts` 的会话 cwd），统一过一层 `wslToWindowsPath()`：
  - `/mnt/c/Users/...` → `C:\Users\...`；
  - `/home/<user>/...`（WSL 原生 ext4）→ `\\wsl.localhost\<发行版>\home\<user>\...`（或 `\\wsl$\<发行版>\...`，取决于 WSL 版本）。
  - 反向（Windows → WSL）在需要把会话 cwd 回显给 WSL CLI 时也要做：`C:\...` → `/mnt/c/...`，`\\wsl.localhost\<发行版>\...` → `/home/...`。
- `open_tui` 在形态一下需要新增「WSL 终端唤起」分支：
  - 首选 `wt.exe -d <Windows cwd> wsl.exe -d <发行版> --cd <Linux cwd> -- kimi --session <id>`（或在 Windows Terminal 里配置 wsl profile 后 `wt.exe -p <wsl profile> -d <dir>`）。
  - 实现要点：`terminal.ts` 增加 `terminal: 'wsl' | 'wt' | 'cmd'`（或新增 `open_target` 语义），在 `config.ts:32-33,120-125` 放开类型。`wt.exe` 不存在时仍可回退 `wsl.exe` 直接唤终端（`wsl.exe ~ -e bash -lc "cd <dir> && kimi --session <id>"`）。

**文件级改造点清单（形态一）：**

| 文件 | 现状（引用） | 改造 |
|------|-------------|------|
| `bridge/packaging/kimi-pet/kimi.plugin.json:6-17` | command 为 `.\bin\kimi-petd.exe --relay` | 增加 WSL 兼容的 command（interop 绝对路径）或新增 WSL 清单 |
| `bridge/src/daemon/config.ts:46-49,73-82` | `%VAR%` 展开 + 默认 `Pet.exe` | 兼容 `$VAR`/`${VAR}`；`renderer_path` 默认按平台选 `Pet.exe`/`Pet.app/...`；补一个 `wsl_distro` 配置项 |
| `bridge/src/daemon/config.ts:32-33,120-125,147` | `terminal: 'wt' \| 'cmd'` | 扩展 `terminal` 支持 `'wsl'` |
| `bridge/src/daemon/terminal.ts:27-41` | 只构造 wt/cmd 命令 | 增加 wsl 命令构造 + `wslToWindowsPath`/反向转换 |
| `bridge/src/daemon/app.ts:424-434` | `open_tui` cwd 直接透传 | 在传 cwd 前做 WSL↔Windows 路径转换 |
| `bridge/src/daemon/session-catalog.ts:236-239` | 只认盘符/UNC 绝对路径 | 增加 `/mnt/...`、`/home/...` 的绝对路径识别（或统一路径转换层） |
| `bridge/src/bridge/daemon.ts:18,45-53` | 硬编码 `.exe` / `kimi-petd.exe` | 保留 Windows 产物即可（形态一下守护进程仍是 Windows exe，无需改） |
| `bridge/src/bridge/user.ts:29-37` | 用户名取 `os.userInfo()`/`USERNAME` | 形态一下无需改（转发器是 Windows 进程） |

### 3.2 形态二：守护进程整体跑在 WSL 内

此形态下：`kimi-petd --daemon` 以 Linux 进程跑在 WSL 里；渲染端 `Pet.exe` 仍在 Windows。

**核心问题：**

1. **事件/控制管道跨 WSL 边界**。Linux 进程不能直接 `CreateFileW` 连 `\\.\pipe\...`，也不能让 Windows `Pet.exe` 直接连 Linux 的 Unix domain socket。需要一个跨边界的传输层。
   - Node 侧 `node:net` 已经抽象了 `listen(path)`/`connect(path)`（`pipes.ts:63-70`、`pipe.ts:22-83`），把路径从 `\\.\pipe\...` 换成 Unix domain socket 路径即可（如 `$XDG_RUNTIME_DIR/kimi-pet-<uid>.sock` 或 `/tmp/kimi-pet-<uid>.sock`），**Node 侧几乎零改动**。
   - 真正的难点是 **UE 控制管道客户端**（`PetControlClient.cpp:226-255` 用 Win32 命名管道）要改成能连进 WSL。推荐：控制通道从「命名管道」换成 **TCP localhost**（`127.0.0.1:<端口>`），Windows 与 WSL 之间通过 localhost 端口转发互通（WSL2 默认支持 localhost 转发；WSL1 共享网络栈，同样可用）。这一改动需要同时改 `PetControlClient.cpp` 的 `TryConnect/ReadAndWriteLoop` 与 `bridge/src/daemon/pipes.ts` 的控制管道服务端。
2. **终端唤起**。守护进程在 WSL 内，`open_tui` 要在 Windows 桌面唤起终端：
   - 经 interop 调 `wt.exe` 或 `cmd.exe /c start`（从 WSL 内直接 `wt.exe -d <Windows cwd> wsl.exe --cd <Linux cwd> ...`）。
3. **KIMI_CODE_HOME 与路径**。守护进程在 WSL 内读到的 `KIMI_CODE_HOME` 是 Linux 路径（`~/.kimi-code` 在 WSL 用户主目录），而渲染端/Pet.exe 在 Windows 读的又是 Windows 侧目录。两边的会话目录、位置缓存、抑制标记（`pet.disabled`）会出现双份/不同步：
   - `bridge/src/daemon/config.ts:52-56`、`session-catalog.ts:73-77`、`petstate.ts:10-12`（`%APPDATA%` 在 Linux 无此变量）。
   - `PetControlClient.cpp:34-49` `WriteCloseSuppressionMarker` 写的是 Windows `%TEMP%/kimi-pet/pet.disabled`，与 WSL 内守护进程的 `%TEMP%`（Linux `/tmp`）不一致，会导致「用户关闭标记」失配。

**文件级改造点清单（形态二）：**

| 文件 | 现状（引用） | 改造 |
|------|-------------|------|
| `bridge/src/bridge/user.ts:39-48` | `\\.\pipe\...` | 平台分支：Windows 用命名管道，POSIX 用 Unix domain socket 路径 |
| `bridge/src/daemon/pipes.ts:63-70` | `net.createServer().listen(pipeName)` | 控制管道改用 TCP localhost（跨 WSL 边界） |
| `bridge/src/bridge/pipe.ts:13-14,22-83` | 命名管道错误码/连接 | 事件管道按平台走 UDS/TCP |
| `Pet/Source/Pet/Private/Communication/PetControlClient.cpp:226-255,257-370,729-750` | Win32 命名管道 | 控制通道客户端改 TCP（`FSocket`/BSD socket） |
| `bridge/src/daemon/terminal.ts:27-41` | wt/cmd | 经 interop 唤 Windows 终端 + WSL 目录 |
| `bridge/src/daemon/config.ts:46-49` | `%VAR%` | 兼容 `$VAR`；路径分隔符平台化 |
| `bridge/src/daemon/petstate.ts:10-12` | `%APPDATA%` | WSL 下改 `XDG_DATA_HOME` 或统一到 `KIMI_CODE_HOME/kimipet` |
| `bridge/src/bridge/daemon.ts:18,45-53` | `kimi-petd.exe` | 平台产物名 `kimi-petd`（Linux ELF） |

### 3.3 WSL 推荐结论

**推荐形态一（守护进程仍在 Windows）**，理由：

- 复用现有 Win32 分层窗口渲染端与 Windows 命名管道，**渲染端与控制管道完全不用动**。
- 改造集中在「转发器入口 + 路径转换 + 终端 profile」，风险低、可灰度。
- 形态二的「控制管道跨 WSL 边界改 TCP」会同时牵动 UE 客户端与守护进程服务端，且带来两套配置目录/抑制标记同步问题，复杂度显著更高，仅当未来需要「纯 Linux 环境无 Windows 渲染端」时才值得做。

---

## 4. macOS 兼容方案

macOS 是真正的「第二平台」，守护进程、转发器、渲染端三块都要动。

### 4.1 守护进程/转发器移植点

| 模块 | 现状（引用） | macOS 改造 |
|------|-------------|-----------|
| 事件/控制管道 | `bridge/src/bridge/user.ts:39-48`、`bridge/src/bridge/pipe.ts:13-14,22-83`、`bridge/src/daemon/pipes.ts:63-70` | `node:net` 换 Unix domain socket 路径（如 `$TMPDIR/kimi-pet-<uid>.sock` 或 `~/.kimi-code/kimipet/*.sock`）；`EADDRINUSE` 单实例语义在 UDS 下仍是「socket 文件已存在」，但需在启动前清理 stale socket 文件 |
| 控制管道（服务端） | `bridge/src/daemon/pipes.ts:63-70` | 同上，UDS；渲染端客户端也要改成 UDS/TCP（见 4.2） |
| 暂存/锁/抑制标记 | `bridge/src/bridge/staging.ts:28-31`、`bridge/src/bridge/daemon.ts:55-80` | 已用 `os.tmpdir()`，跨平台可用；注释 `%TEMP%` 改为 `$TMPDIR` |
| 终端唤起 | `bridge/src/daemon/terminal.ts:27-41`、`config.ts:32-33` | `open -a Terminal <cwd>` 或 `osascript -e 'tell app "Terminal" to do script "cd <cwd> && kimi --session <id>"'`；iTerm2 用 `open -a iTerm <cwd>`；去掉 `windowsHide`（无害，但语义无关） |
| 环境变量展开 | `bridge/src/daemon/config.ts:46-49` | 兼容 `$VAR`/`${VAR}`（macOS/Linux 无 `%VAR%`） |
| 默认渲染路径 | `bridge/src/daemon/config.ts:73-82` | 默认改为 `renderer/Pet.app/Contents/MacOS/Pet`（UE5 Mac 产物是 `.app`） |
| 位置缓存 | `bridge/src/daemon/petstate.ts:10-12` | `APPDATA` 换成 `~/Library/Application Support/KimiPet/pet-state.json` |
| 会话绝对路径识别 | `bridge/src/daemon/session-catalog.ts:236-239` | 增加 POSIX 绝对路径（`/` 开头）识别；macOS 下 `path.isAbsolute` 本就正确，主要补 `/^[A-Za-z]:[\\/]/` 与 `\\\\` 分支的平台化 |
| 可执行产物 | `bridge/src/bridge/daemon.ts:18,45-53`、`bridge/src/launcher/main.ts:1-25` | `bun build --compile`（不带 `--windows-hide-console`）产出 Mach-O `kimi-petd`；`.exe` 判定改为平台化 |
| 单实例 | `bridge/src/daemon/app.ts:7-9,179` | UDS 复用 EADDRINUSE 语义即可，逻辑不变 |

### 4.2 渲染端可行性（UE5 Mac 透明无边框/分层窗口替代）

现状渲染端是「Win32 自建分层窗口 + scene capture 读回 + BGRA 上屏」，Mac 上**没有 `WS_EX_LAYERED`/`UpdateLayeredWindow` 的对应物**，这是整个 macOS 移植里最重的部分。

- 现状硬依赖：`PetLayeredWindow.h:5-7`、`PetLayeredWindow.cpp:34-41,189-202`（ULW）、`PetLayeredWindow.cpp:76,226-460`（WH_MOUSE_LL + WM_* 手势）、`PetControlClient.cpp:226-255`（Win32 命名管道）。
- macOS 替代方案（按推荐度排序）：

  1. **原生 NSWindow + CALayer（推荐）**：UE5 Mac 支持在 Slate 之上用原生窗口。透明无边框窗口用 `NSWindowStyleMaskBorderless` + `backgroundColor = NSColor.clearColor` + `setOpaque:NO` + `setLevel: NSFloatingWindowLevel`（置顶）+ `setIgnoresMouseEvents:YES`（透明区点击穿透，按 hit-test 逐帧切换）。这需要新增一个 UE `Mac` 平台扩展（`Pet/Source/Pet/Private/Platform/Mac/PetLayeredWindowMac.cpp` 或用 `#if PLATFORM_MAC` 实现同一 `PetLayeredWindow` 接口），把 `Present` 的 BGRA 写到 `CALayer`/`CGImage`。
  2. **纯 Slate `SWindow` + `SupportsTransparency(PerWindow)`（改动更小但功能受限）**：会话面板已经在用这套（`PetSessionWindowHost.cpp:145-162`）。但宠物本体需要「逐像素透明 + 透明区点击穿透 + 全局拖拽 + R 键摄像机手势 + 低层滚轮钩子」，Slate 原生窗口无法覆盖「透明区穿透」与「全局鼠标钩子」，只适合做第一版降级（宠物固定不透明方形、仅面板透明）。
  3. **Qt/第三方窗口层**：引入额外依赖，与 UE 集成成本高，不推荐。

- 输入手势重写：`PetLayeredWindow.cpp` 的拖拽阈值（`GetSystemMetrics(SM_CXDRAG)`）、R 键摄像机（`GetAsyncKeyState`）、低层滚轮钩子（`WH_MOUSE_LL`）在 Mac 上分别对应 `NSEvent`/`CGEventTap`（需要辅助功能权限）与 `NSEvent.pressedMouseButtons`。**全局鼠标钩子在 macOS 需要 Accessibility/Input Monitoring 授权**，这是分发与上架层面的额外门槛。
- 控制通道：渲染端 `PetControlClient.cpp` 的 Win32 命名管道需改为 **TCP localhost 或 Unix domain socket**（UE 侧可用 `FSocket`/`FTcpSocketBuilder`，或 POSIX `socket()` 连 UDS）。推荐统一改 TCP localhost，让 Windows 与 macOS 走同一套控制通道，减少双份维护。
- 引擎侧：`Pet.Build.cs` 目前无平台限定（`Pet.Build.cs:11-41`），本身不阻塞 Mac 构建；`Pet/Source/Pet/Private/Platform/` 下两个文件需要按平台拆分。

### 4.3 打包分发差异

| 项目 | Windows（现状） | macOS（目标） |
|------|----------------|--------------|
| bridge 产物 | `bin/kimi-petd.exe`（`bridge/package.json:12`） | `bin/kimi-petd`（Mach-O，`bun build --compile` 不带 `--windows-hide-console`） |
| 渲染端产物 | `renderer/Pet.exe`（`tools/package.ts:47,191-198`） | `renderer/Pet.app`（`RunUAT -platform=Mac`，`.app` bundle + `Info.plist`） |
| 打包脚本 | `tools/package.ts:42-43,156,187,271-273`（`cmd.exe`/`taskkill`/`powershell`） | `tools/package.ts` 增加 macOS 分支（`open`/`osascript`/`codesign`/`notarization`；`Compress-Archive` 换成 `ditto -c -k` 或 `zip -r`） |
| 运行库 | `vc_redist.x64.exe`（`tools/package.ts:7-9`） | macOS 无 VC++ 运行库要求；需处理 `codesign --deep --force` + 公证 |
| 插件清单 | `.\bin\kimi-petd.exe --relay`（`kimi.plugin.json:6-17`） | `./bin/kimi-petd --relay`（正斜杠，无 `.exe`） |

---

## 5. 分阶段落地建议（按「改动小 / 收益大」优先级）

> 实施状态（2026-08-18）：**P0（1-6）与 P1（7-9）已实现**，bridge 测试 206/206 通过；但仅在 Windows 宿主编译与单测验证，WSL 真机（插件安装、relay 脚本 interop 拉起、wt/wsl 终端唤起、路径转换端到端）尚未实测。P2 起尚未动工。

**P0 —— 平台无关的清理（立即可做，风险极低，且是后续所有工作的地基）**

1. `bridge/src/daemon/config.ts:46-49`：`expandEnvVars` 同时支持 `%VAR%` 与 `$VAR`/`${VAR}`。
2. `bridge/src/daemon/config.ts:73-82`：`renderer_path` 默认值平台化（Windows 拼 `Pet.exe`，非 Windows 拼 `.app`/ELF），不再无条件写死 `.exe`。
3. `bridge/src/bridge/daemon.ts:18,45-53`、`bridge/src/launcher/main.ts:23`：`kimi-petd.exe` 判定改为平台化产物名（Windows 保留现状，其余平台 `kimi-petd`）。
4. `bridge/src/daemon/session-catalog.ts:236-239`：`resolveSessionDir` 增加 POSIX 绝对路径识别，平台化盘符/UNC 判断。
5. `bridge/src/daemon/petstate.ts:10-12`：`%APPDATA%` 加平台分支（macOS 用 `~/Library/Application Support`，Linux 用 `XDG_DATA_HOME`）。
6. 注释里的 `%TEMP%`/`%KIMI_CODE_HOME%`/`.exe` 表述同步改为平台中立措辞（`logger.ts:2`、`staging.ts:2,10`、`daemon.ts:55` 等），避免误导后续维护。

**P1 —— WSL 形态一（守护进程留在 Windows）**

7. `kimi.plugin.json` 增加 WSL 兼容 command（interop 绝对路径）。
8. `terminal.ts` 新增 `wsl` 唤起分支 + `config.ts` 放开 `terminal` 类型。
9. 引入统一的 WSL↔Windows 路径转换工具，接到 `app.ts:424-434` 的 `open_tui` cwd 与会话 cwd 读取处。

**P2 —— 控制通道去 Windows 化（为 macOS/形态二铺路）**

10. 控制通道改 TCP localhost：`pipes.ts:63-70`（服务端）+ `PetControlClient.cpp:226-370`（客户端）。这是 macOS 与 WSL 形态二共用的关键一步，建议在 Windows 上先灰度验证 TCP 通道与命名管道等价。

**P3 —— macOS 守护进程/转发器**

11. 完成 4.1 的 UDS 管道、终端唤起、打包脚本 macOS 分支；先以「守护进程 + mock 渲染端」跑通 macOS 端到端，再谈真实渲染端。

**P4 —— macOS 渲染端（重写级）**

12. 按 4.2 方案一实现 `PetLayeredWindow` 的 Mac 实现（NSWindow + CALayer + `CGEventTap` 输入），并处理 Accessibility 授权与公证。此阶段投入最大，建议等 P2/P3 验证了「TCP 控制通道 + 守护进程」的跨平台正确性后再启动。

---

## 6. 风险与开放问题（未验证项，需后续确认）

- **WSL 端到端未实测（P0/P1 已实现的全部内容）**：WSL 清单 `kimi.plugin.wsl.json` 的安装方式（覆盖为 `kimi.plugin.json`）、`bin/kimi-pet-relay.sh` 经 interop 拉起 exe、`terminal: 'wsl'` 的 wt 直拉与 cmd 回退（含 `wsl.exe --cd` / `bash -lc` 参数打包行为）、`wsl-path.ts` 的双向转换，均只经过纯函数与注入式单测，未在真实 WSL 环境验证。

- **WSL 命名管道可达性**：本文基于「Linux 进程不能直连 `\\.\pipe\...`」的常识判断，未在 WSL 环境实测；形态一建议用 interop 直启 Windows 转发器绕开此问题，但「interop 直启 exe 时 cwd 如何被翻译」仍需实测确认（影响 `relay` 读 stdin 与 `resolveDaemonPath` 的 `process.cwd()`，见 `bridge/src/bridge/daemon.ts:52`）。
- **UE5 Mac 透明窗口 + 点击穿透**：`EWindowTransparency::PerWindow`（`PetSessionWindowHost.cpp:156`）在 Slate 侧支持透明，但「透明区点击穿透」与「无边框置顶」在 Mac 上的具体能力边界、以及 `NSWindow` 与 UE 游戏主窗口的关系，需要 PoC 验证。
- **macOS 全局鼠标钩子授权**：`WH_MOUSE_LL` 的等价物 `CGEventTap` 需要 Accessibility/Input Monitoring 权限，未验证在 UE 打包 `.app` 下如何申请与生效。
- **`bun build --compile` 的 macOS 行为**：本文假设其产出原生 Mach-O 且无需 `--windows-hide-console`，未在本机 macOS 实测；`--compile` 的 macOS 是否需要额外签名/`chmod +x` 需打包脚本处理。
- **会话目录双写/抑制标记一致性（WSL 形态二）**：`PetControlClient.cpp:34-49` 写 Windows `%TEMP%`，与 WSL 内守护进程的 Linux `/tmp` 不互通，是形态二的已知难点，本文只定性、未给完整设计。
