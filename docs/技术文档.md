# KPet 技术文档

本文档介绍 KPet 的系统架构、渲染链路、宿主插件、守护进程、通信协议、源码结构和开发方式。玩法与功能介绍见仓库根目录的 [README](../README.md)。

## 系统架构

KPet 由守护进程与渲染进程两个常驻进程组成；每次宿主事件钩子临时拉起同一可执行文件的转发器模式：

```text
Kimi Code CLI
      │ 每次事件钩子启动一次
      ▼
kpetd.exe --relay           短生命周期转发器（与守护进程同一可执行文件）
      │ 事件命名管道（单向）
      ▼
kpetd.exe --daemon          常驻守护进程
      │ 控制命名管道（双向）
      ▼
Pet.exe                         UE5 渲染进程
      ├─ Win32 逐像素透明宠物窗口
      └─ WebUI 会话面板 / 设置面板（CEF SWebBrowser 弹窗）
```

Kimi Code 的事件钩子是短生命周期命令，无法直接承担长期状态管理。转发器因此只负责快速交付事件；守护进程负责跨会话状态、事件恢复和渲染进程生命周期；UE5 进程专注于角色呈现与桌面交互。

## 宿主插件与转发器

插件清单位于 [`bridge/packaging/kpet/kimi.plugin.json`](../bridge/packaging/kpet/kimi.plugin.json)。它监听以下 12 类 Kimi Code 事件：

- 会话：`SessionStart`、`SessionEnd`、`UserPromptSubmit`。
- 工具：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`。
- 执行：`Stop`、`StopFailure`、`Interrupt`。
- 子代理与通知：`SubagentStart`、`SubagentStop`、`Notification`。

部分事件带 matcher 过滤：`SessionStart` 为 `startup|resume`、`SessionEnd` 为 `exit`、`Notification` 为 `task\.completed`。每个事件都会拉起一次 `kpetd.exe --relay`（WSL 宿主走 `bin/kpet-relay.sh --relay`，见「插件目录」）。

转发器从标准输入读取宿主事件 JSON，将原始文本整体封装为 `host_event` 信封（`payload._raw` 原文透传，不解析不重排），再按会话写入事件管道。业务字段由守护进程防御性解析，转发器不依赖宿主事件的完整字段集合。

转发器采用失败放行策略：连接与写入的总超时为 200 毫秒，守护进程未运行时以分离方式拉起，仍未送达的事件暂存到 `%TEMP%\kpet-events\`（文件按事件顺序编号，供守护进程启动时有序重放）。无论事件是否成功交付，转发器都以退出码 0 结束，避免阻塞 Kimi Code 主流程。

并发钩子使用锁文件、投递租约和恢复交接机制协调：事件管道名占用即视为已有实例（单实例）；用户关闭后由下一次 `SessionStart` 发起恢复批次，恢复 worker 等待旧管道释放、消费关闭标记后再拉起新守护进程，从而维持用户关闭与下一次会话恢复之间的事件顺序。

## 守护进程

`kpetd.exe` 使用 TypeScript、Node.js 22 和 ESM 实现，运行时只依赖 Node.js 标准库。它不是 Windows 服务，也不注册开机启动，而是在首个合法宿主事件到来时按需运行。

单可执行文件按首个参数分发模式（[`bridge/src/launcher/main.ts`](../bridge/src/launcher/main.ts)）：`--relay`（或空参数，转发器）、`--daemon`（守护进程）、`--stop`（停止守护进程，插件升级时用）、`--kpet-recover`（分离恢复 worker）。

守护进程的主要职责包括：

- 按 `session_id` 维护活跃会话、工作状态、未读状态和任务集合。
- 聚合全局 `Idle` 与 `Working` 状态，并作为宠物状态的唯一权威（`pet_state` 是状态切换的唯一权威消息）。
- 将工具调用、子代理和通知事件转换为任务与通知协议消息，并以 200 毫秒窗口合并同一会话的高频任务事件。
- 读取 Kimi Code 会话目录（`session_index.jsonl` + 各会话 `state.json`），将历史记录与实时活跃会话状态合并。
- 管理 `Pet.exe` 的启动、心跳、断线、退出和指数退避重启。
- 在渲染进程重新连接后补发会话、任务、宠物状态与配置快照（含握手收尾的 `config_snapshot`）。
- 回放转发器暂存的事件，并在退出前持久化宠物窗口位置。
- 响应 `open_tui`，打开指定 Kimi Code 会话或继续最近会话；唤起失败补发错误气泡。
- 响应 `update_config`（设置 WebUI 保存）：校验合并配置 → 写回 `config.json` → 回推 `config_snapshot`；无合法字段时回 `protocol_error`。

全局状态遵循“任一会话忙则 `Working`，全部会话闲则 `Idle`”的规则。忙会话默认 10 分钟没有新事件时强制转为空闲（`staleMinutes`，避免遗漏结束事件后永久卡住）；异常会话连续 60 分钟（`cleanupMinutes`）没有事件时才从活跃集合清理。

渲染进程异常退出（控制管道断开或心跳超时）时，守护进程按照 1、2、4、8 秒、之后封顶 8 秒的退避序列重启，60 秒窗口内最多尝试 5 次；窗口内超限即停手，等下一个宿主事件再开启下一轮。渲染进程路径不存在时记日志且不退避刷屏，同样等宿主事件重试。

## 渲染进程

渲染进程是 Unreal Engine 5.8 C++ Runtime 工程。角色使用 Skeletal Mesh、Animation Blueprint 和 Control Rig，场景通过独立捕获组件输出到透明桌面窗口。

### 宠物本体渲染链路

```text
UE 场景、灯光与骨骼动画
      ▼
SceneCaptureComponent2D
      ▼
按显示器 DPI 换算的 BGRA8 RenderTarget
      ▼
FRHIGPUTextureReadback 异步回读上一帧
      ▼
反转 Alpha，清理全透明像素 RGB
      ▼
UpdateLayeredWindow
      ▼
Windows 桌面
```

`USceneCaptureComponent2D` 使用 `SCS_FinalColorLDR`，目标纹理为 `PF_B8G8R8A8`。桌宠边长固定为 `320 × 320` 逻辑像素，RenderTarget、DIB 与原生窗口按所在显示器的 DPI 同步换算为物理像素；例如 150% 缩放为 `480 × 480`，200% 缩放为 `640 × 640`。`FRHIGPUTextureReadback` 在渲染线程异步复制上一帧，避免同步 GPU 回读阻塞游戏线程；跨显示器收到 `WM_DPICHANGED` 时等待旧副本完成并重建回读资源，逐行上屏时保留 RHI 行间距语义。

Scene Capture 输出采用预乘 RGB 与反向不透明度 Alpha。CPU 侧执行 `A = 255 - A`，并把完全透明像素的 RGB 清零，再交给 `UpdateLayeredWindow`。这一处理保证数据满足分层窗口的预乘 Alpha 语义，同时消除色调映射抖动对透明背景的颜色污染。

宠物窗口使用以下 Win32 扩展样式：

- `WS_EX_LAYERED`：逐像素透明合成。
- `WS_EX_TOPMOST`：保持在普通应用窗口上方。
- `WS_EX_TOOLWINDOW`：不显示为普通任务栏窗口。
- `WS_EX_NOACTIVATE`：交互时不主动抢走前台焦点。

窗口命中测试读取当前帧的 Alpha。不透明像素返回 `HTCLIENT` 并接收点击、拖拽与摄像机操作；透明像素返回 `HTTRANSPARENT`，输入继续传给桌面下方窗口。

### 默认窗口隐藏

守护进程使用以下参数启动渲染进程：

```text
-NOSPLASH -windowed -ResX=16 -ResY=16
```

项目模块通过 Slate `OnPreTick` 守卫在默认游戏窗口首次绘制前将其隐藏。渲染进程不使用离屏渲染模式（`RenderOffScreen`），因为会话面板需要创建真实的平台窗口；启动目录取可执行文件所在目录，UE 需要相对自身目录加载数据包。

### 会话面板

会话面板不经过 GPU 回读链路，且仅 WebUI 路径（UMG 路径已移除，无降级）：`FPetSessionWindowHost` 创建的 `Notification` 类型 Slate Popup `SWindow` 内嵌入 `SWebBrowser`（CEF，见 `FPetSessionWebPanel`），加载 `Content/UI/Web/session-panel.html` 渲染会话列表；该 HTML 是非资产文件，打包时通过 `+DirectoriesToAlwaysStageAsNonUFS=(Directory="UI/Web")` 原样落地到包体 `Content` 下，目前仅舞台化了 CEF3/Win64。

- `FPetSessionWebPanel` 加载页面并把会话数据镜像为 C++ → JS 调用（`window.KPetPanel.*`），经 `UPetSessionWebBridge` 接收 JS → C++ 回调（选中会话、关闭面板）；`FPetSessionWebPanel::Create()` 失败（WebBrowser 模块不可用 / CEF 加载失败）时只记录错误日志，不再回退 UMG。
- `FPetSessionWindowHost` 管理窗口生命周期、显隐、左右锚定、工作区约束和窗口级动画，承载 WebUI 面板的 `SWebBrowser`。

窗口使用 `ActivationPolicy::Never`，自动显示时不主动激活应用。面板会根据宠物所在显示器的可用空间选择左侧或右侧。`SWindow::GetSizeInScreen`、`MoveWindowTo`、`FSlateApplication::GetWorkArea` 与 Win32 分层窗口统一使用平台屏幕物理像素；面板设计尺寸、间距与滑入距离则按当前显示器 DPI 换算后参与布局，避免重复缩放造成锚点错位。

会话面板与设置面板按堆栈式导航互斥：打开其中一个时若另一个已显示，已显示者被压栈隐藏，当前面板关闭后自动弹栈恢复，同一时间至多一个面板可见。堆栈状态机 `FPetPanelStack` 是纯逻辑（`EPetPanel` + Visible/Stashed 状态 + Close/Open 步骤），面板的每次开关都收口到 `ApplyPanelStackStep` 执行，含自动化测试（`Pet.UI.PanelStack`）。压栈隐藏期间面板一律不再下发增量 JS（`ExecutePanelScript` 收口闸门），主题、快照与 FPS 变更只进本地缓存；恢复可见时先全量重放，并由页面 `refreshSurface` 以两帧整页透明度变化强制 CEF 完整重绘，覆盖软件纹理首次仅上传脏矩形留下的圆角杂色与黑底。

透明合成链路（两个 WebUI 弹窗共用）：创建浏览器前追加 `-nocefaccelpaint` 强制 CEF 走软件 `OnPaint` 位图上传——加速共享纹理不带 alpha，且 CEF 偶发回退软件路径会造成纹理部分上传，连切主题时出现花屏重影；D3D11 交换链经 `DefaultEngine.ini` 的 `[SystemSettings]` 设 `r.D3D11.UseAllowTearing=0`（flip→blit）使 DWM 重定向对分层窗口生效——该 CVar 是 `ECVF_ReadOnly` 且在首个 viewport 构造时被锁存进静态变量，运行时 `Set` 无效，必须经 ini 在 RHI 初始化前落地（deferred-dummy 接管），面板创建时只回读有效值并记日志；窗口级 `SetLayeredWindowAttributes` 同时启用 `LWA_COLORKEY`（纯黑色键）与 `LWA_ALPHA` 逐像素透明度，CEF 透明像素预乘后恰为纯黑被色键抠除，卡片外区域由此透出桌面。Win 端再以 `SetWindowRgn` 按页面相同的 14px 半径裁剪原生窗口，综合色键偶发失效时也不会退化成矩形黑底。窗口从彻底隐藏恢复时先以零透明度预热约三帧，并在 `ShowWindow` 创建 viewport 后立即重放综合色键与圆角区域，避免快速开关时露出未初始化的黑色矩形。页面侧约束：body 必须透明、卡片禁用外侧 box-shadow（陈旧阴影像素不会被正确覆写，连切主题会在边缘留下色带）、页面内不得出现纯黑 RGB(0,0,0)（会被色键抠穿）。

### 设置面板

设置面板是与会话面板平行的第二个 WebUI 弹窗，用 `Ctrl+,` 打开（`PetLayeredWindow` 安装 `WH_KEYBOARD_LL` 低层键盘钩子观察组合键，仅当光标停在宠物不透明像素上时触发——与 ESC/R 同一语义，只观察不拦截、不全局抢占；按住连发只触发一次）。实现由 `FPetSettingsWebPanel` / `UPetSettingsWebBridge` 构成：加载 `Content/UI/Web/settings.html`，窗口复用 `FPetSessionWindowHost`（改为可配置客户区尺寸，设置面板使用 340×270 紧凑客户区且卡片铺满窗口，不保留会露出黑底的外围透明缓冲区），透明 Slate 弹窗、不抢焦点，位置锚定、透明合成链路与堆栈式导航均与会话面板一致（见上节）。

- C++ → JS：页面加载完成或快照更新后，经 `ExecuteJavascript` 调 `window.KPetSettings.applySettings({open_target, open_web_url, ui_theme, fps_monitor})`；页面未就绪前缓存快照、加载完成后重放。`open_web_url` 仅作展示，设置页没有修改它的 JS 回调。
- JS → C++：`window.ue.petsettings` 下的小写方法 `setopentarget` / `settheme` / `setfpsmonitor` / `closesettings` / `reportfps`（`BindUObject` 默认把函数名转小写暴露）。
- 三个修改类回调在 Pawn 总装处装接：乐观更新本地设置后组装单字段 `update_config`（仅 `open_target` / `ui_theme` / `fps_monitor`）经 `FPetControlClient` 下发；守护进程合并写回后回推 `config_snapshot`，Pawn 再对齐。`closesettings` 关闭窗口，`reportfps` 汇入 WebUI 帧率。

### FPS 监控

设置页“显示帧率”开关（`fps_monitor`）开启后，宠物窗口右上角绘制 FPS 叠加层，区分两个来源：

- **3D 世界帧率**：`APetCapturePawn::Tick` 每秒统计一次帧数作为 `3D` 值。
- **WebUI 帧率**：会话面板与设置面板的 Web 页面各自按 `requestAnimationFrame` 每秒经 `reportfps(n)` 上报一次 CEF 帧率，取最近上报值作为 `UI` 值；无上报时显示 `--`。

叠加层内容形如 `3D:120 UI:30`。由于分层窗口使用 32bpp 预乘 BGRA DIB，GDI `DrawText` 会把目标像素 alpha 清零导致文本不可见，因此 `PetLayeredWindow` 在 `Present` 上屏路径用内置 4×6 像素字体逐像素写入：绿字 + 半透明深色底保证任意背景可读，字形覆盖数字、`D/U/I`、空格、冒号/连字符（`PetPixelFont`，纯逻辑、含自动化测试）。`fps_monitor` 变化时同步叠加层开关与两个页面（会话面板 `KPetPanel.setFpsMonitor`，设置页经 `applySettings` 自带启停）。

## 进程间通信

KPet 在同一 Windows 用户会话中使用两条命名管道：

```text
\\.\pipe\KPet.H2D.<用户名>   转发器 → 守护进程（事件管道，单向）
\\.\pipe\KPet.PET.<用户名>   守护进程 ↔ 渲染进程（控制管道，双向）
```

用户名段中的 `\ / : * ? " < > |` 与控制字符会替换为 `_`，全部被替换时回退 `default`（node:net 命名管道路径不允许 `\`）。管道由 `node:net` 创建，继承进程默认安全描述符——守护进程以当前用户身份运行，其默认 DACL 只允许当前用户访问，因此不做额外 ACL 设置。

协议使用 UTF-8 JSON 文本流，每个紧凑 JSON 对象以换行（`\n`）结尾（node:net 命名管道是字节流而非消息模式，行分帧由 `StringDecoder` 处理，避免多字节字符跨 chunk 断裂）。单条消息上限 64 KB（`MAX_MESSAGE_BYTES`）。消息信封结构为：

```json
{
  "v": 1,
  "type": "pet_state",
  "id": "消息编号",
  "ts": "时间戳",
  "session_id": null,
  "payload": {}
}
```

当前协议主版本为 1（`PROTOCOL_VERSION`）。未知消息类型会被忽略并记录；非法信封返回 `protocol_error`（`raw_excerpt` 截断 256 字符），但不会中断后续消息；连续非法输入按 10 条/分钟的阈值告警。控制管道连接建立后，双方首先交换 `hello` 与能力列表，`hello.role` 必须是 `renderer`；主版本不一致时按较低版本降级。

### 消息类型

协议共 19 种消息类型，与 [`bridge/src/protocol/types.ts`](../bridge/src/protocol/types.ts) 的 `MESSAGE_TYPES` 一一对应：

| 类型 | 方向 | 触发 | 关键字段 |
|---|---|---|---|
| `host_event` | 转→守 | 每次事件钩子触发 | 唯一入站类型，`payload._raw` 为宿主原始 JSON 文本整体透传，守护进程内部解析映射 |
| `hello` | 双向 | 连接建立后首条 | 握手与版本协商：`protocol_version`、`role`(daemon/renderer)、`pid`、`version`、`capabilities[]` |
| `session_start` | 守→渲 | `SessionStart` | `cwd`、`resume`（是否恢复会话） |
| `session_end` | 守→渲 | `SessionEnd` | `reason` |
| `session_state` | 守→渲 | 单个会话工作/未读状态变化 | `working`、`unread`（按信封 `session_id` 关联） |
| `pet_state` | 守→渲 | 守护进程状态推导 | 状态切换唯一权威消息：`state`(Idle/Working)、`reason` |
| `task_start` | 守→渲 | `PreToolUse` / `SubagentStart` | 悬浮卡列表项：`task_id`、`title`、`tool` |
| `task_end` | 守→渲 | `PostToolUse` / `PostToolUseFailure` / `SubagentStop` | 触发完成气泡：`task_id`、`status`(success/failure)、`title`、`summary?` |
| `tasks_snapshot` | 守→渲 | 连接建立 / 渲染进程重启后 | 全量任务恢复：`tasks[]` |
| `sessions_snapshot` | 守→渲 | 连接建立 / 渲染进程重启后 | CLI 历史与活跃会话目录：`sessions[]` |
| `config_snapshot` | 守→渲 | 连接建立 / 配置更新后 | 全量配置快照（设置 WebUI 初始化）：`open_target`、`ui_theme`、`fps_monitor`、`open_web_url` |
| `notify` | 守→渲 | 任务完成/失败、`Notification` | 消息气泡：`text`、`level`(info/success/error)、`ttl_ms?`、`task_id?` |
| `open_tui` | 渲→守 | 点击宠物 / 点击气泡 | 请求打开终端：`session_id?`(空=最近会话)、`source`(pet/bubble)、`task_id?` |
| `heartbeat` | 渲→守 | 每 3 秒 | 保活心跳：`pid`、`uptime_s`、`state` |
| `pet_moved` | 渲→守 | 拖拽结束 | 位置持久化：`x`、`y`、`monitor_id` |
| `close_pet` | 渲→守 | 用户请求关闭宠物 | `payload.reason=user` |
| `update_config` | 渲→守 | 设置 WebUI 保存 | 请求更新守护进程配置：`open_target?` / `ui_theme?` / `fps_monitor?`（至少一个合法字段） |
| `shutdown` | 守→渲 | 守护进程退出前 | 通知渲染进程退出：`reason`(host_gone/user/error) |
| `protocol_error` | 双向 | 收到非法消息 | 仅日志用途：`description`、`raw_excerpt`(截断 256 字符) |

UE 控制客户端通过 `FRunnable` 工作线程和 Win32 重叠 I/O 收发管道数据，再把完整消息交给游戏线程解析。渲染进程每 3 秒发送一次心跳，守护进程默认 10 秒（`heartbeat_timeout_ms`，0 = 不检测）没有收到合法消息时判定连接失联。断线期间 UE 保持最后一个权威状态，不自行推导新的 `Idle` 或 `Working`。

### 宿主事件 → 协议消息映射与节流

守护进程状态机（[`bridge/src/daemon/state.ts`](../bridge/src/daemon/state.ts)）把宿主事件映射为协议消息：

| 宿主事件 | 状态机行为 | 下发消息 |
|---|---|---|
| `SessionStart` | 建会话/激活；重复开始幂等（不重置 busy/task）；`resume` 单调合并，不反向覆盖 | `session_start` + `session_state` |
| `UserPromptSubmit` | 会话置忙 → Working | `session_state` + `pet_state`(Working) |
| `PreToolUse` / `SubagentStart` | 会话置忙 → Working，新增任务（标题取 `tool_input.command`，降级子代理名/工具名/`正在工作…`） | `session_state` + `pet_state`(Working) + `task_start`（节流） |
| `PostToolUse` / `PostToolUseFailure` / `SubagentStop` | 结束任务（按同会话同工具名/子代理名匹配最近任务） | `task_end`（节流；failure 另发 `notify` 失败气泡） |
| `Stop` | 会话转闲、任务静默清空、`unread=true` | `session_state` + `pet_state`(Idle)，不再发 `task_end` |
| `StopFailure` | 同上 + 错误气泡 | 同上 + `notify`(任务出错) |
| `Interrupt` | 会话转闲、不弹完成气泡、不改 `unread` | `session_state` + `pet_state`(Idle) |
| `Notification` | 完成通知：成功气泡，不改主状态 | `notify`(success) |
| `SessionEnd` | 移除会话、丢弃其节流缓冲；无活跃会话 → Idle 并启动退出倒计时 | `session_end`（+ `pet_state`(Idle)，若全部会话结束） |

`PreToolUse`/`PostToolUse` 等高频任务事件在 200 毫秒窗口内按会话合并，同窗内 `task_start`+`task_end` 折叠为一条 `task_end`，避免渲染进程 UI 抖动。

### 关键时序

- **握手与快照补发**：渲染进程连入控制管道后首条发 `hello`（role=renderer），守护进程回 `hello`（role=daemon），随后按序补发 `sessions_snapshot` → 各活跃会话的 `session_start`+`session_state` → `pet_state` → `tasks_snapshot`，最后以 `config_snapshot` 收尾（设置 WebUI 初始化所需的全量配置）。
- **配置下发**：设置 WebUI 保存 → 渲→守 `update_config`（部分补丁）→ 守护进程逐字段校验合并（合法才覆盖、非法告警并保持当前值）→ 写回 `config.json` → 守→渲 `config_snapshot` 回推全量；无任何合法字段时回 `protocol_error`。
- **open_tui**：会话 id 为空 → 最近活跃会话（其次目录首条）→ cwd 取会话 cwd，取不到依次回退运行时会话目录、CLI 目录、用户主目录；唤起后标记该会话已读；唤起失败补发 `notify` 错误气泡。
- **退出**：最后一个 `SessionEnd` 且无活跃会话 → `host_grace_seconds`（默认 120 秒）倒计时，期间新宿主事件取消倒计时；倒计时结束或 `close_pet`/信号/异常 → 守护进程先停渲染进程重启，发最后一条 `shutdown`，释放两条管道，宽限 3 秒后强制结束渲染进程并退出（`auto_quit_with_host=false` 时保持常驻）。

## 终端与会话目录

点击会话行后，渲染进程发送 `open_tui`，由守护进程负责打开目标（`bridge/src/daemon/terminal.ts`）。`cwd` 与会话 id 解析见上节「关键时序」。

`open_target=cli` 时按 `terminal` 配置唤起终端：

- `terminal=wt`：`wt.exe -d <cwd> cmd /k kimi --session <会话编号>`；无会话编号用 `kimi --continue` 恢复最近会话。`wt.exe` 不可用（spawn ENOENT）时回退 `cmd /c start "" cmd /k kimi ...`。
- `terminal=cmd`：`cmd /c start "" cmd /k kimi --session <会话编号>`（外层 cmd 存根保持隐藏，真正的窗口由 `start` 新开）。
- `terminal=wsl`（跨平台方案形态一：CLI 在 WSL、守护进程在 Windows）：`wt.exe -d <Windows cwd> wsl.exe [-d <发行版>] --cd <Linux cwd> -- kimi --session <会话编号>`——cwd 为 Linux 路径时先经 `wslToWindowsPath` 转成 Windows 路径给 `wt -d`，`wsl.exe` 的 `--cd` 保留 Linux 原路径；发行版由 `wsl_distro` 指定，空串时用 WSL 默认发行版。`wt.exe` 缺失时回退 `cmd /c start "" wsl.exe [-d <发行版>] --cd <Linux cwd> --exec bash -lc "kimi ..."`（整条命令打包为 bash 的单个 argv，避免参数拆分）。

`open_target=web` 时用系统默认浏览器打开 `open_web_url` 模板 URL（支持 `{session_id}` 占位符）。官方文档确认 `kimi web` 在本地提供 web UI（默认端口 58627），但未公开「直接按会话 id 打开指定 CLI 会话」的 URL 格式；因此默认仅指向本地 web 首页，按会话恢复的 URL 属未验证假设，可用 `open_web_url` 自行配置。回环与非回环行为如下：

- **回环地址**（`127.0.0.1` / `localhost` / `::1`）：打开浏览器前先确保 kimi web 服务可用，且端口占用方必须是「自己人」。以 URL 配置端口（默认 58627，`127.0.0.1`）为起点最多尝试 10 个候选端口（`basePort`..`basePort+9`）：TCP 探测 `host:port` 空闲则以可见终端窗口拉起 `kimi web --no-open --port <候选端口>`（`terminal=wt` 时 `wt.exe new-tab --reloadEnvironment` 显式新建标签并刷新环境，避免 Windows Terminal 缓存 PATH 找不到新装的 kimi；`terminal=wsl` 分支改为在 WSL 内执行 `wsl.exe ... -- kimi web ...`，保证与 CLI 处于同一 WSL 环境；`wt.exe` 缺失回退 `cmd /c start`），每 250 毫秒轮询端口就绪，最长等待约 10 秒，就绪后打开该候选端口的 URL（端口重写为实际选用端口，路径与 query 保留）；端口被占用并不直接视为「服务已在运行」——token 读取成功时先做归属验证（见下条），确认为异构占用则顺延下一候选端口重新探测与拉起；10 个候选端口全部被异构占用则返回失败并提示（错误信息不含 token）。该终端窗口即服务生命周期，用户关窗即停止服务，下次点击会话时探测不到端口会自动重新拉起。拉起失败或超时记错误日志并向渲染进程补发失败气泡。
- **token 免密与端口归属验证**：kimi web 的 web UI 默认要求 bearer token，官方机制是 URL 的 `#token=` 片段自动认证。仅对回环 URL，守护进程打开浏览器前读取 token 文件 `%KIMI_CODE_HOME%\server.token`（未设 `KIMI_CODE_HOME` 时回退 `~/.kimi-code/server.token`）。读到非空 token 且 TCP 探测发现端口被占用时，用该 token 向同地址发一次 `GET /api/v1/sessions` 验证请求（`Authorization: Bearer`，超时约 1.5 秒）：收到响应且状态码非 401 → 判定为同一 home 的 kimi web 实例，给 URL 拼上 `#token=<token>`（URL 已有 `#` 片段先去掉再拼）直接开浏览器；返回 401 → 判定为异构环境占用（典型：WSL 里运行的 kimi web，其 `server.token` 与 Windows 侧不同，实测会停在「Server token required」），顺延下一候选端口；验证请求出错或超时 → 同样顺延。文件缺失、内容空白或读取失败（token 为 null）则完全保持旧行为：探测原端口，被占直接开裸 URL，不做验证也不顺延（用户可从拉起服务的终端窗口横幅复制 token 手动填入）。
- **非回环 URL**：维持现状直接打开浏览器，不验证、不自动拉起、也绝不拼 token（防止 token 泄漏到远端，也无法代管远端服务）。

安全红线：任何日志、错误信息都不得输出带 token 的完整 URL；token 验证请求本身同样不落任何日志。

会话目录来自 `%KIMI_CODE_HOME%\session_index.jsonl` 以及各会话目录下的 `state.json`（见 [`bridge/src/daemon/session-catalog.ts`](../bridge/src/daemon/session-catalog.ts)）。守护进程过滤非法或归档记录、按更新时间去重排序，并按工作目录折叠历史记录（同一工程只保留最近一条，避免堆积重复条目；活跃会话不折叠以保证并行会话可分别打开），最多向渲染进程发送 50 条记录。单行或单个 `state.json` 损坏时跳过该记录，不让目录损坏阻断守护进程握手。

## 数据与配置

守护进程读取 `%KIMI_CODE_HOME%\kpet\config.json`（见 [`bridge/src/daemon/config.ts`](../bridge/src/daemon/config.ts)）。未设置 `KIMI_CODE_HOME` 时，路径回退到 `%USERPROFILE%\.kimi-code\kpet\config.json`。文件不存在或 JSON 非法时整体使用默认值；字段缺失或类型非法时逐项使用默认值并给出告警。默认配置（全字段）如下：

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

各字段语义与取值：

- `renderer_path`：渲染进程路径，支持 `%VAR%` / `$VAR` / `${VAR}` 环境变量展开；缺省按 `KIMI_PLUGIN_ROOT` 取 `renderer/Pet.exe`（开发期回退 cwd 下的 `renderer/`）。
- `terminal`：终端唤起方式，取值 `wt`（Windows 终端，默认）、`cmd`（传统控制台）、`wsl`（WSL 发行版终端，跨平台方案形态一）。
- `wsl_distro`：`terminal=wsl` 时使用的 WSL 发行版名，空串表示 wsl.exe 默认发行版。
- `open_target`：点击会话后的打开目标，`cli`（唤起 kimi 终端，默认）或 `web`（打开浏览器）。
- `open_web_url`：web 目标下的 URL 模板，默认 `http://127.0.0.1:58627/`，支持 `{session_id}` 占位符。
- `ui_theme`：设置 WebUI 主题，取值 `dark-glass`（默认）、`light-minimal`、`cute-pet`。
- `fps_monitor`：是否显示 FPS 监控浮层，默认关闭。
- `session.staleMinutes` / `session.cleanupMinutes`：卡死兜底与清理时长（分钟），兼容「扁平带点键」与「嵌套对象」两种写法；`cleanupMinutes` 必须大于 `staleMinutes`，未配置时兜底为 `staleMinutes + 1`。
- 其余字段：心跳间隔/超时、重启窗口与次数上限、宿主退出倒计时与是否随宿主退出、日志级别（debug/info/warn/error）。

设置面板可改动的配置经 `update_config` 下发，仅 `open_target` / `ui_theme` / `fps_monitor` 三个字段（`config_snapshot` 额外携带只读的 `open_web_url` 供页面展示）。运行时合法字段单独校验：合法才覆盖，非法告警并保持当前值（不退回默认，避免误操作重置用户选择），随后只把实际应用的字段子集写回配置文件（保留文件中原有的未知字段）。

运行时文件位置如下：

| 内容 | 路径 |
|---|---|
| 守护进程日志 | `%KIMI_CODE_HOME%\kpet\logs\kpetd.log` |
| 宠物窗口状态 | `%APPDATA%\KPet\pet-state.json` |
| 事件暂存 | `%TEMP%\kpet-events\` |
| 用户关闭标记 | `%TEMP%\kpet\pet.disabled` |
| 拉起/恢复交接标记 | `%TEMP%\kpet\daemon.lock`、`pet.recovering` 等 |

这些文件可能包含工作目录、会话信息或命令摘要。提交问题或测试样本前应先检查并脱敏。

## 技术栈

| 层 | 技术 |
|---|---|
| 宿主集成 | Kimi Code CLI 插件、事件钩子、标准输入 JSON |
| 转发器与守护进程 | TypeScript 5、Node.js 22、ESM、Node.js 标准库 |
| 通信 | Windows 命名管道、UTF-8 JSON、换行分帧、协议版本 1 |
| 渲染 | Unreal Engine 5.8、C++、Scene Capture、RHI、RenderCore、GPU Readback |
| 桌面呈现 | Win32、DIB、`UpdateLayeredWindow`、逐像素命中 |
| 角色动画 | Skeletal Mesh、Animation Blueprint、Control Rig |
| 界面 | Slate、`SWindow`、SWebBrowser（CEF）、MovieScene |
| 测试 | Node.js Test Runner、UE Automation Test、PowerShell 窗口验证 |

## 源码结构

```text
KPet/
├─ bridge/                   转发器、守护进程与协议（TypeScript，Node 22 ESM）
│  ├─ packaging/kpet/        Kimi Code 插件集合（清单 + 部署脚本 + 产物）
│  ├─ src/bridge/            短生命周期事件转发器
│  │  ├─ main.ts             转发器核心：stdin → host_event → 管道，200ms 超时 + 暂存兜底
│  │  ├─ daemon.ts           拉起锁 / 恢复交接 / 抑制标记与 detached recovery worker
│  │  ├─ pipe.ts             node:net 管道探测与写入
│  │  ├─ staging.ts          事件暂存目录读写
│  │  ├─ stop.ts             --stop 模式：写抑制标记触发优雅退出，等待事件管道释放
│  │  └─ user.ts             用户名清洗与两条管道名推导
│  ├─ src/daemon/            守护进程、状态机与进程管理
│  │  ├─ app.ts              组装：两条管道、状态机、渲染进程守护、终端唤起、暂存回收
│  │  ├─ config.ts           配置加载 / 合并 / 写回
│  │  ├─ control.ts          控制管道会话（hello 握手、消息分发、协议错误）
│  │  ├─ logger.ts / main.ts / petstate.ts / pipes.ts / staging.ts / wsl-path.ts
│  │  ├─ renderer.ts         渲染进程监督：指数退避重启与窗口内限流
│  │  ├─ session-catalog.ts  会话目录读取与快照合并
│  │  ├─ state.ts            宠物状态机：事件映射、200ms 节流、卡死兜底
│  │  └─ terminal.ts         终端/浏览器唤起（wt/cmd/wsl + kimi web 拉起与 token）
│  ├─ src/launcher/main.ts   单 exe 模式分发：--relay / --daemon / --stop / --kpet-recover
│  ├─ src/protocol/          共享协议：envelope、types.ts（消息表 / 信封 / 常量）
│  └─ test/                  Bridge 单元与 Windows 命名管道集成测试
├─ Pet/
│  ├─ Content/               角色、动画、关卡资产
│  │  └─ UI/Web/             session-panel.html、settings.html（非 UFS 打包的 WebUI）
│  ├─ Source/Pet/            UE C++ Runtime 模块（Public/Private）
│  │  ├─ Animation/  Communication/  FunctionLibrary/  Game/  UI/
│  │  ├─ Platform/           分层窗口、低层键盘钩子、逐像素字体（PetLayeredWindow / PetPixelFont）
│  │  ├─ Player/             捕获 Pawn、相机、运动组件
│  │  └─ 各模块下 Tests/     UE Automation Test（面板堆栈、像素字体、配置协议、窗口宿主等）
│  └─ Pet.uproject           UE 5.8 工程入口
├─ docs/                     本文档与跨平台兼容方案
├─ tools/                    开发与打包工具
│  ├─ package.ts             整包打包唯一入口（bridge 单 exe + UE Shipping 组装 + zip）
│  ├─ mock-daemon.ts         控制管道上的模拟守护进程（联调渲染进程）
│  ├─ verify-pet-operations.ps1 / window-watch.ps1   窗口行为验证与调试
│  └─ blender-direct.ts      直连 Blender MCP socket 的工具脚本
├─ dcc/                      Blender/FBX 源资产（KPet.blend、KPetComputer.blend/.fbx、贴图）
└─ dist-plugin/              打包输出（kpet/ 插件目录与 kpet.zip）
```

## 开发环境

- Windows 11。
- Unreal Engine 5.8。
- Visual Studio 2022，以及 UE C++ 开发组件。
- Node.js 22 或更高版本。
- Bun（仅 `build:exe` 编译单 exe 需要）。
- Kimi Code CLI。
- 可选的 Windows 终端（`terminal=wt` 首选，缺失时回退 cmd）。

## 构建与测试

### Bridge

```powershell
cd bridge
npm ci
npm run build
npm test
```

`npm run build` 将转发器、守护进程和协议编译到 `bridge/dist/`（`tsc -p tsconfig.json`）。`npm test` 会先 `build` 再 `build:test`（编译到 `dist-test/`），随后用 Node.js 内置测试运行器执行 `dist-test/test/*.test.js`。

当前 **240 项测试全部通过**（0 失败）。覆盖协议校验、配置加载与合并、状态机与事件映射、200ms 节流、事件暂存与恢复、渲染进程监管（退避重启/窗口限流）、终端唤起（wt/cmd/wsl 与 web 拉起/token 拼接）、WSL 路径互转、会话目录合并、`--stop`、Windows 命名管道集成等。

单 exe 的 `build:exe` 目标（产物 `bin/kpetd.exe`，见 `bridge/package.json`）：

```powershell
cd bridge
npm run build
bun build --compile --windows-hide-console dist/launcher/main.js --outfile bin/kpetd.exe
```

### UE 工程

使用 Unreal Engine 5.8 打开 `Pet/Pet.uproject` 并编译 `PetEditor`，也可以从已配置的开发者 PowerShell 中执行：

```powershell
& "C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" PetEditor Win64 Development "D:\path\to\KPet\Pet\Pet.uproject" -WaitMutex
```

只调试渲染进程时，可以先运行模拟守护进程：

```powershell
node --experimental-strip-types tools/mock-daemon.ts
```

模拟守护进程会下发会话数据，并每 10 秒交替发送 `Working` 与 `Idle` 及逐会话工作状态，便于独立检查面板、状态切换和断线重连。

自动化验证入口包括：

- `bridge/test/`：Node.js 单元测试与 Windows 命名管道集成测试。
- `Pet/Source/Pet/Private/**/Tests/`：面板堆栈、像素字体、配置协议、输入、窗口宿主等 UE Automation Test。
- `tools/verify-pet-operations.ps1`：编辑器或打包版本的 Windows 窗口行为验证。
- `tools/window-watch.ps1`：观察 Pet.exe 进程树的窗口可见性与矩形变化（调试辅助）。

## 插件目录

可安装插件的目录结构为（见 [`bridge/packaging/kpet/`](../bridge/packaging/kpet/)）：

```text
kpet/
├─ kimi.plugin.json         # Windows 宿主清单（command 直启 .\bin\kpetd.exe --relay）
├─ kimi.plugin.wsl.json     # WSL 宿主清单（command 走 ./bin/kpet-relay.sh --relay）
├─ deploy.sh                # 跨平台部署脚本（Windows 经 Git Bash 提示用 deploy.ps1；WSL 分支就位清单）
├─ deploy.ps1               # Windows 原生部署脚本
├─ bin/
│  ├─ kpetd.exe             # 单 exe 双模式（转发器/守护进程/--stop/恢复 worker）
│  └─ kpet-relay.sh         # WSL 内经 interop 启动 kpetd.exe 的 POSIX sh 包装
└─ renderer/
   └─ Pet.exe 及 UE 打包依赖
```

部署时先在插件根目录运行随包的部署脚本，脚本会自动识别当前平台并自检包完整性（`bin/kpetd.exe`、`renderer/Pet.exe`、`bin/kpet-relay.sh` 必须存在）：

- **Windows**（`deploy.ps1`）：校验 `kimi.plugin.json` 为 Windows 版清单；若该目录曾在 WSL 跑过 `deploy.sh`（清单含 `kpet-relay.sh`），则从备份 `kimi.plugin.json.bak` 恢复 Windows 版并二次校验（防坏备份“假恢复”）。
- **WSL**（`deploy.sh`，形态一）：把随包分发的 `kimi.plugin.wsl.json` 覆盖为插件根下的 `kimi.plugin.json`（覆盖前把原 Windows 版备份为 `kimi.plugin.json.bak`，重复运行幂等），并自愈 `bin/kpet-relay.sh` 的执行位（zip 解压会丢 POSIX 权限位）；其 hook 命令走 `bin/kpet-relay.sh`，经 WSL interop 直启 Windows 侧的 `bin/kpetd.exe`。
- **macOS / 普通 Linux**：暂不支持，脚本给出明确提示（无其他平台构建产物）。

两种入口都会在就位清单后调用 `kpetd.exe --stop`（WSL 侧经 `kpet-relay.sh --stop`）先停旧版守护进程——非致命，失败仅告警；`--stop` 成功后还会按可执行文件路径前缀（受管目录 `plugins/managed/kpet/renderer`）清理残留渲染进程（`Pet.exe`/`Pet-Win64-Shipping.exe`/`EpicWebHelper.exe`），覆盖「启动器被杀但 UE 游戏本体孤儿存活」的场景——清理同样非致命，`--stop` 失败时不执行（旧守护进程仍可能重新拉起渲染端）；随后打印安装指引：

```text
Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1
WSL:      sh deploy.sh        # 或 ./deploy.sh
```

然后在 Kimi Code 中安装包含 `kimi.plugin.json` 的目录：

```text
/plugins install D:\Apps\kpet
/reload
```

插件会随第一条合法会话事件按需启动后台组件，无需手动运行三个可执行文件。整包由仓库根的 `tools/package.ts` 产出（`npm run package`，UE Shipping + bridge 单 exe 组装，可选 `--zip`）。

## 平台边界

完整项目面向 Windows 11。宠物本体、控制通信和命名管道包含 Windows 专用实现；会话面板依赖 WebBrowser（CEF，当前打包仅舞台化 Win64，UMG 路径已移除），其 Slate 窗口宿主相对跨平台，但完整程序仍不具备其他平台的运行基线。WSL 形态一（CLI 在 WSL、守护进程/渲染端仍在 Windows）由 `kimi.plugin.wsl.json` + `deploy.sh` + `bin/kpet-relay.sh` + `wsl-path.ts` 支持，详尽的调研与落地路径见 [跨平台兼容方案（WSL 与 macOS）](跨平台兼容方案-WSL与Mac.md)；macOS 与普通 Linux 暂不支持。

命名管道使用进程默认安全描述符，协议本身没有额外认证令牌。部署环境应把 KPet 视为同一用户会话内的本地应用，不应将管道暴露为跨用户或远程接口。
