#!/bin/sh
# KPet 插件部署脚本（POSIX 通用入口，配套 deploy.ps1 为 Windows 原生入口）。
#
# 设计目标：在什么操作系统就按该平台准备安装源，然后交给 kimi 的 /plugins install：
#   - WSL（形态一：CLI 在 WSL、守护进程/渲染端仍在 Windows）：
#       把 kimi.plugin.wsl.json 就位为 kimi.plugin.json（覆盖前备份），自愈 relay 脚本可执行位；
#       停止旧守护进程并清理残留渲染进程（含孤儿场景）；
#   - Windows：默认 kimi.plugin.json 即 Windows 版，本脚本提示改用 deploy.ps1；
#   - macOS：暂不支持（尚无 macOS 构建产物，见 docs/跨平台兼容方案-WSL与Mac.md 第 4/5 节，TODO）。
#   - 其他 Linux：KPet 为 Windows/WSL 形态一产品，不支持直接部署。
#
# 用法（在解压后的插件根目录内运行）：
#   sh deploy.sh      # 或先 chmod +x deploy.sh 后 ./deploy.sh
# 幂等：重复运行不会破坏已就位的清单。

set -u

# 插件根 = 脚本所在目录（POSIX 定位，兼容 sh/dash/bash）
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$SCRIPT_DIR

say() { printf '%s\n' "$*"; }

say "== KPet 部署 =="

# 平台检测 ---------------------------------------------------------------
detect_platform() {
    case "$(uname -s 2>/dev/null)" in
        MINGW*|MSYS*|CYGWIN*)
            say "windows-gitbash" ;;
        *)
            if [ "${OS:-}" = "Windows_NT" ]; then
                say "windows-gitbash"
            elif [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
                say "wsl"
            elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
                say "macos"
            else
                say "linux"
            fi
            ;;
    esac
}

case "$(detect_platform)" in
    windows-gitbash)
        say "检测到 Windows 环境（Git Bash/MSYS）。"
        if [ ! -f "$PLUGIN_ROOT/deploy.ps1" ]; then
            say "错误: 未找到同目录的 deploy.ps1，包不完整。" >&2
            exit 1
        fi
        say "请改用同目录的原生入口 deploy.ps1："
        # 用 Windows 盘符路径提示（MSYS 的 /d/... 形式 PowerShell 不识别）
        if command -v cygpath >/dev/null 2>&1; then
            WIN_ROOT=$(cygpath -w "$PLUGIN_ROOT" 2>/dev/null || printf '%s' "$PLUGIN_ROOT")
        else
            WIN_ROOT=$PLUGIN_ROOT
        fi
        say "  powershell -NoProfile -ExecutionPolicy Bypass -File \"$WIN_ROOT\\deploy.ps1\""
        exit 0
        ;;
    macos)
        say "检测到 macOS。KPet 目前只有 Windows 构建产物（bin/kpetd.exe、renderer/Pet.exe），"
        say "暂不支持 macOS 部署（见 docs/跨平台兼容方案-WSL与Mac.md 第 4/5 节）。"
        exit 1
        ;;
    linux)
        say "检测到普通 Linux（非 WSL）。KPet 为 Windows/WSL 形态一产品，不支持直接部署。"
        exit 1
        ;;
    wsl)
        : ;;  # 继续走 WSL 分支
esac

# WSL 分支 ---------------------------------------------------------------
say "检测到 WSL（形态一：CLI 在 WSL、守护进程/渲染端在 Windows）。"

# 1. 产物自检
if [ ! -f "$PLUGIN_ROOT/bin/kpetd.exe" ]; then
    say "错误: 未找到 bin/kpetd.exe，包不完整（WSL 形态一要求包内含 Windows 守护进程）。" >&2
    exit 1
fi
if [ ! -f "$PLUGIN_ROOT/bin/kpet-relay.sh" ]; then
    say "错误: 未找到 bin/kpet-relay.sh，包不完整。" >&2
    exit 1
fi
if [ ! -f "$PLUGIN_ROOT/renderer/Pet.exe" ]; then
    say "错误: 未找到 renderer/Pet.exe，包不完整。" >&2
    exit 1
fi

# 2. 自愈 relay 脚本执行位（zip 解压 / 跨文件系统拷贝会丢 POSIX 权限位）
chmod +x "$PLUGIN_ROOT/bin/kpet-relay.sh" 2>/dev/null || true

# 3. 就位 WSL 清单：kimi.plugin.wsl.json -> kimi.plugin.json（覆盖前备份原 Windows 版）
if [ ! -f "$PLUGIN_ROOT/kimi.plugin.wsl.json" ]; then
    say "错误: 未找到 kimi.plugin.wsl.json。" >&2
    exit 1
fi
if [ ! -f "$PLUGIN_ROOT/kimi.plugin.json" ]; then
    say "错误: 未找到 kimi.plugin.json（Windows 版清单）。" >&2
    exit 1
fi
if cmp -s "$PLUGIN_ROOT/kimi.plugin.json" "$PLUGIN_ROOT/kimi.plugin.wsl.json" 2>/dev/null; then
    say "kimi.plugin.json 已是 WSL 版清单（与 kimi.plugin.wsl.json 一致），跳过。"
else
    if ! cp "$PLUGIN_ROOT/kimi.plugin.json" "$PLUGIN_ROOT/kimi.plugin.json.bak" 2>/dev/null; then
        say "错误: 备份 kimi.plugin.json 失败（无法写入 kimi.plugin.json.bak），中止部署。" >&2
        exit 1
    fi
    cp "$PLUGIN_ROOT/kimi.plugin.wsl.json" "$PLUGIN_ROOT/kimi.plugin.json"
    say "已将 WSL 清单就位为 kimi.plugin.json（原 Windows 版备份为 kimi.plugin.json.bak）。"
fi

# 4. 停止旧版守护进程并清理残留渲染进程（含孤儿场景；非致命，失败仅告警后继续）
if ! sh "$PLUGIN_ROOT/bin/kpet-relay.sh" --stop; then
    say "警告: 旧版守护进程未能停止，请先手动关闭宠物再执行 /plugins install" >&2
else
    # --stop 成功后才清理：此时旧守护进程已退出，不会再重新拉起渲染端。
    # 清理范围：受管安装目录 <kimi-code home>/plugins/managed/kpet/renderer/ 下的残留进程
    # （Pet-Win64-Shipping.exe 游戏本体与 EpicWebHelper.exe 等），覆盖 --stop 未带走的孤儿渲染进程。
    # 经 WSL interop 调用 Windows 侧 PowerShell；本次调用失败仅告警，不阻塞后续部署。
    if command -v powershell.exe >/dev/null 2>&1; then
        if powershell.exe -NoProfile -Command '
$kimiHome = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $HOME ".kimi-code" }
$rendererRoot = Join-Path $kimiHome "plugins\managed\kpet\renderer"
$prefix = $rendererRoot.TrimEnd("\") + "\"
Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
'; then
            say "已清理残留渲染进程（含孤儿 Pet-Win64-Shipping.exe / EpicWebHelper.exe）。"
        else
            say "警告: 残留渲染进程清理失败（不影响后续部署）。" >&2
        fi
    else
        say "警告: 未找到 powershell.exe（WSL interop 不可用），跳过残留渲染进程清理。" >&2
    fi
fi

# 5. 安装指引
say ""
say "安装: 在 WSL 的 kimi 会话里执行"
say "  /plugins install $PLUGIN_ROOT"
say "然后 /reload 或开新会话生效。"
say "说明: hook 会执行 bin/kpet-relay.sh，经 WSL interop 直启 Windows 侧 bin/kpetd.exe；"
say "      守护进程首次拉起 renderer/Pet.exe，宠物显示在 Windows 桌面。"