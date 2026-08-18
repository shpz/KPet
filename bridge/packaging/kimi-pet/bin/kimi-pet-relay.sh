#!/bin/sh
# KimiPet 插件 WSL 宿主 relay 启动脚本（跨平台兼容方案 §5 P1-7，形态一：CLI 在 WSL、守护进程在 Windows）。
# WSL 的 bash 无法直接执行 Windows 清单里的 `.\bin\kimi-petd.exe --relay`（反斜杠与 .exe 均不适用于 Linux）；
# 本脚本定位 Windows 侧 kimi-petd.exe 并经 interop 启动：stdin（宿主事件）随 exec 原样继承，
# 参数由清单（kimi.plugin.wsl.json）给出，脚本只透传 "$@"，不注入默认值。

# 脚本固定位于 <插件根>/bin/ 下，据此向上解析插件根（宿主钩子工作目录即插件根，但以脚本自身位置为准更稳）。
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(dirname "$SCRIPT_DIR")

# 优先使用环境变量 KIMI_PLUGIN_ROOT_WIN（Windows 路径形式，如 D:\Apps\kimi-pet），
# 未设置时用 wslpath -w 把插件根（/mnt/... 等 Linux 路径）转换为 Windows 路径；
# 两种路径 WSL2 interop 均可直接启动 Windows 可执行文件。
if [ -n "${KIMI_PLUGIN_ROOT_WIN:-}" ]; then
  DAEMON_EXE="$KIMI_PLUGIN_ROOT_WIN/bin/kimi-petd.exe"
else
  PLUGIN_ROOT_WIN=$(wslpath -w "$PLUGIN_ROOT") || {
    echo "kimi-pet-relay.sh: wslpath 转换插件根失败: $PLUGIN_ROOT" >&2
    exit 1
  }
  DAEMON_EXE="$PLUGIN_ROOT_WIN/bin/kimi-petd.exe"
fi

# exec 替换当前 shell：stdin 与退出码按 exec 语义原样传递给 kimi-petd.exe。
exec "$DAEMON_EXE" "$@"