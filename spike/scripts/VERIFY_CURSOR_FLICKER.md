# 光标闪烁修复 — 验收指南

## 修复内容（已合入）
`Source/KimiPetSpike/LayeredPetWindow.cpp` 的 `HandleMessage` 新增 `WM_SETCURSOR` 分支：
命中客户区（不透明像素）时 `::SetCursor(IDC_ARROW)` 并返回 TRUE 吃掉消息，
阻止 `DefWindowProc` 把消息沿父链交给 UE/Slate 窗口反复改写光标（闪烁根因）。
拖拽 / 逐像素透明 / 透明穿透路径均未改动。

## 检测脚本
`spike/scripts/cursor_probe.ps1`
- 按窗口类名 `KimiPetSpikeLayeredWindow`（EnumWindows，取可见实例）定位宠物窗口
- 光标钉在球体中心并做 ±10px 往复抖动（模拟鼠标划过不透明区）
- 以 ~500Hz 轮询 `CURSORINFO`，统计 show/hide 翻转数与 hCursor 切换数
- 自动拉起记事本并切前台（若失败则以前台非宠物进程为准，脚本会打印 fgPid 供核对）

## 复跑步骤（需在未锁屏的交互会话中执行）
```bash
# 0. 杀残留
taskkill //F //IM UnrealEditor.exe

# 1. 基线（未修复）：把 LayeredPetWindow.cpp 的 WM_SETCURSOR 分支整段删掉后
"/c/Program Files/Epic Games/UE_5.8/Engine/Build/BatchFiles/Build.bat" KimiPetSpikeEditor Win64 Development -Project="D:/Workspace/KimiPet/spike/KimiPetSpike/KimiPetSpike.uproject" -WaitMutex
cmd //c start "" "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe" "D:\Workspace\KimiPet\spike\KimiPetSpike\KimiPetSpike.uproject" -game -windowed -ResX=320 -ResY=240 -log -stdout -unattended
# 等 ~50s 待窗口出现后：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\Workspace\KimiPet\spike\scripts\cursor_probe.ps1" -DurationMs 5000 -PollMs 2
# 记录 transitions=

# 2. 修复后：恢复 WM_SETCURSOR 分支，重复构建 + 启动 + 检测，对比 transitions
```

## 注意
- 本机 FindWindow 在此 Agent 会话里异常返回 0（EnumWindows 正常），脚本已用 EnumWindows 兜底，勿改回 FindWindow。
- 会话锁屏（LockApp 前台）时宠物窗口收不到任何 WM_SETCURSOR/鼠标消息，检测恒为 0，必须在解锁状态下测。
- 判读：基线 transitions 应明显 >0（show_flips 或 cursor_changes）；修复后应收敛到 0 或接近 0。
