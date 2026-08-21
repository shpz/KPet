#!/bin/sh
# KPet 插件 WSL 宿主 relay 启动脚本（跨平台兼容方案 §5 P1-7，形态一：CLI 在 WSL、守护进程在 Windows）。
# WSL 的 bash 无法直接执行 Windows 清单里的 `.\bin\kpetd.exe --relay`（反斜杠与 .exe 均不适用于 Linux）；
# 本脚本定位 Windows 侧 kpetd.exe 并经 interop 启动：stdin（宿主事件）随 exec 原样继承，
# 参数由清单（kimi.plugin.wsl.json）给出（--relay），脚本只透传 "$@"，不注入默认值；
# 也透传 --stop 等其他参数（部署脚本用 `sh kpet-relay.sh --stop` 请求旧版守护进程优雅退出）。

# 脚本固定位于 <插件根>/bin/ 下，据此向上解析插件根（宿主钩子工作目录即插件根，但以脚本自身位置为准更稳）。
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(dirname "$SCRIPT_DIR")

# 定位 Windows 侧 kpetd.exe。注意必须用 Linux 路径交给 exec：
# WSL2 interop 会识别 PE 文件并自动转交 Windows 启动，Linux 路径（/mnt/<盘> 与 WSL 原生 ext4 挂载点）均支持；
# 实测 exec 盘符路径（D:\...）或 \\wsl.localhost\... UNC 路径均报 ENOENT（bash 按 POSIX 路径解析，无法定位）。
# 优先使用环境变量 KIMI_PLUGIN_ROOT_WIN（Windows 路径形式，如 D:\Apps\kpet），
# 经 wslpath -u 转回 Linux 路径；未设置时直接用脚本自身定位的插件根。
if [ -n "${KIMI_PLUGIN_ROOT_WIN:-}" ]; then
  if ! command -v wslpath >/dev/null 2>&1; then
    echo "kpet-relay.sh: 未找到 wslpath（需要 WSL 环境）" >&2
    exit 1
  fi
  PLUGIN_ROOT_LINUX=$(wslpath -u "$KIMI_PLUGIN_ROOT_WIN") || {
    echo "kpet-relay.sh: wslpath 转换失败: $KIMI_PLUGIN_ROOT_WIN" >&2
    exit 1
  }
  DAEMON_EXE="$PLUGIN_ROOT_LINUX/bin/kpetd.exe"
else
  DAEMON_EXE="$PLUGIN_ROOT/bin/kpetd.exe"
fi

# exec 替换当前 shell：stdin 与退出码按 exec 语义原样传递给 kpetd.exe。
exec "$DAEMON_EXE" "$@"