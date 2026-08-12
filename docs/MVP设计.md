# KimiPet MVP 详细设计

> 本文档基于 `docs/KimiPet-MVP原始需求.md`，经技术调研（Kimi Code 官方文档、Microsoft Learn、Epic 官方论坛/文档，2026-07）整理而成。
> 文中标注「待验证」的条目为调研未能核实的点，均已给出备选方案，不阻塞开发。
> 术语约定：正文一律使用中文名（宿主、转发器、守护进程、渲染进程……），首次出现的引擎/系统 API 以「中文说明 + 英文原名」形式给出，后文只用中文名。完整术语表见 §1.3。

## 1. 概述

### 1.1 需求回顾

- 平台：Win11；宿主：Kimi Code CLI（终端界面）；引擎：UE5.8（已核实真实存在，2026-07-21 发布）。
- 架构：Kimi Code 插件 + UE5 发布版独立进程的双层架构。插件监听宿主消息，独立进程渲染宠物。
- 宠物：3D 打印风格蓝色球，Idle / Working 两状态；所有状态点击打开 Kimi Code 终端。
  - Idle：眨眼、东张西望；可拖拽移动位置、旋转。
  - Working：敲电脑；鼠标滑过电脑屏幕显示正在运行的任务；任务完成弹消息气泡。

### 1.2 对原始需求的优化点

1. **架构细化为三进程**：调研确认 Kimi Code 插件没有常驻进程能力（它的事件钩子是"每发生一个事件拉起一个短生命周期进程"），因此需要增加一个常驻守护进程，承接事件汇总与渲染进程守护（理由见 §2.2）。
2. **状态判定权收敛在守护进程**：渲染进程只执行 `pet_state` 指令、不做状态推导，避免两端状态不一致。
3. **交互手势补全**：原始需求未定义"点击"与"拖拽"的冲突消解、旋转手势的具体形式、气泡排队策略，本文档给出完整手势模型（§6.4–§6.7）。
4. **会话面板改用纯 Slate 与 UMG**：会话面板不依赖逐像素透明或项目层原生窗口补丁。Bridge 使用 `NOSPLASH` 与最小默认窗口参数启动 UE，项目模块通过 Slate `OnPreTick` 在首个 Slate 绘制前隐藏默认游戏窗口；会话内容由 UMG 承载在 `Notification` 类型的 Popup `SWindow` 中。宠物本体的现有透明分层窗口仍由独立呈现层负责，本次迁移不把它与会话面板混为一谈。
5. **明确 MVP 裁剪线**：宿主 16 个事件钩子只订阅 12 个里用到的；多任务悬浮卡最多 5 条；不做挤压拉伸形变、不做右键菜单。

### 1.3 术语表

| 术语 | 含义 |
|---|---|
| 宿主 | Kimi Code CLI（`kimi` 命令的终端进程）。它不与宠物保持长连接，只在事件发生时拉起一次转发器 |
| 事件钩子（Hook） | Kimi Code 的事件机制：宿主在特定事件（会话开始、工具调用等）发生时，执行插件清单里声明的命令 |
| 转发器 | `kimi-pet-bridge.exe`，随插件分发的无窗口小程序。宿主每发生一个事件就拉起它一次，它读取事件内容、转发给守护进程后立即退出 |
| 守护进程 | `kimi-petd.exe`，常驻后台的中转进程：汇总各会话事件、推导宠物状态、守护渲染进程（崩溃自动重启）、负责打开终端 |
| 渲染进程 | `Pet.exe`，UE5 独立程序，负责把宠物画到桌面上 |
| 事件管道 | 转发器 → 守护进程 的单向命名管道，全名 `\\.\pipe\KimiPet.H2D.<用户名>` |
| 控制管道 | 守护进程 ↔ 渲染进程 的双向命名管道，全名 `\\.\pipe\KimiPet.PET.<用户名>` |
| 命名管道 | Windows 自带的进程间通信机制，本机两个进程像读写文件一样互发消息，无需网络端口 |
| 逐像素透明 | 窗口上每个像素有独立透明度：宠物本体不透明、其余区域完全透明且鼠标可穿透 |
| 分层窗口 | 宠物本体现有呈现层使用的 Windows 窗口实现（`WS_EX_LAYERED`）；本次会话面板不使用该实现，也不新增 Win32 窗口后端 |
| 技术验证 | 正式开发前用最小工程验证关键技术点（原称 Spike），不通过则不进入下一阶段 |

## 2. 总体架构

### 2.1 拓扑

```
kimi 终端 ──(每个事件拉起一次)──> 转发器 ──写入──> 【事件管道】 ──> 守护进程
                                                                      │ 转发 / 缓存 / 状态推导
                                                        【控制管道 · 双向】 <──> 渲染进程 (UE5)
守护进程 ──(收到"打开终端"消息)──> 新开终端窗口执行 kimi --session <会话id>
```

### 2.2 关键决策与取舍

**D1：引入常驻守护进程，而非让转发器直连渲染进程。**
被否决方案：转发器直接写渲染进程的管道，事件汇总逻辑放渲染进程。否决理由：

- UE 渲染进程冷启动需数秒，启动期间直连方案会丢失全部事件；守护进程可缓存事件并在渲染进程握手后补发。
- 渲染进程崩溃期间事件持续到达，守护进程负责重启并回放状态快照，宠物能恢复到正确状态。
- "点击打开终端"需要会话上下文（会话 id、最近会话判定），守护进程天然持有，渲染进程保持职责单一。
- 代价仅是多维护一个轻量进程（TypeScript + Node 22 实现，常驻内存预期 < 150MB），收益远大于成本。

**D2：进程间通信主选 Windows 命名管道。**
命名管道的消息模式天然保留消息边界（一次写入 = 一条完整消息，上限定为 64KB）；管道名在系统内核命名空间内，无端口冲突、不触发防火墙；管道对象随进程退出自动销毁，崩溃后无残留。回退方案为本机回环 TCP（只监听 `127.0.0.1`，端口被占则顺延重试并写入端口约定文件，加令牌握手），消息协议不变。WebSocket（协议栈重、没有浏览器端需求）与共享内存（本场景是低频小消息，用不上）已排除。

**D3：守护进程是状态判定的唯一权威。**
守护进程按会话 id 汇总事件、推导 Idle/Working，向渲染进程下发 `pet_state`；渲染进程只执行，并只上报原始输入（点击/悬停/心跳）。连接断开时渲染进程冻结当前状态，不自行推导。

**D4：转发器无状态、失败放行。**
转发器不解析事件字段语义，原样透传事件 JSON；任何失败（管道不通、JSON 非法）都以退出码 0 静默结束，绝不阻塞宿主主流程（宿主对事件钩子的约定就是失败放行）。

### 2.3 进程职责一览

| 进程 | 生命周期 | 职责 |
|---|---|---|
| 转发器 | 每事件拉起一次，毫秒级退出 | 读取事件 → 包装成协议消息 → 写事件管道；管道不存在时以分离方式拉起守护进程（不等待其就绪） |
| 守护进程 | 随首个宿主事件启动，宿主全部退出后倒计时退出 | 建两条管道；事件汇总与状态推导；任务列表维护；事件缓存与补发；渲染进程启动/崩溃重启；收到 `open_tui` 打开终端；收尾退出 |
| 渲染进程 | 由守护进程拉起，随其退出 | 宠物本体呈现与动画；Slate 启动窗口守卫；会话数据接入 Pawn；UMG 面板内容和交互；心跳上报 |
| 会话面板 | 随渲染进程创建，随 Pawn/Host 销毁 | Pawn 直接把会话快照和增量状态写入 UMG；`Notification` Popup `SWindow` 只由 Window Host 管理窗口生命周期、显隐、锚点和窗口级动画 |

## 3. 宿主集成（插件 / 事件钩子层）

### 3.1 调研结论（Kimi Code 官方文档，已核实）

- **插件注册**：插件是一个含清单文件的目录（或 zip），清单文件为 `<插件根目录>/kimi.plugin.json`。用 `/plugins install <路径或地址>` 安装到 `$KIMI_CODE_HOME/plugins/managed/<id>/`（Windows 默认 `C:\Users\<用户名>\.kimi-code\plugins\managed\<id>\`），`/reload` 或新会话生效。按用户安装、对所有项目生效，暂无项目级安装。
- **无常驻进程能力**：插件能执行代码的载体只有两类——清单文件 `hooks` 字段声明的事件钩子（每次事件拉起一个短生命周期子进程），以及 `mcpServers`（通过标准输入输出通信，只在模型主动调用工具时才有流量）。后者收不到 `SessionStart`/`Stop` 等生命周期事件，已否决——这是引入守护进程的直接原因。
- **事件全集（16 个）**：`UserPromptSubmit`、`PreToolUse`、`Stop`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionResult`、`SessionStart`、`SessionEnd`、`SubagentStart`、`SubagentStop`、`StopFailure`、`Interrupt`、`PreCompact`、`PostCompact`、`Notification`。仅 `PreToolUse`/`Stop`/`UserPromptSubmit` 支持阻塞宿主主流程，其余均为只读观察事件——宠物全部按观察用法接入，绝不返回阻塞码。
- **事件数据格式**：事件 JSON 经标准输入传给钩子进程；基础字段 `hook_event_name`、`session_id`、`cwd`（全小写下划线命名）；已确认 `PreToolUse` 含 `tool_input.command`、`Interrupt` 含 `reason`。**其余事件的完整字段清单官方未逐项列出（待验证）**，因此转发器采用原样透传策略，不依赖任何具体字段。
- **运行环境**：钩子命令为任意 shell 命令，语言不限；工作目录 = 插件根目录；注入环境变量 `KIMI_CODE_HOME`、`KIMI_PLUGIN_ROOT`；超时 1–600 秒可配（默认 30 秒）；失败/超时默认放行。
- **Windows 闪窗**：宿主侧已修复自身拉起钩子时的控制台闪窗（changelog 0.23.2），但转发器为 Node 控制台程序仍可能闪窗——因此依赖宿主侧钩子不闪窗的修复，实际表现实测验证。

### 3.2 插件目录与清单文件

```text
kimi-pet/
  kimi.plugin.json          # 插件清单
  bin/
    kimi-pet-bridge.exe     # 转发器（TypeScript + Node 22 实现，bun build --compile 单 exe，约 50–90MB）
    kimi-petd.exe           # 守护进程（同实现方案）
  renderer/
    Pet.exe                 # UE5 发布版渲染进程（及其数据包等）
```

`kimi.plugin.json`（订阅 12 个事件钩子；不订阅的见下文说明）：

```json
{
  "name": "kimi-pet",
  "version": "0.1.0",
  "description": "Desktop pet bridge for Kimi Code CLI",
  "hooks": [
    { "event": "SessionStart",      "matcher": "startup|resume",   "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "SessionEnd",        "matcher": "exit",             "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "UserPromptSubmit",                               "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "PreToolUse",                                     "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "PostToolUse",                                    "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "PostToolUseFailure",                             "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "Stop",                                           "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "StopFailure",                                    "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "Interrupt",                                      "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "SubagentStart",                                  "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "SubagentStop",                                   "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 },
    { "event": "Notification",      "matcher": "task\\.completed", "command": ".\\bin\\kimi-pet-bridge.exe", "timeout": 5 }
  ]
}
```

不订阅：`PermissionRequest`/`PermissionResult`（留到二期）、`PreCompact`/`PostCompact`（对宠物状态机没有增量信息）。

### 3.3 转发器伪代码

```text
main():
    payload = read_all(stdin)                       # 从标准输入读取宿主事件 JSON
    if not valid_json(payload): exit(0)             # 永不阻塞宿主
    msg = wrap(payload)                             # 包上协议信封（版本/类型/时间戳，见 §4.2）

    if not pipe_exists("事件管道"):
        spawn_detached("<KIMI_PLUGIN_ROOT>/bin/kimi-petd.exe")   # 分离方式拉起守护进程，立即返回
        # 守护进程启动期间的事件按 §3.4 的兜底策略处理

    ok = try_connect_and_write("事件管道", msg, timeout=200ms)
    if not ok:
        write_to_local_staging("%TEMP%/kimi-pet-events/", msg)   # 写本地暂存文件兜底，守护进程启动后回收
    exit(0)                                         # 无论成败都以 0 退出（失败放行）
```

### 3.4 宿主事件 → 宠物语义映射表

守护进程按会话 id 维护活跃会话集合与任务表，汇总规则：**任一会话在忙 → Working；全部空闲 → Idle**。

| 宿主事件 | 守护进程动作 | 宠物语义 |
|---|---|---|
| `SessionStart` | 记录活跃会话；补发状态快照 | 宠物上线，进入 Idle |
| `UserPromptSubmit` | 该会话标记为忙 → `pet_state: Working`（原因=`user_prompt`） | Idle → Working，比等 `PreToolUse` 更早 |
| `PreToolUse` | 生成任务 id，发 `task_start`（工具名）；保持 Working | 悬浮卡新增一行 |
| `PostToolUse` / `PostToolUseFailure` | 发 `task_end`（成功/失败） | 悬浮卡移除一行；失败另发 `notify` |
| `SubagentStart` / `SubagentStop` | 视同 `task_start` / `task_end`（工具名=子代理名） | 同上 |
| `Stop` | 该会话转闲；无忙的会话 → `pet_state: Idle` | Working → Idle |
| `StopFailure` | 同上转 Idle，另发 `notify(level=error)` | 气泡"任务出错" |
| `Interrupt` | 该会话转闲，不弹完成气泡 | 回 Idle |
| `Notification`（`task.completed`） | `notify(level=success)`，不改主状态 | "后台任务完成"气泡 |
| `SessionEnd` | 移除会话；无活跃会话 → `pet_state: Idle` 并启动退出倒计时 | 宠物收尾 |

**字段取值防御**：除 `hook_event_name`/`session_id`/`cwd` 外不依赖任何宿主字段；任务标题取工具名/命令文本，取不到就降级为通用文案"正在工作…"。事件原始 JSON 整体放入 `payload._raw` 透传，后续启用新字段零成本。

**状态卡死兜底**：任一忙会话超过 10 分钟（可配 `session.staleMinutes`）没有任何事件，守护进程强制将其转闲但保留活跃会话——防止丢失的 `Stop` 导致宠物永远 Working。只有超过更长的 `session.cleanupMinutes`（默认 60 分钟）才清理异常孤儿会话。

**高频事件节流**：`PreToolUse`/`PostToolUse` 高频到达时，守护进程在 200ms 窗口内合并同会话的连续任务事件再下发，避免渲染进程 UI 抖动。

## 4. 进程间通信协议

### 4.1 管道与单实例

- 事件管道：`\\.\pipe\KimiPet.H2D.<用户名>`（转发器 → 守护进程，守护进程为服务端）。
- 控制管道：`\\.\pipe\KimiPet.PET.<用户名>`（守护进程 ↔ 渲染进程双向，守护进程为服务端，渲染进程主动连入）。
- `<用户名>` 取当前 Windows 用户名并过滤非法字符（管道名不允许 `\`），用于多用户同机隔离。
- 单实例：守护进程、渲染进程各用一个系统级命名互斥体（`Local\KimiPet.daemon.<用户名>` / `Local\KimiPet.renderer.<用户名>`，创建时发现已存在即退出），保证同用户下只有一个实例。
- **安全**：守护进程创建管道时必须显式设置"仅当前用户"的访问控制（默认权限允许同机所有用户读取），防止本机其他进程伪造事件或注入 `open_tui`。
- UE 侧没有现成的命名管道封装（引擎自带的管道接口只是匿名管道，用于读子进程输出），需自行封装 Win32 的 `CreateNamedPipe`/`CreateFile`：收发放在工作线程，再转交游戏线程处理。JSON 用引擎运行时自带的 `Json`/`JsonUtilities` 模块（发布版可用）。

### 4.2 消息信封

- 编码 UTF-8；一条管道消息 = 一个完整 JSON 对象（消息模式天然分帧，无需分隔符或长度前缀；单条上限 64KB）。

```json
{
  "v": 1,
  "type": "task_start",
  "id": "9f2c1a-…",
  "ts": "2026-07-30T10:00:00.123Z",
  "session_id": "session_abc",
  "payload": {}
}
```

- `v`：协议主版本，MVP 固定 1；`type`：消息类型（收到未知类型必须忽略并记日志，保证向前兼容）；`id`：消息唯一标识（可选，用于去重和日志关联）；`ts`：ISO 8601 UTC 时间戳；`session_id`：关联的宿主会话，与会话无关的消息为 `null`。

### 4.3 协议消息表

方向缩写：转→守 = 转发器→守护进程（事件管道）；守→渲 / 渲→守 = 守护进程↔渲染进程（控制管道）。

| type | 方向 | 触发时机 | payload 字段 | 说明 |
|---|---|---|---|---|
| `host_event` | 转→守 | 每次事件钩子触发 | `_raw`（宿主原始 JSON 整体透传） | 唯一入站类型，守护进程内部解析映射 |
| `hello` | 双向 | 连接建立后首条 | `protocol_version`, `role`, `pid`, `version`, `capabilities` | 握手与版本协商 |
| `session_start` | 守→渲 | SessionStart | `cwd`, `resume` | 新会话/恢复会话 |
| `session_end` | 守→渲 | SessionEnd | `reason` | 会话关闭 |
| `sessions_snapshot` | 守→渲 | 连接建立 / 渲染进程重启后 | `sessions`: [`{session_id,title,cwd,active,working,unread,updated_at}`] | CLI 历史与活跃会话目录；最多 50 条，按更新时间倒序 |
| `session_state` | 守→渲 | 会话开始工作、回复完成、打开会话、重连快照 | `working`, `unread` | 单个会话的工作动画与新回复气泡状态，信封 `session_id` 标识目标会话 |
| `pet_state` | 守→渲 | 守护进程状态推导 | `state`(`"Idle"`/`"Working"`), `reason` | 状态切换的唯一权威消息 |
| `task_start` | 守→渲 | PreToolUse / SubagentStart | `task_id`, `title`, `tool` | 悬浮卡列表项 |
| `task_end` | 守→渲 | PostToolUse(Failure) / SubagentStop | `task_id`, `status`(`"success"`/`"failure"`), `title`, `summary`（可空） | 触发完成气泡（合并策略见 §6.6） |
| `tasks_snapshot` | 守→渲 | 连接建立 / 渲染进程重启后 | `tasks`: [`{task_id,title,tool,started_at}`] | 全量状态恢复 |
| `notify` | 守→渲 | 任务完成/失败、Notification | `text`, `level`(`"info"`/`"success"`/`"error"`), `ttl_ms`（默认 5000）, `task_id`（可空） | 消息气泡 |
| `open_tui` | 渲→守 | 点击会话行 / 点击气泡 | `session_id`（可空=最近会话）, `source`(`"pet"`/`"bubble"`), `task_id`（可空） | 请求打开终端；打开会话后清除该会话未读状态 |
| `heartbeat` | 渲→守 | 每 3 秒 | `pid`, `uptime_s`, `state` | 保活心跳 |
| `pet_moved` | 渲→守 | 拖拽结束 | `x`, `y`, `monitor_id` | 位置持久化（由守护进程统一写配置，避免多头写文件） |
| `close_pet` | 渲→守 | ESC 加左键关闭 | `reason`（固定为 `"user"`） | 写入用户关闭抑制标记，停止重启并请求守护进程优雅退出 |
| `shutdown` | 守→渲 | 守护进程退出前 | `reason`(`"host_gone"`/`"user"`/`"error"`) | 通知渲染进程退出 |
| `protocol_error` | 双向 | 收到非法消息 | `description`, `raw_excerpt`（截断 256 字符） | 仅日志用途 |

### 4.4 版本兼容与错误处理

- 控制管道建连后双方互发 `hello` 交换协议版本与能力集；主版本不一致时守护进程按较低版本降级（丢弃高版本专有的消息类型）并记日志。
- 字段级只增不改：新增字段必须可选；解析端对缺失字段取默认值、对未知字段忽略。
- 非法 JSON / 缺信封字段：跳过该条、回 `protocol_error`、错误计数 +1，连续超阈值（10 条/分钟）记日志告警但不中断连接。
- 写管道失败：重试一次后丢弃并记日志；转发器任何情况下都以退出码 0 结束。

### 4.5 关键时序

1. **冷启动**：`kimi` 启动 → SessionStart 钩子 → 转发器拉起守护进程 → 守护进程建管道、拉起渲染进程、缓存事件 → 渲染进程连控制管道发 `hello` → 守护进程回 `hello` 并补发 `sessions_snapshot` + `session_start` + `session_state` + `pet_state:Idle` → 宠物出现。
2. **一轮工作**：用户提交 → `pet_state:Working`（宠物敲电脑）→ 每个工具调用产生 `task_start`/`task_end`（悬停可见任务列表）→ `Stop` → `pet_state:Idle`；期间完成事件触发 `notify` 气泡。
3. **点击回传**：点击宠物 → 弹出会话面板 → 点击会话行 → `open_tui` → 守护进程用 `wt.exe -d <cwd> cmd /k kimi --session <会话id>` 拉起终端（`wt.exe` 是 Windows 终端，Win11 预装，可用性待验证；备选 `cmd /c start`；会话 id 为空时用 `kimi --continue` 恢复最近会话）。
4. **渲染进程崩溃**：控制管道断开 → 守护进程按 1s/2s/4s/8s 指数退避重启（60 秒内最多 5 次，超限则停止重启并记日志，等下一个宿主事件再试一轮）→ 重连后回放状态快照（CLI 历史与活跃会话目录 + 当前 `pet_state` + 未完成任务列表）。
5. **守护进程崩溃**：渲染进程写管道失败 → 每 5 秒重连，期间宠物保持离线渲染；下一个宿主事件到达时转发器会重新拉起守护进程。
6. **宿主退出**：最后一个 `SessionEnd` → 倒计时 120 秒（`host_grace_seconds`）→ `shutdown` → 渲染进程退出 → 守护进程退出；倒计时内新开 `kimi` 则取消退出。
7. **用户关闭与恢复**：按住 ESC 左键单击宠物 → UE 写入 `%TEMP%\kimi-pet\pet.disabled` 并发送 `close_pet` → 守护进程停止渲染进程重启、发送 `shutdown(reason=user)`、释放管道并退出；抑制期非 `SessionStart` 事件直接丢弃。下一次合法 `SessionStart` 消费标记并恢复；若旧管道未及时释放，该事件先暂存，由独立恢复进程等待管道释放后拉起新守护进程，不依赖第二个宿主事件。

## 5. 渲染进程（UE5）启动窗口、会话窗口与性能

### 5.1 启动参数与默认窗口策略

Bridge 启动渲染进程时使用以下最小参数：

```text
-NOSPLASH
-windowed
-ResX=16
-ResY=16
```

`NOSPLASH` 用于取消 Windows 和 Mac 平台启动图，最小窗口尺寸用于降低默认游戏窗口异常可见时的影响。`-RenderOffScreen` 不得加入启动参数：该模式会让同一 `SlateApplication` 后续创建的 `SWindow` 没有真实平台窗口，无法作为会话面板方案。

默认游戏窗口不是会话面板。它只作为 UE 游戏视口和现有 SceneCapture 的运行载体，启动后由纯 Slate 启动守卫隐藏；宠物本体继续使用现有呈现层。本节不把默认窗口隐藏等同于创建会话面板。

### 5.2 Slate `OnPreTick` 启动窗口守卫

在 `FPetModule::StartupModule` 中实现短生命周期的启动守卫，且只使用公开 Slate 接口：

1. 确认当前不是 Editor，且 `FSlateApplication` 已初始化。
2. 记录模块加载时已经存在的顶层窗口。
3. 绑定 `FSlateApplication::OnPreTick`。
4. 在后续顶层窗口中识别新建的常规游戏窗口；必要时用 `GEngine->GameViewport->GetWindow()` 校准弱引用。
5. 如果目标窗口可见，调用 `SWindow::HideWindow()`。
6. 覆盖 `UGameEngine` 首次 Tick 期间的再次显示；第二次隐藏完成并确认引擎不会再次自动显示后，解绑委托。
7. `ShutdownModule` 无条件移除仍然有效的委托句柄。

识别和隐藏窗口不得依赖系统标题、原生窗口句柄或平台窗口 API。会话面板使用 `Notification` 与 Popup，不属于常规游戏窗口，不应被启动守卫误隐藏。

公开接口只能把默认窗口隐藏安排在首个 Slate 绘制前，不能从接口语义上保证系统合成器从未观察到极短的显示状态。因此必须通过 Windows 和 Mac 打包版本的启动录像进行人工检查；Editor 表现不能作为发行验收依据。

### 5.3 Notification Popup `SWindow` 承载 UMG

会话面板由 `FPetSessionWindowHost` 在游戏线程创建一个跨平台 Slate 窗口，窗口内容是 `UPetSessionPanelWidget::TakeWidget()`：

```cpp
const FVector2f PanelDesignSize(360.0f, 234.0f);

SAssignNew(SessionWindow, SWindow)
    .Type(EWindowType::Notification)
    .Title(FText::FromString(TEXT("KimiPet 会话")))
    .IsPopupWindow(true)
    .AutoCenter(EAutoCenter::None)
    .IsTopmostWindow(true)
    .UseOSWindowBorder(false)
    .CreateTitleBar(false)
    .HasCloseButton(false)
    .SupportsMinimize(false)
    .SupportsMaximize(false)
    .SupportsTransparency(EWindowTransparency::PerWindow)
    .InitialOpacity(0.0f)
    .SizingRule(ESizingRule::FixedSize)
    .FocusWhenFirstShown(false)
    .ActivationPolicy(EWindowActivationPolicy::Never)
    .AdjustInitialSizeAndPositionForDPIScale(true)
    .ClientSize(PanelDesignSize);

SessionWindow->SetContent(SessionPanelWidget->TakeWidget());
FSlateApplication::Get().AddWindow(SessionWindow.ToSharedRef(), false);
```

创建规则：先设置内容和数据委托，再以 `AddWindow(..., false)` 加入；不调用 `GetNativeWindow`、`GetOSWindowHandle`，不补 Windows 或 Mac 原生样式，也不把会话窗口作为宠物本体窗口的子窗口。

窗口必须同时使用 `Notification`、Popup、置顶和 `ActivationPolicy::Never`。自动打开、更新、移动面板时不抢当前前台应用焦点；用户主动点击面板时允许 KimiPet 被系统激活。窗口外形和命中区域按矩形验收，UMG 只在矩形内部绘制圆角卡片，不承诺透明圆角之外的鼠标穿透。

### 5.4 Pawn、UMG 与 Window Host 的职责边界

会话数据不经过 Window Host，数据链路固定为：

```text
Bridge 回调
  → APetCapturePawn
  → UPetSessionPanelWidget 的公开数据接口
  → UPetSessionItem / UListView / UPetSessionRowWidget
  → OnSessionSelected 回到 APetCapturePawn
  → FPetControlClient::SendOpenTui
```

`APetCapturePawn` 持有 Widget，并负责接收 `sessions_snapshot`、`session_start`、`session_end`、`session_state`，直接调用 `ApplySnapshot`、`AddOrUpdateSession`、`RemoveSession`、`SetSessionActive` 和 `UpdateSessionState` 等接口。Widget 负责列表复用、空状态、行状态与内容动画；行控件只负责展示和发出选择事件。

`FPetSessionWindowHost` 只允许承担窗口级职责：`Create`、`Destroy`、`Toggle`、`Close`、`TickWindowAnimation`、`UpdateAnchor`、`IsVisible`。它不保存会话数据，不解析 Bridge 消息，不创建视图模型，不提供逐条更新方法，也不重新包装 `OnSessionSelected`。

### 5.5 宠物本体呈现边界与平台边界

现有 `PetLayeredWindow` 继续负责宠物本体的透明呈现；本次只迁移会话面板，不把宠物本体的呈现层改写成第二套会话窗口，也不把旧 GDI 会话面板作为运行时后端。会话面板本身不直接调用 Win32、AppKit 或其他原生 GUI 接口。

该边界不等于整个项目已经完成 Mac 打包：当前宠物本体、控制通信和部分 Pawn 代码仍可能包含 Windows 专用实现。Windows 与 Mac 的会话面板行为必须分别在人工打包版本中验收；Mac 主工程编译、签名、公证和分发属于独立前置工作，不能用 Windows 或 Editor 结果替代。

### 5.6 鼠标命中与交互归属

会话窗口输入由 Slate 正常路由，UMG 负责行按钮和内容控件。宠物本体的拖拽、旋转、缩放以及透明区域输入仍由现有宠物呈现层负责；会话窗口不实现逐像素命中，也不通过窗口区域或原生消息补丁实现圆角穿透。输入优先级和手势消解见 §6.4、§6.5 和 §6.8。

### 5.7 帧率与性能预算

| 状态 | 目标帧率 | 手段 |
|---|---|---|
| Idle | 12–15 FPS | 引擎帧率上限设为 15；宿主 10 分钟无消息时完全停止世界渲染（画面由分层窗口保持最后一帧） |
| Working | 30 FPS | 引擎帧率上限设为 30 |
| 失焦/宿主退出 | ≤5 FPS 或退出 | 引擎后台降帧开关；收到 `shutdown` 则退出 |

其余：渲染分辨率 320×320 逻辑像素（宠物本体约 180px）；关闭 Lumen/Nanite/虚拟阴影贴图等重特性（单个低模球体用不到），用简单光照材质；目标常驻内存 < 400MB、GPU 占用 < 5%（RTX 3060 级，30FPS 时）。所有阈值为目标值，技术验证后实测校准。

### 5.8 打包裁剪

- 目标安装包 ≤ 300MB（宠物资产极小，对照空工程裁插件后约 280MB 的社区实测基准）。
- 禁用全部非必需引擎插件（编辑器工具类、媒体、各类框架插件是体积大头）；打包设置中排除未引用目录；用打包排除清单文件（`PakDenylist-<Target>.txt`，旧版叫 `PakBlacklist`，名称与位置有变动）剔除引擎内容中未用的部分，打包后以 `UnrealPak -List` 实测验证裁剪是否生效（论坛对生效路径说法不一）。

### 5.9 多显示器与高 DPI

- 开启引擎的"游戏模式高 DPI"设置；打包时确认清单中声明"每显示器 DPI 感知"（Per-Monitor v2；独立程序默认可能未启用，待验证）。
- 宠物位置以「显示器 ID + 该显示器逻辑像素坐标」存储，避免跨屏拖动或改缩放后位置漂移。
- 跨屏拖拽时响应 DPI 变化消息、按新缩放重算窗口物理尺寸，保持宠物视觉大小一致；显示器断开（休眠/拔线）时重建显示信息并校验坐标，越界则落回主屏安全区。

## 6. 宠物角色、动画与交互

### 6.1 形象规格：3D 打印风格蓝色球

- **本体**：标准球体模型，直径 2.0m（UE 单位），窗口内屏幕占比约 180×180 逻辑像素（96 DPI 基准）。像素尺寸做成配置项 `pet.screenSizePx`，渲染时按目标像素尺寸反算相机距离，换 DPI 宠物不变形。
- **3D 打印质感**（FDM 熔融沉积风格）：不建真实的层纹几何（成本高），用材质表达——底色为 Kimi 蓝（配置项 `pet.bodyColor`，默认建议 `#3D5AFE` 量级，最终值由美术定）；法线贴图叠加程序生成的细水平环纹（条纹噪声，无需外部贴图）；粗糙度 0.55–0.7（哑光塑料感）；无金属度。层纹方向固定在球体自身坐标系，随球体一起旋转。
- **面部（核心决策：材质参数驱动，零骨骼零动画资源）**：一个贴合球面、略浮于表面的独立微曲面片（命名 "FacePlate"），透明背景上程序化绘制眼睛和嘴，用动态材质实例（运行时可改参数的材质副本）的参数控制表情：
  - `EyeOpen`（0–1）：眨眼（上下眼睑遮罩开合）。
  - `EyeLookDir`（二维向量）：东张西望（平移瞳孔位置）。
  - `MouthState`（0 闭合 / 1 微笑 / 2 张嘴）：MVP 只做 0/1。
- 全部表情 = 一组数值参数，天然适合与状态机、交互反馈（如被点击时闭眼微笑）联动。球体模型预留 1 个形变目标（Morph Target）插槽，供后续加"挤压拉伸"动画（MVP 不做）。

### 6.2 Idle 动画集（全程序化，不用动画资源）

由渲染进程的 Idle 控制组件在每帧更新中驱动，所有时间参数进配置：

| 动作 | 实现 | 参数 |
|---|---|---|
| 眨眼 | 每 2–6 秒（均匀随机）触发一次，`EyeOpen` 在 120ms 内 1→0→1（余弦插值）；10% 概率连眨两次 | `idle.blinkIntervalMin/Max = 2.0/6.0s` |
| 东张西望 | 每 4–10 秒随机选一个目标方向（20% 概率看向鼠标当前位置），`EyeLookDir` 200ms 缓动到位，停留 0.8–2 秒后回中；同时球体水平转角 ±20° 跟随视线，300ms 缓入缓出 | `idle.lookIntervalMin/Max = 4.0/10.0s`，`headYawMax = 20°` |
| 呼吸浮动 | 球体整体沿竖直方向 ±0.5cm 正弦浮动，周期 3 秒，叠加 1.5% 缩放的"呼吸"脉动 | `idle.bobAmplitude = 0.5cm` |

边界：拖拽移动/旋转进行中暂停东张西望与头部跟随（避免与用户操作打架），眨眼不打断；松手后 1 秒内不触发随机动作，让宠物"安静落地"。

### 6.3 Working 动画与电脑道具

- **电脑道具**（与球体一致的 3D 打印风格，纯色哑光 + 层纹）：迷你笔记本电脑，展开高度约为球体直径的 45%，放在球体前方。拆成三个静态模型：
  - 键盘底座：键帽起伏用法线贴图表达；留 2 个"主按键"做独立小模型，用于按下反馈。
  - 屏幕：显示面是独立材质槽，平时显示滚动的伪代码字符（贴图坐标滚动 + 字符图集，纯材质实现，无需额外渲染纹理）。
  - 铰链固定 100° 开角，不做开合动画。
  - 道具随状态切换以 150ms 缩放 0→1 弹出 / 收起（带回弹缓动）。
- **敲电脑**（球体无手，"敲"的表达 = 身体节奏性前倾下压）：以 4–7Hz 随机节拍（模拟不规律的敲键）做俯仰 ±8°、竖直方向 -1.5cm 的快速下压回弹（每次 90ms），与两个主按键的按下/弹起（竖直偏移 0.2cm，与下压同步）联动；`EyeLookDir` 锁定向下看屏幕，眨眼沿用 Idle 参数。由 Working 控制组件实现，用随机间隔定时器而非固定节拍，避免机械感。
- 备选（美术评审认为无手敲键盘表现力不足时）：球体两侧加两个小球当"手"程序化上下摆动，改动局限于道具与控制组件。

### 6.4 交互：拖拽移动与旋转（Idle）

- **移动**：左键按下 → 位移超过系统拖拽阈值（读取 Windows 系统值，默认 4px，不写死）→ 进入拖拽，窗口跟随鼠标（保持按下时抓取点的相对偏移，避免跳变），松手结束。
- **旋转**：鼠标位于宠物不透明像素上时，按住 R 和左键拖动；水平拖动控制水平转角，垂直拖动控制俯仰角。默认水平限位 ±30°、垂直限位 ±18°，均在 Pawn 的“摄像机调整”分类中可调。
- **缩放**：鼠标位于宠物不透明像素上时，按住 R 滚动滚轮；默认距离范围 260 到 480，滚轮步进 24，均可在 Pawn 上调整。旋转与缩放期间使用摄像机光标。
- 旋转时面部面片不随球体转（"转头不转脸"），挂在始终面向相机的组件上——实现要点。
- **位置与朝向持久化**：拖拽/旋转结束后发 `pet_moved` 给守护进程统一写配置（避免多个进程写同一文件）；本地缓存 `%APPDATA%/KimiPet/pet-state.json`：`{"window":{"x","y","monitor_id"},"pet":{"yaw","pitch"},"version":1}`，防抖 500ms 写入，进程退出前强制落盘。启动时校验坐标是否落在当前任何显示器工作区内，不在则回退主屏右下角默认位；文件损坏或版本不符则整体回退默认值，不阻断启动。

### 6.5 交互：点击会话面板（全状态）

- **单击**触发会话面板。采用 Windows 标准手势消解模型：
  1. 左键按下：记录坐标与时间戳，不做任何动作。
  2. 位移超阈值 → 判定为拖拽，本次按压周期内不再产生点击。
  3. 左键松开且位移未超阈值、按下时长 < 800ms → 判定为单击，切换会话面板。
  4. 长按（> 800ms 无位移）：MVP 不绑定功能，松开时不触发点击。
- 面板中每个 CLI 会话占一行，最多显示最近 50 条并支持滚轮滚动；活跃会话使用高亮色，历史未激活会话使用深色。当前选中会话显示强调条，`working=true` 显示三点动画，`unread=true` 显示消息气泡动画。面板打开、关闭均使用淡入淡出与短距离滑动动画。
- 面板内容是 `UPetSessionPanelWidget`，通过 `UListView` 和 `UPetSessionRowWidget` 展示；它由 `APetCapturePawn` 持有并直接接收会话快照与增量状态。`FPetSessionWindowHost` 只负责承载这个 Widget 的 `SWindow`，不保存或转发会话数据。
- 独立且不激活的 Slate 窗口不能依赖用户输入唤醒 UMG 动画。Host 用活动计时器持续请求 Slate 绘制，Pawn 在窗口可见时推进面板动画；会话行第一次进入该窗口后停止并刷新 MovieScene 状态，改用单调时钟驱动行入场、工作三点和未读气泡。列表项复用时会先重置按钮透明度和旧状态，再启动新的行入场时钟，避免滚动后整行冻结或状态串行。
- 点击会话行后立即关闭面板并发送带 `session_id` 的 `open_tui`；渲染进程不自己拉起终端，由守护进程恢复指定会话并清除未读状态。
- 发送失败（守护进程断线）时不重试轰炸，只记日志。
- 面板自动显示、更新和移动时不抢夺当前前台应用焦点；用户主动点击会话行后允许 KimiPet 被系统激活。面板窗口按矩形命中区验收，UMG 内部圆角不代表窗口外部透明穿透。

### 6.6 交互：悬停任务详情（Working）与完成气泡

**悬停任务卡**：

- 触发区：屏幕道具上的盒体碰撞区（比屏幕面略大 5mm，便于命中）。鼠标悬停 ≥ 300ms（`interact.hoverDelayMs`）后显示；移出或开始拖拽立即隐藏；悬停期间敲键盘动画不停。
- 形式：宠物本体的任务卡继续沿用现有呈现路径（始终面向相机并锚定在屏幕道具上方）；会话列表、行状态和内容动画由 `Notification` Popup `SWindow` 中的 UMG 负责。本次不为任务卡另行增加原生窗口或离屏 UI 捕获链路。
- 内容：单任务 = 标题 + 运行时长 + 当前阶段 + 可选进度条；多任务 = 垂直列表（图标 + 名称 + 时长），最多 5 条，超出时末尾显示"+N 更多"，不展开详情（详情以终端为准）。
- 数据：进入 Working 时守护进程全量推 `tasks_snapshot`，之后增量推 `task_start`/`task_end`；运行时长由渲染进程按开始时间本地每秒刷新，不要求守护进程每秒推送。
- 边界：任务列表为空但处于 Working（如连接刚建立）→ 显示"正在准备任务…"；标题超长按控件宽度省略号截断（64 字符硬截断）。

**完成气泡**：

- 触发：`notify` 消息。`level=error` 用警示橙色，文案前缀"任务失败"。
- 样式：3D 场景内 UI 组件（同悬浮卡），圆角卡片 + 小三角指向宠物头顶，白底深色字，标题一行 + 摘要最多两行（超长截断），尺寸上限约 320×120 逻辑像素。弹出 200ms（缩放 0.8→1 带回弹），消失 200ms 淡出上浮。
- 停留时长：默认 5 秒（`bubble.durationMs`）；鼠标悬停在气泡上时暂停倒计时，移开后继续剩余时长。
- 点击行为：单击气泡 = 与点击宠物同效，发 `open_tui`（`source:"bubble"` 并带 `task_id`），同时立即关闭该气泡。
- 多条排队：先进先出队列，同屏最多 1 条；当前气泡消失后间隔 300ms 再弹下一条。队列上限 10 条，溢出丢弃最旧并记日志；摘要为空的多条完成允许合并为一条"N 个任务已完成"。
- 边界：任务完成时宠物已回 Idle → 气泡照常弹出（完成事件比状态切换晚到是常态）；进程退出前队列未弹完 → 直接丢弃，不持久化。

### 6.7 状态机（文字版）

```
[*] → Boot
Boot → Idle        : 初始化完成且收到首个 tasks_snapshot（或 3 秒无连接，按无任务处理）

Idle → Working     : pet_state:Working（守护进程权威下发）
                     动作: 暂停 Idle 闲逛控制组件, 弹出电脑道具(150ms), 启动敲键盘控制组件
Working → Idle     : pet_state:Idle
                     动作: 收起电脑道具(150ms), 恢复 Idle 控制组件

Idle 内子状态（互斥, 均不改变主状态）:
  闲逛 (默认: 眨眼/东张西望/呼吸)
  闲逛 → 拖拽中 : 左键拖拽超阈值        拖拽中 → 闲逛 : 松手(+1s 静默)
  闲逛 → 旋转中 : R + 左键拖动超阈值     旋转中 → 闲逛 : 松手
Working 内子状态:
  敲键盘中 (默认: 敲键盘循环)
  敲键盘中 → 悬停任务中 : 光标悬停屏幕 ≥300ms   悬停任务中 → 敲键盘中 : 移出/拖拽开始

气泡与悬浮卡是正交的 UI 层, 不属于主状态机, 任意主状态下按规则弹出。
守护进程断线不建独立主状态: 冻结当前主状态与任务快照, 仅禁用依赖外部数据的动画。
渲染进程上报守护进程的状态字段只报 Idle/Working。
```

### 6.8 交互优先级表

数值越小优先级越高；同一时刻高优先级手势成立则低者优先级被抢占/忽略。

| 优先级 | 输入 | 条件 | 行为 |
|---|---|---|---|
| 1 | 左键拖拽（超阈值） | 任意主状态 | 移动宠物；取消本次点击、关闭悬浮卡 |
| 2 | R + 左键拖动 | 鼠标位于宠物不透明像素 | 调整摄像机水平角与俯仰角，不移动宠物 |
| 3 | R + 鼠标滚轮 | 鼠标位于宠物不透明像素 | 调整摄像机与宠物距离 |
| 4 | 会话行单击 | 会话面板可见 | 发 `open_tui` 打开指定会话并关闭面板 |
| 5 | 悬停 ≥300ms | Working 且命中屏幕碰撞区 | 显示任务悬浮卡 |
| 6 | 左键单击（未超阈值） | 任意状态 | 切换会话面板 |
| 7 | 单击气泡 | 气泡可见 | 发 `open_tui`（带任务 id）并关闭气泡；气泡命中区优先于宠物本体 |
| 8 | 左键长按（>800ms 无位移） | 任意状态 | 无动作（预留） |

## 7. 配置项汇总

守护进程读取 `%KIMI_CODE_HOME%\kimipet\config.json`（不存在则用默认值；渲染进程的启动参数由守护进程据此生成）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `renderer_path` | `%KIMI_PLUGIN_ROOT%\renderer\Pet.exe` | 渲染进程路径 |
| `heartbeat_interval_ms` / `heartbeat_timeout_ms` | 3000 / 10000 | 心跳间隔与超时判定 |
| `restart_max_attempts` / `restart_window_s` | 5 / 60 | 渲染进程崩溃重启策略 |
| `host_grace_seconds` | 120 | 宿主全部退出后的退出倒计时 |
| `auto_quit_with_host` | true | 倒计时结束是否自动退出 |
| `terminal` | `"wt"` | 终端唤起方式：Windows 终端（`wt`）或传统控制台（`cmd`） |
| `session.staleMinutes` | 10 | 忙会话无事件强制转闲但保留活跃会话的时长 |
| `session.cleanupMinutes` | 60 | 异常会话长期无事件才清理的时长，必须大于 `session.staleMinutes` |
| `log_level` | `"info"` | 日志级别 |

渲染进程侧（本地配置 + 守护进程下发覆盖）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `window.topmost` / `window.excludeFromCapture` | true / false | 窗口置顶；从截屏/录屏中排除（预留，默认关闭） |
| `render.fps.idle` / `render.fps.working` | 15 / 30 | 两状态帧率上限 |
| `pet.screenSizePx` / `pet.bodyColor` | 180 / `#3D5AFE` | 宠物像素尺寸 / 体色 |
| `idle.*`、`interact.*`、`bubble.durationMs` | 见 §6 | 动画与交互手感参数 |

## 8. 风险与待验证清单

| # | 项 | 等级 | 缓解 / 验证方法 |
|---|---|---|---|
| R1 | 逐像素透明/穿透在发布版不可用 | **已定性为会话面板不依赖的能力边界**：会话面板使用 `Notification` Popup `SWindow` 与 `PerWindow` 整窗透明度，不验收透明圆角外部穿透；宠物本体现有透明呈现层仍需单独验证，不在本次会话面板迁移中改成第二套窗口后端 |
| R2 | 各事件钩子的完整字段清单官方未公开 | 中 | 临时挂一个把标准输入落盘的采样钩子收集真实数据；协议 `_raw` 透传兜底 |
| R3 | Windows 上钩子命令的相对路径/shell 语义（官方示例为 macOS） | **已实测定性** | Windows 宿主经 cmd 执行钩子命令，`./bin/...` 正斜杠写法报「'.' 不是内部或外部命令」静默失败（2026-08-01 实测）；清单必须用反斜杠 `.\\bin\\kimi-pet-bridge.exe` |
| R4 | 转发器控制台闪窗 | 中 | Node 为控制台程序，依赖宿主侧钩子不闪窗修复（§3.1）；实测确认 |
| R5 | 启动闪烁（默认窗口短暂可见） | 待 Windows/Mac 打包人工验收 | 使用 `-NOSPLASH`、`-windowed`、`-ResX=16`、`-ResY=16`，并由 Slate `OnPreTick` 在首个 Slate 绘制前隐藏默认游戏窗口；必须保留两平台启动录像，Editor 结果不能替代打包验收 |
| R6 | 桌面合成器重启导致透明失效黑底 | 低 | 监听合成状态变化消息并重新设置 |
| R7 | 会话面板显示时抢走前台应用焦点 | 中 | Popup `SWindow` 使用 `FocusWhenFirstShown=false` 与 `ActivationPolicy::Never`；自动显示不抢焦点，但用户主动点击允许 KimiPet 激活，按该语义验收 |
| R8 | 多屏/DPI 位置漂移；独立程序默认可能未启用每显示器 DPI 感知 | 中 | §5.9 策略；通过 Slate 屏幕坐标契约和 Windows/Mac 打包版本人工验证 |
| R9 | 高频钩子拉起开销（`PreToolUse` 风暴） | 中 | 转发器冷启动 <150ms 为目标实测（Node/Bun 冷启动量级）；守护进程 200ms 合并窗口兜底 |
| R10 | `Notification` 类型全集、`wt.exe` 可用性、宿主进程形态（原生/Node） | 低 | 均有备选方案，见 §3/§4 |
| R11 | 命名管道默认权限过宽 | 中 | 创建时显式设置仅当前用户可访问 |
| R12 | 杀软/反作弊误报（窗口有游戏覆盖层特征）；独占全屏应用遮挡宠物 | 低 | MVP 不处理，发版说明列为已知问题 |
| R13 | Notification Popup 在 Windows 与 Mac 的置顶、窗口切换和显示不激活语义存在平台差异 | 中 | 固定使用 `EWindowType::Notification`、Popup、置顶和 `ActivationPolicy::Never`；必须在两平台打包版本中人工验证，不能以 Editor 或单平台结果宣称通过 |
| R14 | Mac 主工程尚未具备完整编译、签名、公证和分发基线 | 高 | 会话面板代码保持平台无关；将 Mac 打包作为独立前置任务，Windows 结果不替代 Mac 验收 |

## 9. MVP 实施计划

1. **阶段 0：纯 Slate 启动与窗口验证（1–2 天，门禁）**：确认 renderer 参数使用 `NOSPLASH` 与最小默认窗口，不包含 `RenderOffScreen`；验证 `OnPreTick` 隐藏默认游戏窗口、SceneCapture 和纹理读回继续工作；创建 `Notification` Popup `SWindow` 承载一个最小 UMG；记录 Windows 与 Mac 打包版本的启动录像，人工检查闪窗、置顶、任务切换、显示不激活和矩形命中。阶段 0 未完成前，不把 Editor 表现视为通过，也不进入面板正式迁移。
2. **阶段 1：C++ 与 UMG 骨架（2–3 天）**：新增 `UPetSessionItem`、`UPetSessionPanelWidget`、`UPetSessionRowWidget` 与两个 UMG Blueprint；新增薄 `FPetSessionWindowHost`，只实现窗口生命周期、显隐、锚点和窗口级动画；用固定数据验证列表复用、选择委托与动画。
3. **阶段 2：接入现有会话状态（1–2 天）**：把 `sessions_snapshot`、`session_start`、`session_end`、`session_state` 由 Pawn 直接接入 Panel Widget；对齐活跃态、working 三点和 unread 气泡；点击行后由 Pawn 直接调用 `SendOpenTui`，再通知 Host 关闭窗口。
4. **阶段 3：跨平台布局与边界（2–3 天）**：完成 Slate 屏幕坐标锚定、负坐标、多显示器和 DPI 约束；确认自动显示不抢焦点、用户主动点击允许激活；分别生成 Windows 与 Mac Development/Shipping 打包版本，执行人工窗口行为和启动录像验收。
5. **阶段 4：切换与清理（1–2 天）**：自动化测试与人工验收全部通过后启用新面板；删除旧 `GDI PetSessionPanel` 及其专用资源和窗口类，不长期维护双后端；更新本 MVP 文档与验证脚本，执行 UE 编译、双平台打包运行验证和 Bridge 全测。

阶段门禁的证据必须来自对应范围的当前状态：Bridge 参数测试和 C++ 自动化测试只能证明静态或逻辑约束，不能替代 Windows/Mac 打包版本的人工录像、焦点、置顶、任务切换和首次点击检查。本文当前只定义目标与验收条件，不宣称上述打包运行验证已经全部通过。
