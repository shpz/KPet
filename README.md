# KPet

一个会跟着 Kimi Code CLI 一起上班的 3D 桌面宠物。

KPet 读取 Kimi Code CLI 的会话与工具事件，把终端里的工作过程变成桌面角色的动作和状态。它既是陪伴型桌宠，也是一个随手可用的 Kimi Code 会话入口：单击会话就能唤起终端，或在浏览器里打开 Kimi 的 Web 界面。

## 功能特性

### 会工作的桌宠

- 空闲时进入 `Idle`，随机眨眼、东张西望，偶尔悄悄看向鼠标。
- 提交请求后进入 `Working`，用工作动画回应 Kimi Code 的执行状态。
- 支持多个会话同时运行：只要任一会话仍在工作，宠物就保持忙碌；全部结束后回到待机状态。
- 会话或渲染进程短暂断开时保留最后状态，重新连接后自动恢复。

### 会话面板

- 单击宠物打开或收起会话面板；面板为网页 UI（基于 CEF 渲染），展示历史会话与活跃会话，并标记工作状态和未读回复。
- 单击任意会话即可打开到对应的 Kimi Code 上下文：按「打开会话方式」设置唤起终端，或在浏览器中打开 Kimi Web 界面。
- 面板跟随宠物定位，在屏幕边缘自动调整方向，并适配多显示器与 DPI 缩放。

### 设置面板

- `Ctrl+,` 打开或收起设置面板（光标需停在宠物本体上）。
- 打开会话方式：`CLI`（唤起 kimi 终端）或 `Web`（用系统默认浏览器打开 Kimi Web 界面）。
- 面板主题三选一：深色玻璃 `dark-glass`、浅色极简 `light-minimal`、可爱宠物 `cute-pet`。
- 显示帧率：在宠物旁浮层分别展示 3D 渲染与页面 UI 的实时帧率。

### 桌面交互

| 操作 | 效果 |
|---|---|
| 左键单击宠物 | 打开或收起会话面板 |
| 左键拖拽宠物 | 移动桌面位置 |
| 长按（约 0.8 秒且未拖动） | 不触发任何动作 |
| `R` 加左键拖动 | 调整观察角度 |
| `R` 加鼠标滚轮 | 拉近或拉远观察距离 |
| `ESC` 加左键单击 | 关闭宠物 |
| `Ctrl` + `,` | 打开或收起设置面板 |

宠物窗口始终置顶，但不会抢走当前应用的焦点。只有角色实际显示的像素会接收鼠标操作，周围透明区域可以直接点击穿透到桌面。

### 后台协作

- 随 Kimi Code 会话按需启动，不注册系统服务，也不需要手动维护后台进程。
- 宿主事件转发失败时不会阻塞会话，事件暂存到 `%TEMP%\kpet-events`，恢复后继续处理。
- 渲染进程失联时自动重连；异常退出由守护进程按 1s / 2s / 4s / 8s（封顶 8s）退避重启，60 秒窗口内最多重启 5 次。
- Windows Terminal 不可用时，自动回退到 `cmd` 打开会话。

## 技术栈

| 组成 | 主要技术 |
|---|---|
| 宿主集成 | Kimi Code CLI 插件与事件钩子 |
| 转发器与守护进程 | TypeScript、Node.js 22、ESM、Node.js 标准库 |
| 进程间通信 | Windows 命名管道、UTF-8 JSON、协议版本 1 |
| 桌宠渲染 | Unreal Engine 5.8、C++、Scene Capture、RHI、GPU Readback |
| 桌面呈现 | Win32、`UpdateLayeredWindow`、逐像素命中 |
| 角色动画 | Skeletal Mesh、Animation Blueprint、Control Rig |
| 界面 | Slate、`SWindow`、SWebBrowser（CEF） |
| 测试 | Node Test Runner（当前 231 项通过）、UE Automation Test、PowerShell 窗口验证 |

系统采用「事件转发器 → 守护进程 → UE5 渲染进程」三进程结构：转发器（`kpetd.exe --relay`）生命周期极短，负责把插件事件转发给常驻的守护进程（`kpetd.exe --daemon`）；守护进程维护会话状态，并拉起与守护渲染进程（`Pet.exe`）。渲染链路、插件事件、通信协议与源码结构见 [技术文档](docs/技术文档.md)。

## 平台与部署

KPet 面向 Windows 11，并与 Kimi Code CLI 集成，支持 Windows 原生与 WSL 两种部署形态。

### Windows 11

原生支持。解压插件包后，在插件根目录内运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1
```

脚本会自检包完整性并停止旧版守护进程。随后在 Kimi Code 会话里执行：

```
/plugins install <插件目录>
```

之后 `/reload` 或开新会话即可生效。

> 若你在 Windows 的 Git Bash / MSYS 环境里，`deploy.sh` 会提示改用原生入口 `deploy.ps1`。

### WSL（形态一）

Kimi Code 运行在 WSL 内，守护进程、渲染进程与宠物窗口仍在 Windows。解压插件包后，在插件根目录内运行：

```sh
sh deploy.sh
```

脚本会自动就位 WSL 版插件清单并停止旧版守护进程。随后在 WSL 的 Kimi Code 会话里执行 `/plugins install <插件目录>`，`/reload` 或开新会话后生效。

### 暂不支持

- **macOS**：目前只有 Windows 构建产物，部署脚本会明确拒绝。
- **普通 Linux**：KPet 是 Windows / WSL（形态一）产品，不支持直接部署。

## 配置说明

守护进程读取 `%KIMI_CODE_HOME%\kpet\config.json`；未设置 `KIMI_CODE_HOME` 时，路径回退到 `%USERPROFILE%\.kimi-code\kpet\config.json`。文件不存在或字段缺失、类型非法时，逐项使用默认值。常用配置项：

- `terminal`：唤醒终端的方式，`wt`（Windows Terminal）、`cmd`（传统控制台）或 `wsl`（WSL 终端）。
- `open_target`：点击会话后的打开目标，`cli`（唤起 kimi 终端）或 `web`（用系统默认浏览器打开）。
- `open_web_url`：web 目标下的 URL 模板，支持 `{session_id}` 占位符；指向回环地址时，会自动拉起本地 `kimi web` 服务并拼上 `#token=` 免密进入 Web UI。
- `ui_theme` / `fps_monitor`：设置面板的默认主题与帧率浮层开关。
- `renderer_path`、心跳与重启参数、`session.staleMinutes` / `cleanupMinutes`、`log_level` 等。

完整配置项、默认值及运行时文件位置（日志、宠物窗口状态、事件暂存）见 [技术文档](docs/技术文档.md) 的「数据与配置」章节。

## 从源码构建与开发

KPet 由 `bridge/`（TypeScript 转发器与守护进程）和 `Pet/`（UE 5.8 C++ 工程）两部分构成。源码结构、开发环境要求、构建与测试步骤见 [技术文档](docs/技术文档.md) 的「源码结构」「开发环境」「构建与测试」章节。

## 许可证与声明

本项目原创代码与文档基于 [MIT License](LICENSE) 开源，Copyright (c) 2026 SHPZ。第三方组件与资产不自动包含在该许可内，其权利与许可归各自权利人所有。

KPet 是社区项目，与 Kimi Code、Moonshot AI、Epic Games 或 Unreal Engine 官方不存在隶属或背书关系。相关名称和商标归各自权利人所有。
