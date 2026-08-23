# KPet 插件部署脚本（Windows 原生入口，配套 deploy.sh 为 POSIX 通用入口）。
#
# 设计目标：在什么操作系统就按该平台准备安装源，然后交给 kimi 的 /plugins install。
# 本脚本覆盖 Windows：自检包完整性、确认 kimi.plugin.json 为 Windows 版清单（若被
# deploy.sh 覆盖成 WSL 版则从 kimi.plugin.json.bak 恢复并二次校验）、停止旧守护进程并
# 清理残留渲染进程（含孤儿场景），最后打印安装指引。
#
# 用法（在解压后的插件根目录内运行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1
# 或 PowerShell 5.1+ 中直接：
#   .\deploy.ps1

$ErrorActionPreference = "Stop"
# EAP=Stop 时 Write-Error 即终止并返回退出码 1，错误分支无需显式 exit。
$pluginRoot = $PSScriptRoot

Write-Output "== KPet 部署（Windows）=="

# 1. 平台自检（Windows PowerShell 5.1 无 $IsWindows，用 $env:OS 兼容）
if ($env:OS -ne "Windows_NT") {
    Write-Output "检测到非 Windows 环境，请改用同目录的 deploy.sh（或按平台选择）。"
    exit 1
}
# WSL 下该变量也会暴露给本脚本，误跑时改为提示使用 WSL 入口
if ($env:WSL_DISTRO_NAME) {
    Write-Output "检测到 WSL 环境变量，WSL 部署请改用 deploy.sh"
    exit 1
}

# 2. 产物自检
$required = @(
    "bin\kpetd.exe",
    "renderer\Pet.exe",
    "bin\kpet-relay.sh"
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot $rel) -PathType Leaf)) {
        Write-Error "包不完整: 缺少 $rel"
    }
}

# 3. 清单确认：Windows 版 command 直启 .\bin\kpetd.exe；
#    若该目录曾在 WSL 里跑过 deploy.sh，kimi.plugin.json 会是 WSL 版（含 kpet-relay.sh），从备份恢复。
$manifest = Join-Path $pluginRoot "kimi.plugin.json"
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    Write-Error "缺少 kimi.plugin.json"
}
$manifestText = Get-Content -LiteralPath $manifest -Raw
if ($manifestText -match "kpet-relay\.sh") {
    $backup = Join-Path $pluginRoot "kimi.plugin.json.bak"
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
        Write-Error "kimi.plugin.json 是 WSL 版清单且无备份 kimi.plugin.json.bak；请从发布包重新解压得到 Windows 版。"
    }
    # 备份本身也可能被 deploy.sh 二次覆盖成 WSL 版，恢复前先校验确为 Windows 版
    if ((Get-Content -LiteralPath $backup -Raw) -match "kpet-relay\.sh") {
        Write-Error "备份 kimi.plugin.json.bak 也是 WSL 版清单（含 kpet-relay.sh），无法恢复 Windows 版；请从发布包重新解压。"
    }
    Copy-Item -LiteralPath $backup -Destination $manifest -Force
    # 恢复后读回清单二次校验，防坏备份"假恢复"（复制成功但内容仍含 relay 字样）
    if ((Get-Content -LiteralPath $manifest -Raw) -match "kpet-relay\.sh") {
        Write-Error "恢复后 kimi.plugin.json 仍含 kpet-relay.sh，备份疑似损坏；请从发布包重新解压得到 Windows 版。"
    }
    Write-Output "kimi.plugin.json 是 WSL 版清单，已从 kimi.plugin.json.bak 恢复为 Windows 版。"
} else {
    Write-Output "kimi.plugin.json 为 Windows 版清单，无需处理。"
}

# 4. 停止旧守护进程（新分发经 daemon 的 --stop 契约优雅退出；非致命，失败仅告警不阻塞安装）
$daemonExe = Join-Path $pluginRoot "bin\kpetd.exe"
& $daemonExe --stop
if ($LASTEXITCODE -ne 0) {
    Write-Output "警告: 旧版守护进程未能停止，请先手动关闭宠物再执行 /plugins install"
} else {
    # 清理残留渲染进程。孤儿成因：停止宠物时只终止守护进程/启动器（Pet.exe），
    # UE 游戏本体 Pet-Win64-Shipping.exe 不跟随退出，成为无主进程残留在桌面，
    # 且仍连接守护进程控制管道，与新会话交替握手互相顶下线；其 CEF 子进程
    # EpicWebHelper.exe 同理残留。
    # 仅当 --stop 成功（退出码 0）时清理：旧守护进程还活着时可能重新拉起渲染端，
    # 清了也是白清，还会与守护进程打架。
    # 按 ExecutablePath 前缀匹配受管安装目录 <home>\plugins\managed\kpet\renderer，
    # 精确覆盖本插件的全部渲染进程，不误伤系统里其他 UE 应用。
    try {
        # home 解析与守护进程一致：KIMI_CODE_HOME 非空则用它，否则 $HOME\.kimi-code
        $homeDir = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $HOME ".kimi-code" }
        # 前缀末尾补 "\" 防误配 renderer2 之类的相邻目录
        $rendererPrefix = (Join-Path $homeDir "plugins\managed\kpet\renderer").TrimEnd('\') + '\'
        $staleProcesses = @(
            Get-CimInstance Win32_Process -ErrorAction Stop |
                Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($rendererPrefix, [StringComparison]::OrdinalIgnoreCase) }
        )
        foreach ($proc in $staleProcesses) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        }
        if ($staleProcesses.Count -gt 0) {
            Write-Output "已清理 $($staleProcesses.Count) 个残留渲染进程（含孤儿场景下未跟随退出的宠物窗口）。"
        } else {
            Write-Output "未发现残留渲染进程，无需清理。"
        }
    } catch {
        # 清理非致命：失败仅告警，不阻塞安装，不改变脚本退出码契约
        Write-Output "警告: 残留渲染进程清理失败（$($_.Exception.Message)），请手动关闭多余的宠物窗口后再继续。"
    }
}

# 5. 安装指引
Write-Output ""
Write-Output "安装: 在 kimi（Windows）会话里执行"
Write-Output "  /plugins install $pluginRoot"
Write-Output "然后 /reload 或开新会话生效。"
Write-Output "说明: hook 会执行 .\bin\kpetd.exe --relay，守护进程拉起 renderer\Pet.exe 显示宠物。"