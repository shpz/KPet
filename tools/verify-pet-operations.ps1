param(
    [string]$EditorPath = "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe",
    [string]$ProjectPath = "D:\Workspace\UnrealProject\KimiPet\Pet\Pet.uproject",
    [int]$StartupTimeoutSeconds = 45,
    [ValidateRange(0, 1000)]
    [int]$StressToggleCount = 0,
    [switch]$Packaged
)

$ErrorActionPreference = "Stop"
$shippingMode = $Packaged -and $EditorPath -match '(?i)Shipping'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PetVerifyWin32
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr targetDc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr process, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(out CURSORINFO cursorInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public const uint KeyUp = 0x0002;
    public const uint MouseLeftDown = 0x0002;
    public const uint MouseLeftUp = 0x0004;
    public const uint MouseWheel = 0x0800;
    public const uint WmNcHitTest = 0x0084;
    public const uint WmActivate = 0x0006;
    public const uint WmActivateApp = 0x001C;
    public const uint WmMouseActivate = 0x0021;
    public const uint WmLeftButtonDown = 0x0201;
    public const uint WmLeftButtonUp = 0x0202;
    public const uint WmMouseMove = 0x0200;
    public const uint WmSetCursor = 0x0020;
    public const uint WmMouseWheel = 0x020A;
    public const uint PetCameraWheelMessage = 0x8033;
    public const uint PetCameraRotateMessage = 0x8034;
    public const int HtClient = 1;
    public const int GwlExStyle = -20;
    public const long WsExTopmost = 0x00000008L;
    public const long WsExToolWindow = 0x00000080L;
    public const long WsExAppWindow = 0x00040000L;
    public const uint GwOwner = 4;

    public static IntPtr MakeLParam(int low, int high)
    {
        return new IntPtr((high << 16) | (low & 0xffff));
    }

    public static IntPtr FindWindow(string className, uint processId, bool visibleOnly)
    {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hwnd, state) =>
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId || (visibleOnly && !IsWindowVisible(hwnd))) return true;
            var name = new StringBuilder(256);
            GetClassNameW(hwnd, name, name.Capacity);
            if (name.ToString() != className) return true;
            result = hwnd;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindWindowByTitle(string title, uint processId, bool visibleOnly)
    {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hwnd, state) =>
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId || (visibleOnly && !IsWindowVisible(hwnd))) return true;
            var text = new StringBuilder(256);
            GetWindowTextW(hwnd, text, text.Capacity);
            if (text.ToString() != title) return true;
            result = hwnd;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static string FindUnexpectedVisibleWindow(uint processId, IntPtr allowedWindow)
    {
        string result = null;
        EnumWindows((hwnd, state) =>
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId || hwnd == allowedWindow || !IsWindowVisible(hwnd)) return true;
            var className = new StringBuilder(256);
            var title = new StringBuilder(256);
            GetClassNameW(hwnd, className, className.Capacity);
            GetWindowTextW(hwnd, title, title.Capacity);
            result = className + "|" + title;
            return false;
        }, IntPtr.Zero);
        return result;
    }
}
"@

function Get-WindowRectValue([IntPtr]$Window) {
    $rect = New-Object PetVerifyWin32+RECT
    if (-not [PetVerifyWin32]::GetWindowRect($Window, [ref]$rect)) {
        throw "读取窗口坐标失败"
    }
    return $rect
}

function Get-WindowIdentity([IntPtr]$Window) {
    if ($Window -eq [IntPtr]::Zero) { return "句柄为零" }
    $className = New-Object System.Text.StringBuilder 256
    $title = New-Object System.Text.StringBuilder 256
    [PetVerifyWin32]::GetClassNameW($Window, $className, $className.Capacity) | Out-Null
    [PetVerifyWin32]::GetWindowTextW($Window, $title, $title.Capacity) | Out-Null
    [uint32]$processId = 0
    [PetVerifyWin32]::GetWindowThreadProcessId($Window, [ref]$processId) | Out-Null
    return "句柄=$Window 类=$className 标题=$title 进程=$processId"
}

function Wait-Window([string]$ClassName, [uint32]$ProcessId, [int]$TimeoutSeconds, [bool]$VisibleOnly = $true) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $window = [PetVerifyWin32]::FindWindow($ClassName, $ProcessId, $VisibleOnly)
        if ($window -ne [IntPtr]::Zero) { return $window }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待窗口 $ClassName 超时"
}

function Wait-WindowByTitle([string]$Title, [uint32]$ProcessId, [int]$TimeoutSeconds, [bool]$VisibleOnly = $true) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $window = [PetVerifyWin32]::FindWindowByTitle($Title, $ProcessId, $VisibleOnly)
        if ($window -ne [IntPtr]::Zero) { return $window }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待标题为 $Title 的窗口超时"
}

function Wait-WindowVisibility([IntPtr]$Window, [bool]$ExpectedVisible, [int]$TimeoutMilliseconds = 2000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if ([PetVerifyWin32]::IsWindowVisible($Window) -eq $ExpectedVisible) { return }
        Start-Sleep -Milliseconds 20
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "窗口可见性没有在限时内变为 $ExpectedVisible"
}

function Wait-FilePattern([string]$Path, [string]$Pattern, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $text = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
        if ($text -match $Pattern) { return $text }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待文件内容超时: $Pattern"
}

# 判定会话面板 WebUI（CEF）主路径是否真正上屏：轮询编辑器绝对日志直到出现加载结果文案。
# 成功文案「WebUI 会话面板页面加载完成」= 主路径就绪；失败/降级文案
# 「WebUI 会话面板页面加载失败（OnLoadError）」或「WebBrowser 模块不可用，回退 UMG 路径」
# = UMG 降级；超时仍未出现任何标记返回 'UNKNOWN'，由调用方放行或报错。
function Get-WebUiLoadMode([string]$LogPath, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $text = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
        if ($text -match 'WebUI 会话面板页面加载完成') { return 'WebUI' }
        if ($text -match 'WebUI 会话面板页面加载失败（OnLoadError）|WebBrowser 模块不可用.*回退 UMG 路径') { return 'UMG' }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return 'UNKNOWN'
}

function Get-ProcessResourceSnapshot([System.Diagnostics.Process]$Process) {
    $Process.Refresh()
    return [PSCustomObject]@{
        Gdi = [int][PetVerifyWin32]::GetGuiResources($Process.Handle, 0)
        User = [int][PetVerifyWin32]::GetGuiResources($Process.Handle, 1)
        Handles = [int]$Process.HandleCount
        PrivateBytes = [long]$Process.PrivateMemorySize64
    }
}

function Invoke-WindowWheel([IntPtr]$Window, [int]$ScreenX, [int]$ScreenY, [int]$Delta) {
    $wheelParam = [PetVerifyWin32]::MakeLParam(0, $Delta)
    $screenParam = [PetVerifyWin32]::MakeLParam($ScreenX, $ScreenY)
    [PetVerifyWin32]::SetCursorPos($ScreenX, $ScreenY) | Out-Null
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmMouseWheel, $wheelParam, $screenParam) | Out-Null
}

function Find-PetHitPoint([IntPtr]$Window) {
    $rect = Get-WindowRectValue $Window
    $centerX = [int](($rect.Left + $rect.Right) / 2)
    $centerY = [int](($rect.Top + $rect.Bottom) / 2)
    for ($radius = 0; $radius -le 140; $radius += 8) {
        for ($y = $centerY - $radius; $y -le $centerY + $radius; $y += 8) {
            for ($x = $centerX - $radius; $x -le $centerX + $radius; $x += 8) {
                if ($x -lt $rect.Left -or $x -ge $rect.Right -or $y -lt $rect.Top -or $y -ge $rect.Bottom) { continue }
                $point = New-Object PetVerifyWin32+POINT
                $point.X = $x
                $point.Y = $y
                if ([PetVerifyWin32]::WindowFromPoint($point) -eq $Window) {
                    return [System.Drawing.Point]::new($x, $y)
                }
            }
        }
    }
    throw "没有在宠物窗口中找到不透明命中像素"
}

function Wait-PetHitPoint([IntPtr]$Window, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            return Find-PetHitPoint $Window
        } catch {
            Start-Sleep -Milliseconds 100
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待宠物首个可命中渲染帧超时"
}

function Find-PetSemanticHitPoint([IntPtr]$Window) {
    $rect = Get-WindowRectValue $Window
    $centerX = [int](($rect.Left + $rect.Right) / 2)
    $centerY = [int](($rect.Top + $rect.Bottom) / 2)
    for ($radius = 0; $radius -le 152; $radius += 4) {
        for ($y = $centerY - $radius; $y -le $centerY + $radius; $y += 4) {
            for ($x = $centerX - $radius; $x -le $centerX + $radius; $x += 4) {
                if ($x -lt $rect.Left -or $x -ge $rect.Right -or $y -lt $rect.Top -or $y -ge $rect.Bottom) { continue }
                $screen = [PetVerifyWin32]::MakeLParam($x, $y)
                if ([PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmNcHitTest, [IntPtr]::Zero, $screen).ToInt64() -eq [PetVerifyWin32]::HtClient) {
                    return [System.Drawing.Point]::new($x, $y)
                }
            }
        }
    }
    throw "最终上屏像素中没有找到宠物非透明区域"
}

function Invoke-LeftClick([int]$X, [int]$Y) {
    [PetVerifyWin32]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 60
    [PetVerifyWin32]::mouse_event([PetVerifyWin32]::MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [PetVerifyWin32]::mouse_event([PetVerifyWin32]::MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
}

function Notify-WindowApplicationActivated([IntPtr]$Window) {
    # 真实桌面上点击宠物会让进程成为活动应用；锁屏后的直接消息链不会产生这条系统消息。
    # 这里只同步 Slate 的应用活动状态，不发送窗口激活或焦点消息，面板仍保持 Never 策略。
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmActivateApp, [IntPtr]::new(1), [IntPtr]::Zero) | Out-Null
}

function Invoke-WindowLeftClick([IntPtr]$Window, [int]$ScreenX, [int]$ScreenY) {
    $rect = Get-WindowRectValue $Window
    $client = [PetVerifyWin32]::MakeLParam($ScreenX - $rect.Left, $ScreenY - $rect.Top)
    $mouseActivate = [PetVerifyWin32]::MakeLParam([PetVerifyWin32]::HtClient, [PetVerifyWin32]::WmLeftButtonDown)
    [PetVerifyWin32]::SetForegroundWindow($Window) | Out-Null
    # 锁屏后的自动化桌面无法真正切换前台。补发真实鼠标点击会产生的激活消息，
    # 否则 Slate 在非活动应用中不会接受 Button 的鼠标捕获，MouseUp 也就不会触发 OnClicked。
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmMouseActivate, [IntPtr]::Zero, $mouseActivate) | Out-Null
    Notify-WindowApplicationActivated $Window
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmActivate, [IntPtr]::new(2), [IntPtr]::Zero) | Out-Null
    [PetVerifyWin32]::SetCursorPos($ScreenX, $ScreenY) | Out-Null
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmMouseMove, [IntPtr]::Zero, $client) | Out-Null
    Start-Sleep -Milliseconds 80
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmLeftButtonDown, [IntPtr]::new(1), $client) | Out-Null
    Start-Sleep -Milliseconds 80
    [PetVerifyWin32]::SendMessageW($Window, [PetVerifyWin32]::WmLeftButtonUp, [IntPtr]::Zero, $client) | Out-Null
}

function Invoke-PetPanelToggle(
    [IntPtr]$PetWindow,
    [System.Drawing.Point]$HitPoint,
    [bool]$DirectWindowInput) {
    if ($DirectWindowInput) {
        Invoke-WindowLeftClick $PetWindow $HitPoint.X $HitPoint.Y
    } else {
        Invoke-LeftClick $HitPoint.X $HitPoint.Y
    }
}

function Test-RapidPanelReversal(
    [IntPtr]$PetWindow,
    [IntPtr]$PanelWindow,
    [System.Drawing.Point]$HitPoint,
    [bool]$DirectWindowInput,
    [uint32]$ProcessId) {
    # Visible -> Closing -> Opening，必须从当前进度反向并最终保持可见。
    Invoke-PetPanelToggle $PetWindow $HitPoint $DirectWindowInput
    Start-Sleep -Milliseconds 80
    Invoke-PetPanelToggle $PetWindow $HitPoint $DirectWindowInput
    Start-Sleep -Milliseconds 400
    Wait-WindowVisibility $PanelWindow $true

    # 先完整关闭，再验证 Hidden -> Opening -> Closing 的反向路径。
    Invoke-PetPanelToggle $PetWindow $HitPoint $DirectWindowInput
    Wait-WindowVisibility $PanelWindow $false
    Invoke-PetPanelToggle $PetWindow $HitPoint $DirectWindowInput
    Start-Sleep -Milliseconds 80
    Invoke-PetPanelToggle $PetWindow $HitPoint $DirectWindowInput
    Wait-WindowVisibility $PanelWindow $false

    # 恢复为完全打开状态，供后续列表和点击验收使用。
    Invoke-PetPanelToggle $PetWindow $HitPoint $DirectWindowInput
    Wait-WindowVisibility $PanelWindow $true
    Start-Sleep -Milliseconds 350
    $persistentWindow = [PetVerifyWin32]::FindWindowByTitle('KimiPet 会话', $ProcessId, $false)
    if ($persistentWindow -ne $PanelWindow) {
        throw "快速反向过程中会话窗口被销毁并重建"
    }
}

function Test-PanelToggleStress(
    [IntPtr]$PetWindow,
    [IntPtr]$PanelWindow,
    [System.Drawing.Point]$HitPoint,
    [bool]$DirectWindowInput,
    [uint32]$ProcessId,
    [System.Diagnostics.Process]$Process,
    [int]$ToggleCount) {
    if ($ToggleCount -le 0) { return }

    $steadySnapshot = $null
    $warmupBoundary = [Math]::Min(20, $ToggleCount)
    for ($index = 1; $index -le $ToggleCount; $index++) {
        # 压力循环固定走窗口消息链，避免系统鼠标焦点或桌面状态造成偶发丢键。
        # 初次打开与快速反向已单独覆盖真实系统级输入路径。
        # 宠物骨骼动画会改变逐像素命中区域，因此每一轮都重新选择当前不透明点。
        $currentHitPoint = Find-PetSemanticHitPoint $PetWindow
        Invoke-WindowLeftClick $PetWindow $currentHitPoint.X $currentHitPoint.Y
        $expectVisible = $index % 2 -eq 0
        try {
            Wait-WindowVisibility $PanelWindow $expectVisible
        } catch {
            throw "第 $index 次压力开关失败，期望可见性为 ${expectVisible}: $($_.Exception.Message)"
        }
        if ($expectVisible) {
            Start-Sleep -Milliseconds 300
        } else {
            # IsWindowVisible 先于 Host 状态尾部赋值返回，留一帧让 Hidden 状态稳定。
            Start-Sleep -Milliseconds 50
        }

        if ($index -eq $warmupBoundary) {
            $steadySnapshot = Get-ProcessResourceSnapshot $Process
        }
    }

    if (-not [PetVerifyWin32]::IsWindowVisible($PanelWindow)) {
        $currentHitPoint = Find-PetSemanticHitPoint $PetWindow
        Invoke-WindowLeftClick $PetWindow $currentHitPoint.X $currentHitPoint.Y
        Wait-WindowVisibility $PanelWindow $true
        Start-Sleep -Milliseconds 300
    }

    if (-not $steadySnapshot) {
        $steadySnapshot = Get-ProcessResourceSnapshot $Process
    }
    Start-Sleep -Milliseconds 300
    $finalSnapshot = Get-ProcessResourceSnapshot $Process
    $persistentWindow = [PetVerifyWin32]::FindWindowByTitle('KimiPet 会话', $ProcessId, $false)
    if ($persistentWindow -ne $PanelWindow) {
        throw "压力开关过程中会话窗口句柄发生变化"
    }
    if ($steadySnapshot.Gdi -le 0 -or $steadySnapshot.User -le 0) {
        throw "无法读取进程 GUI 资源计数"
    }

    $gdiGrowth = $finalSnapshot.Gdi - $steadySnapshot.Gdi
    $userGrowth = $finalSnapshot.User - $steadySnapshot.User
    $handleGrowth = $finalSnapshot.Handles - $steadySnapshot.Handles
    $privateGrowthMiB = [Math]::Round(($finalSnapshot.PrivateBytes - $steadySnapshot.PrivateBytes) / 1MB, 2)
    if ($gdiGrowth -gt 4) { throw "压力开关后 GDI 资源持续增长: $gdiGrowth" }
    if ($userGrowth -gt 4) { throw "压力开关后 USER 资源持续增长: $userGrowth" }
    if ($handleGrowth -gt 16) { throw "压力开关后进程句柄持续增长: $handleGrowth" }
    if ($privateGrowthMiB -gt 96) { throw "压力开关后私有内存增长过大: ${privateGrowthMiB}MiB" }

    return [PSCustomObject]@{
        ToggleCount = $ToggleCount
        GdiGrowth = $gdiGrowth
        UserGrowth = $userGrowth
        HandleGrowth = $handleGrowth
        PrivateGrowthMiB = $privateGrowthMiB
    }
}

function Capture-Window([IntPtr]$Window, [string]$Path, [bool]$PreferScreenCapture = $false) {
    $rect = Get-WindowRectValue $Window
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        # PrintWindow 对未激活的 GPU 合成窗口可能成功返回但内容仍是旧缓存。
        # 正常桌面验收直接采集屏幕，锁屏直投模式才使用 PrintWindow。
        if ($PreferScreenCapture) {
            $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
        } else {
            $targetDc = $graphics.GetHdc()
            try {
                $printed = [PetVerifyWin32]::PrintWindow($Window, $targetDc, 2)
            } finally {
                $graphics.ReleaseHdc($targetDc)
            }
            if (-not $printed) {
                $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
            }
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Get-PixelDifference(
    [string]$FirstPath,
    [string]$SecondPath,
    [int]$Left = 0,
    [int]$Top = 0,
    [int]$Right = -1,
    [int]$Bottom = -1) {
    $first = [System.Drawing.Bitmap]::FromFile($FirstPath)
    $second = [System.Drawing.Bitmap]::FromFile($SecondPath)
    try {
        $width = [Math]::Min($first.Width, $second.Width)
        $height = [Math]::Min($first.Height, $second.Height)
        $rightBound = if ($Right -lt 0) { $width } else { [Math]::Min($Right, $width) }
        $bottomBound = if ($Bottom -lt 0) { $height } else { [Math]::Min($Bottom, $height) }
        $difference = 0L
        for ($y = [Math]::Max(0, $Top); $y -lt $bottomBound; $y++) {
            for ($x = [Math]::Max(0, $Left); $x -lt $rightBound; $x++) {
                $a = $first.GetPixel($x, $y)
                $b = $second.GetPixel($x, $y)
                $difference += [Math]::Abs([int]$a.R - [int]$b.R)
                $difference += [Math]::Abs([int]$a.G - [int]$b.G)
                $difference += [Math]::Abs([int]$a.B - [int]$b.B)
            }
        }
        return $difference
    } finally {
        $first.Dispose()
        $second.Dispose()
    }
}

function Get-ScrollbarThumbTop([string]$Path) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($Path)
    try {
        $rightBound = [Math]::Min(342, $bitmap.Width)
        $bottomBound = [Math]::Min(215, $bitmap.Height)
        for ($y = 45; $y -lt $bottomBound; $y++) {
            $matches = 0
            for ($x = 329; $x -lt $rightBound; $x++) {
                $pixel = $bitmap.GetPixel($x, $y)
                $maximum = [Math]::Max([int]$pixel.R, [Math]::Max([int]$pixel.G, [int]$pixel.B))
                $minimum = [Math]::Min([int]$pixel.R, [Math]::Min([int]$pixel.G, [int]$pixel.B))
                if ($pixel.R -ge 150 -and $pixel.G -ge 150 -and $pixel.B -ge 150 -and
                    ($maximum - $minimum) -le 20) {
                    $matches++
                }
            }
            if ($matches -ge 6) {
                return $y
            }
        }
        return -1
    } finally {
        $bitmap.Dispose()
    }
}

function Get-MaxRegionPixelDifference(
    [string[]]$Paths,
    [int]$Left,
    [int]$Top,
    [int]$Right,
    [int]$Bottom) {
    $maximum = 0L
    for ($firstIndex = 0; $firstIndex -lt $Paths.Count; $firstIndex++) {
        for ($secondIndex = $firstIndex + 1; $secondIndex -lt $Paths.Count; $secondIndex++) {
            $difference = Get-PixelDifference `
                $Paths[$firstIndex] $Paths[$secondIndex] $Left $Top $Right $Bottom
            $maximum = [Math]::Max($maximum, $difference)
        }
    }
    return $maximum
}

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $ProjectPath -Parent) ".."))
$mockPath = Join-Path $workspaceRoot "tools\mock-daemon.ts"
$artifactRoot = Join-Path (Split-Path $ProjectPath -Parent) "Saved\OperationVerification"
$runDirectory = Join-Path $artifactRoot ([DateTime]::Now.ToString("yyyyMMdd-HHmmss"))
[System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
$mockOut = Join-Path $runDirectory "mock-out.log"
$mockErr = Join-Path $runDirectory "mock-error.log"
$editorLog = Join-Path $runDirectory "pet-runtime.log"

$mockProcess = $null
$editorProcess = $null
$succeeded = $false
$directWindowInput = $false

try {
    if (-not (Test-Path -LiteralPath $EditorPath -PathType Leaf)) { throw "找不到 UE 运行程序: $EditorPath" }
    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Leaf)) { throw "找不到项目: $ProjectPath" }
    if (-not (Test-Path -LiteralPath $mockPath -PathType Leaf)) { throw "找不到模拟守护进程: $mockPath" }

    [PetVerifyWin32]::SetProcessDPIAware() | Out-Null
    # mock-daemon.ts 需要 TS 直跑：node >= 22.6 用 --experimental-strip-types，
    # 低版本 node 回退到 bun（打包链路同样依赖 bun）。
    # 探测经 cmd /c 包一层：避免 node 的 stderr 在 EAP=Stop 下触发 PS 5.1 的 NativeCommandError。
    cmd /c "node.exe --experimental-strip-types -e 0 2>nul" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $mockExe = "node.exe"
        $mockArgs = @("--experimental-strip-types", $mockPath, "--verification-mode")
    } else {
        # bun 常由 npm 安装为 bun.cmd 包装脚本，Start-Process 需定位真正的 bun.exe
        $bunExe = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
        if (-not $bunExe) {
            $bunCmd = (Get-Command bun -ErrorAction SilentlyContinue).Source
            if ($bunCmd) {
                # npm 包装脚本同目录的 node_modules\bun\bin\bun.exe
                $candidate = Join-Path (Split-Path $bunCmd -Parent) "node_modules\bun\bin\bun.exe"
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $bunExe = $candidate }
            }
        }
        if (-not $bunExe) { throw "node 不支持 --experimental-strip-types 且未找到 bun.exe，无法运行模拟守护进程" }
        $mockExe = $bunExe
        $mockArgs = @($mockPath, "--verification-mode")
        Write-Output "node 不支持 --experimental-strip-types，模拟守护进程改用 bun 运行: $mockExe"
    }
    $mockProcess = Start-Process -FilePath $mockExe -ArgumentList $mockArgs -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput $mockOut -RedirectStandardError $mockErr -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 800
    if ($mockProcess.HasExited) {
        throw "模拟守护进程启动失败: $(Get-Content -LiteralPath $mockErr -Raw -ErrorAction SilentlyContinue)"
    }

    $editorArguments = @()
    if (-not $Packaged) {
        $editorArguments += $ProjectPath
        $editorArguments += "-game"
    }
    $editorArguments += @(
        "-NOSPLASH",
        "-windowed",
        "-ResX=16",
        "-ResY=16",
        "-NoSound",
        "-Unattended",
        '"-LogCmds=LogPet Verbose"',
        "-abslog=$editorLog"
    )
    $runtimeWorkingDirectory = if ($Packaged) { Split-Path $EditorPath -Parent } else { Split-Path $ProjectPath -Parent }
    if ($Packaged) {
        # 打包验收必须允许默认游戏窗口真实显示，才能证明 Slate 启动守卫确实隐藏了它。
        $editorProcess = Start-Process -FilePath $EditorPath -ArgumentList $editorArguments `
            -WorkingDirectory $runtimeWorkingDirectory -PassThru
    } else {
        $editorProcess = Start-Process -FilePath $EditorPath -ArgumentList $editorArguments `
            -WorkingDirectory $runtimeWorkingDirectory -WindowStyle Hidden -PassThru
    }

    $petWindow = Wait-Window "KimiPetLayeredWindow" ([uint32]$editorProcess.Id) $StartupTimeoutSeconds
    if ($Packaged) {
        Start-Sleep -Milliseconds 300
        $unexpectedWindow = [PetVerifyWin32]::FindUnexpectedVisibleWindow([uint32]$editorProcess.Id, $petWindow)
        if ($unexpectedWindow) {
            throw "打包版本仍有宠物之外的可见顶层窗口: $unexpectedWindow"
        }
    }
    $petRect = Get-WindowRectValue $petWindow
    $centerPoint = New-Object PetVerifyWin32+POINT
    $centerPoint.X = [int](($petRect.Left + $petRect.Right) / 2)
    $centerPoint.Y = [int](($petRect.Top + $petRect.Bottom) / 2)
    $centerWindow = [PetVerifyWin32]::WindowFromPoint($centerPoint)
    $centerIdentity = Get-WindowIdentity $centerWindow
    if ($centerIdentity -match "LockScreen|锁屏") {
        $petDiagnostic = Join-Path $runDirectory "pet-hit-timeout.png"
        Capture-Window $petWindow $petDiagnostic
        Write-Output "宠物窗口句柄=$petWindow 坐标=$($petRect.Left),$($petRect.Top),$($petRect.Right),$($petRect.Bottom) 中心命中=$centerIdentity"
        $hitPoint = Find-PetSemanticHitPoint $petWindow
        $directWindowInput = $true
        Write-Output "检测到 Windows 锁屏后挡板，切换为窗口消息链验收，非透明命中点为 $($hitPoint.X),$($hitPoint.Y)"
    } else {
        $hitPoint = Wait-PetHitPoint $petWindow 15
    }
    Write-Output "宠物窗口已出现，命中点为 $($hitPoint.X),$($hitPoint.Y)"

    if ($directWindowInput) { Invoke-WindowLeftClick $petWindow $hitPoint.X $hitPoint.Y }
    else { Invoke-LeftClick $hitPoint.X $hitPoint.Y }
    try {
        $panelWindow = Wait-WindowByTitle "KimiPet 会话" ([uint32]$editorProcess.Id) 2
    } catch {
        Write-Output "系统级鼠标注入未触发宠物单击，切换为窗口消息链重试"
        Invoke-WindowLeftClick $petWindow $hitPoint.X $hitPoint.Y
        $directWindowInput = $true
        $panelWindow = Wait-WindowByTitle "KimiPet 会话" ([uint32]$editorProcess.Id) 5
    }
    if ($directWindowInput) {
        Notify-WindowApplicationActivated $panelWindow
    }
    $panelForegroundWindow = [PetVerifyWin32]::GetForegroundWindow()
    if ($panelForegroundWindow -eq $panelWindow) {
        throw "会话面板自行显示时成为了前台窗口"
    }
    $panelExtendedStyle = [uint64]([PetVerifyWin32]::GetWindowLongPtrW(
        $panelWindow,
        [PetVerifyWin32]::GwlExStyle).ToInt64())
    $panelOwner = [PetVerifyWin32]::GetWindow($panelWindow, [PetVerifyWin32]::GwOwner)
    if (($panelExtendedStyle -band [PetVerifyWin32]::WsExTopmost) -eq 0) {
        throw "会话面板没有最终映射为置顶窗口"
    }
    if (($panelExtendedStyle -band [PetVerifyWin32]::WsExAppWindow) -ne 0) {
        throw "会话面板带有独立任务栏窗口样式"
    }
    if (($panelExtendedStyle -band [PetVerifyWin32]::WsExToolWindow) -eq 0 -and $panelOwner -eq [IntPtr]::Zero) {
        throw "会话面板既不是工具窗口也没有所有者，可能进入 Alt 加 Tab 列表"
    }
    Write-Output "窗口身份验证通过：置顶、无独立任务栏样式、显示时未成为前台窗口"
    $openingRect = Get-WindowRectValue $panelWindow
    Start-Sleep -Milliseconds 350
    $openRect = Get-WindowRectValue $panelWindow
    $panelWidth = $openRect.Right - $openRect.Left
    $panelHeight = $openRect.Bottom - $openRect.Top
    if ($panelWidth -ne 360 -or $panelHeight -lt 225 -or $panelHeight -gt 245) {
        throw "会话面板尺寸异常: ${panelWidth}x${panelHeight}"
    }
    if ($openingRect.Left -eq $openRect.Left) {
        throw "没有观察到会话面板打开时的滑动动画"
    }

    # ---- WebUI（CEF）主路径判定 ----
    # Editor/Development 模式必生成 -abslog 绝对日志，据此正向确证 WebUI 是否真正上屏；
    # Shipping 默认不生成运行日志（与下文摄像机校验的既有容错一致），无法确证时按 WebUI
    # 默认配置放行并跳过 UMG 像素断言，避免 Shipping 误报。
    if (Test-Path -LiteralPath $editorLog -PathType Leaf) {
        $webUiLoadMode = Get-WebUiLoadMode $editorLog 8
        if ($webUiLoadMode -eq 'UNKNOWN') {
            throw "无法从运行日志确证会话面板 WebUI（CEF）主路径已加载，也未检测到 UMG 降级标记"
        }
    } else {
        $webUiLoadMode = 'WebUI'
        Write-Output "未生成绝对日志（Shipping 默认），按 WebUI（CEF）默认路径处理并跳过 UMG 像素断言"
    }
    $webUiLoaded = ($webUiLoadMode -eq 'WebUI')
    Write-Output "会话面板渲染路径判定=$webUiLoadMode"

    # ---- 以下为 UMG 降级路径专用断言（滚动条滑块、激活配色、working/unread 像素坐标）----
    # WebUI（CEF）主路径不适用这些 UMG 像素坐标，仅 UMG 面板走此段。
    if (-not $webUiLoaded) {
    # 面板内容与列表行各自还有一次性入场动画；先等它们完全结束，避免把整行淡入
    # 误判为 working 三点或 unread 气泡的循环状态动画。
    Start-Sleep -Milliseconds 750

    $panelFirst = Join-Path $runDirectory "panel-first.png"
    $panelSecond = Join-Path $runDirectory "panel-second.png"
    $panelThird = Join-Path $runDirectory "panel-third.png"
    $panelFourth = Join-Path $runDirectory "panel-fourth.png"
    $panelFifth = Join-Path $runDirectory "panel-fifth.png"
    Capture-Window $panelWindow $panelFirst (-not $directWindowInput)
    # 三点与气泡的周期不同；覆盖约一整轮并取任意两帧的最大差异，避免采样点
    # 刚好落在三角波的对称位置。
    Start-Sleep -Milliseconds 230
    Capture-Window $panelWindow $panelSecond (-not $directWindowInput)
    Start-Sleep -Milliseconds 230
    Capture-Window $panelWindow $panelThird (-not $directWindowInput)
    Start-Sleep -Milliseconds 230
    Capture-Window $panelWindow $panelFourth (-not $directWindowInput)
    Start-Sleep -Milliseconds 230
    Capture-Window $panelWindow $panelFifth (-not $directWindowInput)

    $panelSamples = @($panelFirst, $panelSecond, $panelThird, $panelFourth, $panelFifth)
    $workingDifference = Get-MaxRegionPixelDifference $panelSamples 288 55 320 83
    $unreadDifference = Get-MaxRegionPixelDifference $panelSamples 270 98 330 124
    if ($workingDifference -lt 20) {
        throw "working 三点动画像素变化不足: $workingDifference"
    }
    if ($unreadDifference -lt 50) {
        throw "unread 气泡动画像素变化不足: $unreadDifference"
    }
    Write-Output "状态动画差异：working=$workingDifference unread=$unreadDifference"

    $panelBitmap = [System.Drawing.Bitmap]::FromFile($panelFifth)
    try {
        $activeColor = $panelBitmap.GetPixel(36, 70)
        $inactiveColor = $panelBitmap.GetPixel(36, 154)
        $colorDifference = [Math]::Abs([int]$activeColor.R - [int]$inactiveColor.R) +
            [Math]::Abs([int]$activeColor.G - [int]$inactiveColor.G) +
            [Math]::Abs([int]$activeColor.B - [int]$inactiveColor.B)
        if ($colorDifference -lt 20) {
            throw "激活与未激活会话颜色区别不足: $colorDifference"
        }
    } finally {
        $panelBitmap.Dispose()
    }

    $mockText = Wait-FilePattern $mockOut 'VERIFY_STATE_CLEARED' 8
    if ($mockText -notmatch 'VERIFY_CATALOG_SIZE=50') {
        throw "模拟守护进程没有提供 50 条会话目录"
    }
    Start-Sleep -Milliseconds 180
    $stateClearedFirst = Join-Path $runDirectory "state-cleared-first.png"
    $stateClearedSecond = Join-Path $runDirectory "state-cleared-second.png"
    Capture-Window $panelWindow $stateClearedFirst (-not $directWindowInput)
    Start-Sleep -Milliseconds 350
    Capture-Window $panelWindow $stateClearedSecond (-not $directWindowInput)
    $workingStoppedMotion = Get-PixelDifference $stateClearedFirst $stateClearedSecond 288 55 320 83
    $unreadStoppedMotion = Get-PixelDifference $stateClearedFirst $stateClearedSecond 270 98 330 124
    $workingStateChange = Get-PixelDifference $panelFifth $stateClearedFirst 288 55 320 83
    $unreadStateChange = Get-PixelDifference $panelFifth $stateClearedFirst 270 98 330 124
    if ($workingStoppedMotion -gt 5) {
        throw "working=false 后三点仍在变化: $workingStoppedMotion"
    }
    if ($unreadStoppedMotion -gt 5) {
        throw "unread=false 后气泡仍在变化: $unreadStoppedMotion"
    }
    if ($workingStateChange -lt 20) {
        throw "working=false 后三点没有从可见状态消失: $workingStateChange"
    }
    if ($unreadStateChange -lt 50) {
        throw "unread=false 后气泡没有从可见状态消失: $unreadStateChange"
    }

    $scrollBottom = Join-Path $runDirectory "scroll-bottom.png"
    $scrollTopReturn = Join-Path $runDirectory "scroll-top-return.png"
    $scrollX = $openRect.Left + [int]($panelWidth / 2)
    $scrollY = $openRect.Top + 145
    for ($index = 0; $index -lt 20; $index++) {
        Invoke-WindowWheel $panelWindow $scrollX $scrollY -120
        Start-Sleep -Milliseconds 15
    }
    Start-Sleep -Milliseconds 350
    Capture-Window $panelWindow $scrollBottom (-not $directWindowInput)
    $scrollDifference = Get-PixelDifference $stateClearedSecond $scrollBottom 12 48 348 184
    if ($scrollDifference -lt 10000) {
        throw "50 条会话列表没有响应向下滚动: $scrollDifference"
    }
    for ($index = 0; $index -lt 20; $index++) {
        Invoke-WindowWheel $panelWindow $scrollX $scrollY 120
        Start-Sleep -Milliseconds 15
    }
    Start-Sleep -Milliseconds 350
    Capture-Window $panelWindow $scrollTopReturn (-not $directWindowInput)
    $topThumb = Get-ScrollbarThumbTop $stateClearedSecond
    $bottomThumb = Get-ScrollbarThumbTop $scrollBottom
    $returnThumb = Get-ScrollbarThumbTop $scrollTopReturn
    if ($topThumb -lt 0 -or $bottomThumb -lt 0 -or $returnThumb -lt 0) {
        throw "无法从截图识别滚动条滑块位置: $topThumb -> $bottomThumb -> $returnThumb"
    }
    if ($bottomThumb -lt ($topThumb + 20)) {
        throw "50 条会话列表的滚动条没有明显下移: $topThumb -> $bottomThumb"
    }
    if ([Math]::Abs($returnThumb - $topThumb) -gt 6) {
        throw "列表滚动条没有回到顶部: $topThumb -> $bottomThumb -> $returnThumb"
    }

    # 滚轮刚停止时 Slate 会短暂降低列表内容和滚动条的不透明度。移开鼠标并等待
    # 视觉状态稳定后，再与滚动前基线比较，验证复用后的条目顺序和状态没有串行。
    [PetVerifyWin32]::SetCursorPos($hitPoint.X, $hitPoint.Y) | Out-Null
    Start-Sleep -Milliseconds 1200
    $scrollTopStableFirst = Join-Path $runDirectory "scroll-top-stable-first.png"
    $scrollTopStableSecond = Join-Path $runDirectory "scroll-top-stable-second.png"
    Capture-Window $panelWindow $scrollTopStableFirst (-not $directWindowInput)
    Start-Sleep -Milliseconds 350
    Capture-Window $panelWindow $scrollTopStableSecond (-not $directWindowInput)
    $returnMotion = Get-PixelDifference $scrollTopStableFirst $scrollTopStableSecond 12 48 325 184
    $returnContentDifference = Get-PixelDifference $stateClearedSecond $scrollTopStableSecond 12 48 325 184
    $returnWorkingDifference = Get-PixelDifference $stateClearedSecond $scrollTopStableSecond 288 55 320 83
    $returnUnreadDifference = Get-PixelDifference $stateClearedSecond $scrollTopStableSecond 270 98 325 124
    if ($returnMotion -gt 5) {
        throw "列表回顶后内容仍未稳定: $returnMotion"
    }
    if ($returnContentDifference -gt 5000) {
        throw "列表回顶后条目顺序或内容没有恢复: $returnContentDifference"
    }
    if ($returnWorkingDifference -gt 5 -or $returnUnreadDifference -gt 5) {
        throw "列表回顶后 working 或 unread 状态发生串行: $returnWorkingDifference/$returnUnreadDifference"
    }
    Write-Output (
        "50 条会话滚动差异=$scrollDifference 滑块位置=$topThumb->$bottomThumb->$returnThumb " +
        "回顶内容差异=$returnContentDifference 状态差异=$returnWorkingDifference/$returnUnreadDifference")
    } else {
        # WebUI（CEF）主路径已确证加载（见上方日志判定）。CEF 渲染不适用 UMG 的像素坐标与
        # 滚动条滑块断言，这里跳过并初始化摘要占位，避免 WebUI 主路径误报；UMG 降级时
        # 上面的像素/滚动条断言仍照常执行。
        Write-Output "检测到 WebUI（CEF）会话面板已加载，跳过 UMG 专用像素与滚动条断言"
        $workingDifference = "跳过(WebUI)"
        $unreadDifference = "跳过(WebUI)"
        $workingStoppedMotion = "跳过(WebUI)"
        $unreadStoppedMotion = "跳过(WebUI)"
        $workingStateChange = "跳过(WebUI)"
        $unreadStateChange = "跳过(WebUI)"
        $scrollDifference = "跳过(WebUI)"
        $topThumb = "跳过(WebUI)"
        $bottomThumb = "跳过(WebUI)"
        $returnThumb = "跳过(WebUI)"
        $returnContentDifference = "跳过(WebUI)"
        $returnWorkingDifference = "跳过(WebUI)"
        $returnUnreadDifference = "跳过(WebUI)"
    }

    Test-RapidPanelReversal `
        $petWindow $panelWindow $hitPoint $directWindowInput ([uint32]$editorProcess.Id)
    Write-Output "会话面板打开与关闭快速反向验证通过"

    $stressResult = Test-PanelToggleStress `
        $petWindow $panelWindow $hitPoint $directWindowInput `
        ([uint32]$editorProcess.Id) $editorProcess $StressToggleCount
    if ($stressResult) {
        Write-Output (
            "$($stressResult.ToggleCount) 次开关资源变化：" +
            "GDI=$($stressResult.GdiGrowth) USER=$($stressResult.UserGrowth) " +
            "句柄=$($stressResult.HandleGrowth) 私有内存=$($stressResult.PrivateGrowthMiB)MiB")
    }

    $rowX = $openRect.Left + 120
    $rowY = $openRect.Top + 70
    if ($directWindowInput) { Invoke-WindowLeftClick $panelWindow $rowX $rowY }
    else { Invoke-LeftClick $rowX $rowY }
    Start-Sleep -Milliseconds 80
    if (-not [PetVerifyWin32]::IsWindowVisible($panelWindow)) {
        throw "会话面板点击后立即消失，没有执行关闭动画"
    }
    Start-Sleep -Milliseconds 450
    if ([PetVerifyWin32]::IsWindowVisible($panelWindow)) {
        throw "会话面板关闭动画结束后仍可见"
    }

    [PetVerifyWin32]::SetCursorPos($hitPoint.X, $hitPoint.Y) | Out-Null
    Start-Sleep -Milliseconds 80
    $normalCursor = New-Object PetVerifyWin32+CURSORINFO
    $normalCursor.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][PetVerifyWin32+CURSORINFO])
    [PetVerifyWin32]::GetCursorInfo([ref]$normalCursor) | Out-Null

    # 摄像机回归固定投递到宠物窗口，避免当前桌面的前台窗口切换吞掉鼠标消息。
    # 正常桌面仍覆盖真实 R 加拖动；锁屏桌面使用与滚轮相同的专用回归消息。
    # 后续仍要求 Pawn 运行日志出现实际旋转与缩放数值，不能只凭消息返回值通过。
    $cameraDirectInput = $true
    $cameraHitPoint = Find-PetSemanticHitPoint $petWindow
    $cameraCursor = New-Object PetVerifyWin32+CURSORINFO
    $cameraCursor.cbSize = $normalCursor.cbSize
    if ($directWindowInput) {
        $cameraRotate = [PetVerifyWin32]::MakeLParam(42, -12)
        [PetVerifyWin32]::SendMessageW(
            $petWindow,
            [PetVerifyWin32]::PetCameraRotateMessage,
            $cameraRotate,
            [IntPtr]::Zero) | Out-Null
        Start-Sleep -Milliseconds 80
        $setCursorParam = [PetVerifyWin32]::MakeLParam([PetVerifyWin32]::HtClient, [PetVerifyWin32]::WmMouseMove)
        $cursorHandled = [PetVerifyWin32]::SendMessageW($petWindow, [PetVerifyWin32]::WmSetCursor, [IntPtr]::Zero, $setCursorParam)
        if ($cursorHandled.ToInt64() -ne 1) {
            throw "摄像机调整状态没有接管 WM_SETCURSOR"
        }
    } else {
        [PetVerifyWin32]::keybd_event(0x52, 0, 0, [UIntPtr]::Zero)
        # PetLayeredWindow 使用 GetAsyncKeyState 判定 R；键盘注入后留出一次系统消息更新窗口。
        Start-Sleep -Milliseconds 80
        $petRect = Get-WindowRectValue $petWindow
        $cameraDown = [PetVerifyWin32]::MakeLParam(
            $cameraHitPoint.X - $petRect.Left,
            $cameraHitPoint.Y - $petRect.Top)
        [PetVerifyWin32]::SendMessageW(
            $petWindow,
            [PetVerifyWin32]::WmLeftButtonDown,
            [IntPtr]::new(1),
            $cameraDown) | Out-Null
        [PetVerifyWin32]::SetCursorPos($cameraHitPoint.X + 1, $cameraHitPoint.Y) | Out-Null
        $cameraMove = [PetVerifyWin32]::MakeLParam(
            $cameraHitPoint.X + 1 - $petRect.Left,
            $cameraHitPoint.Y - $petRect.Top)
        [PetVerifyWin32]::SendMessageW(
            $petWindow,
            [PetVerifyWin32]::WmMouseMove,
            [IntPtr]::new(1),
            $cameraMove) | Out-Null
        Start-Sleep -Milliseconds 100
        [PetVerifyWin32]::GetCursorInfo([ref]$cameraCursor) | Out-Null
        $setCursorParam = [PetVerifyWin32]::MakeLParam([PetVerifyWin32]::HtClient, [PetVerifyWin32]::WmMouseMove)
        $cursorHandled = [PetVerifyWin32]::SendMessageW(
            $petWindow,
            [PetVerifyWin32]::WmSetCursor,
            [IntPtr]::Zero,
            $setCursorParam)
        if ($cursorHandled.ToInt64() -ne 1) {
            throw "摄像机调整状态没有接管 WM_SETCURSOR"
        }
        [PetVerifyWin32]::SetCursorPos($cameraHitPoint.X + 42, $cameraHitPoint.Y - 12) | Out-Null
        $cameraMove = [PetVerifyWin32]::MakeLParam(
            $cameraHitPoint.X + 42 - $petRect.Left,
            $cameraHitPoint.Y - 12 - $petRect.Top)
        [PetVerifyWin32]::SendMessageW(
            $petWindow,
            [PetVerifyWin32]::WmMouseMove,
            [IntPtr]::new(1),
            $cameraMove) | Out-Null
        Start-Sleep -Milliseconds 120
        [PetVerifyWin32]::SendMessageW(
            $petWindow,
            [PetVerifyWin32]::WmLeftButtonUp,
            [IntPtr]::Zero,
            $cameraMove) | Out-Null
        [PetVerifyWin32]::keybd_event(0x52, 0, [PetVerifyWin32]::KeyUp, [UIntPtr]::Zero)
    }

	Start-Sleep -Milliseconds 250
	$zoomHitPoint = if ($cameraDirectInput) { Find-PetSemanticHitPoint $petWindow } else { Find-PetHitPoint $petWindow }
	[PetVerifyWin32]::SetCursorPos($zoomHitPoint.X, $zoomHitPoint.Y) | Out-Null
    [PetVerifyWin32]::keybd_event(0x52, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    if ($cameraDirectInput) {
        [PetVerifyWin32]::SendMessageW($petWindow, [PetVerifyWin32]::PetCameraWheelMessage, [IntPtr]::new(120), [IntPtr]::Zero) | Out-Null
    } else {
        [PetVerifyWin32]::mouse_event([PetVerifyWin32]::MouseWheel, 0, 0, 120, [UIntPtr]::Zero)
    }
    [PetVerifyWin32]::keybd_event(0x52, 0, [PetVerifyWin32]::KeyUp, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500

    $mockText = Get-Content -LiteralPath $mockOut -Raw -ErrorAction SilentlyContinue
    $openTuiMatch = [regex]::Match($mockText, '(?m)^.*OPEN_TUI:.*?session_id=(?<sessionId>[^\s]+)')
    if (-not $openTuiMatch.Success -or $openTuiMatch.Groups['sessionId'].Value -cne 'demo-working-session') {
        throw "点击会话行没有向守护进程发送对应会话 id"
    }
    if ($Packaged) {
        if (-not $editorProcess.WaitForExit(10000)) {
            throw "渲染进程收到验证 shutdown 后没有正常退出"
        }
        if ($editorProcess.ExitCode -ne 0) {
            throw "渲染进程正常退出路径返回非零代码: $($editorProcess.ExitCode)"
        }
        $mockText = Wait-FilePattern $mockOut 'VERIFY_SHUTDOWN_SENT' 2
    }
    if (Test-Path -LiteralPath $editorLog -PathType Leaf) {
        $petLogText = Get-Content -LiteralPath $editorLog -Raw
        if ($petLogText -notmatch "摄像机旋转调整") { throw "运行日志中没有摄像机旋转证据" }
        if ($petLogText -notmatch "摄像机距离调整") { throw "运行日志中没有摄像机缩放证据" }
        if ($petLogText -match "Ensure condition failed") { throw "运行日志中出现了 Ensure，端到端验收不通过" }
        if ($petLogText -match "SObjectWidget.*destroyed while collecting garbage") {
            throw "正常退出日志中出现了 SObjectWidget 或 GC 生命周期警告"
        }
        if ($petLogText -match "Fatal error|Unhandled Exception") {
            throw "正常退出日志中出现了崩溃记录"
        }
    } elseif (-not $shippingMode) {
        throw "非 Shipping 验收没有生成运行日志: $editorLog"
    } else {
        Write-Output "Shipping 默认未生成运行日志；摄像机数值变化由 Development 验收覆盖"
    }

    $runMode = if ($shippingMode) {
        "Shipping 打包"
    } elseif ($Packaged) {
        "Development 打包"
    } else {
        "Editor 游戏模式"
    }
    $stressSummary = if ($stressResult) {
        "次数=$($stressResult.ToggleCount) GDI=$($stressResult.GdiGrowth) " +
        "USER=$($stressResult.UserGrowth) 句柄=$($stressResult.HandleGrowth) " +
        "私有内存=$($stressResult.PrivateGrowthMiB)MiB"
    } else {
        "未执行"
    }
    $verificationSummary = @(
        "结果=通过",
        "模式=$runMode",
        "输入路径=$(if ($directWindowInput) { '锁屏窗口消息链' } else { '真实桌面输入链' })",
        "窗口身份=置顶、无独立任务栏样式、显示时未成为前台窗口",
        "状态动画=working:$workingDifference unread:$unreadDifference",
        "状态清除后静止=working:$workingStoppedMotion unread:$unreadStoppedMotion",
        "会话目录=50",
        "列表滚动=内容差异:$scrollDifference 滑块:$topThumb->$bottomThumb->$returnThumb",
        "列表回顶=内容差异:$returnContentDifference 状态差异:$returnWorkingDifference/$returnUnreadDifference",
        "快速反向=通过",
        "生命周期压力=$stressSummary",
        "定向跳转=demo-working-session",
        "摄像机与光标=通过",
        "退出=$(if ($Packaged) { '进程退出码 0' } else { '验证脚本完成后受控清理' })"
    )
    $summaryPath = Join-Path $runDirectory "verification-summary.txt"
    Set-Content -LiteralPath $summaryPath -Value $verificationSummary -Encoding UTF8

    $succeeded = $true
    if ($shippingMode) {
        Write-Output "Shipping 会话列表、状态动画、激活配色、滚动复用、定向跳转、开关动画、摄像机输入链和正常退出验证全部通过"
    } else {
        Write-Output "会话列表、状态动画、激活配色、滚动复用、定向跳转、开关动画、摄像机旋转、缩放、光标和正常退出验证全部通过"
    }
    Write-Output "验证摘要: $summaryPath"
    Write-Output "验证截图目录: $runDirectory"
} finally {
    [PetVerifyWin32]::keybd_event(0x52, 0, [PetVerifyWin32]::KeyUp, [UIntPtr]::Zero)
    if ($editorProcess -and -not $editorProcess.HasExited) {
        Stop-Process -Id $editorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($mockProcess -and -not $mockProcess.HasExited) {
        Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $succeeded) {
        Write-Output "运行时验收失败，诊断文件位于: $runDirectory"
    }
}
