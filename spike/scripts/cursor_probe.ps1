param(
    [int]$DurationMs = 4000,
    [int]$PollMs = 2,
    [int]$WigglePx = 10,
    [int]$WiggleMs = 40
)
$ErrorActionPreference = 'Continue'

$src = @"
using System;
using System.Runtime.InteropServices;
public class CursorProbe {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(out CURSORINFO pci);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public static System.Collections.Generic.List<IntPtr> FindAllByClass(string cls) {
        var list = new System.Collections.Generic.List<IntPtr>();
        EnumWindows((h, l) => {
            var sb = new System.Text.StringBuilder(256);
            GetClassNameW(h, sb, 256);
            if (sb.ToString() == cls) { list.Add(h); }
            return true;
        }, IntPtr.Zero);
        return list;
    }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
}
"@
Write-Output "phase: add-type"
Add-Type -TypeDefinition $src
[CursorProbe]::SetProcessDPIAware() | Out-Null

Write-Output "phase: find pet window"
$all = [CursorProbe]::FindAllByClass("KimiPetSpikeLayeredWindow")
Write-Output ("pet-class windows: " + ($all | ForEach-Object { "$_(vis=$([CursorProbe]::IsWindowVisible($_)))" }))
$pet = [IntPtr]::Zero
foreach ($h in $all) { if ([CursorProbe]::IsWindowVisible($h)) { $pet = $h; break } }
if ($pet -eq [IntPtr]::Zero -and $all.Count -gt 0) { $pet = $all[0] }
if ($pet -eq [IntPtr]::Zero) { Write-Output "ERROR: pet window not found"; exit 1 }

$r = New-Object CursorProbe+RECT
[CursorProbe]::GetWindowRect($pet, [ref]$r) | Out-Null
$cx = [int](($r.left + $r.right) / 2)
$cy = [int](($r.top + $r.bottom) / 2)

$petPid = 0
[CursorProbe]::GetWindowThreadProcessId($pet, [ref]$petPid) | Out-Null

Write-Output "phase: focus notepad"
$npProc = $null
try {
    $npProc = Start-Process 'C:\Windows\System32
otepad.exe' -PassThru -ErrorAction Stop
    $npProc.WaitForInputIdle(5000) | Out-Null
    Start-Sleep -Milliseconds 800
    $npHwnd = $npProc.MainWindowHandle
    if ($npHwnd -and $npHwnd -ne [IntPtr]::Zero) {
        [CursorProbe]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # Alt down，绕过前台锁
        [CursorProbe]::SetForegroundWindow($npHwnd) | Out-Null
        [CursorProbe]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # Alt up
    }
} catch { Write-Output "WARN: notepad focus failed: $($_.Exception.Message)" }
Start-Sleep -Milliseconds 300
$fg = [CursorProbe]::GetForegroundWindow()
$fgPid = 0
[CursorProbe]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
Write-Output "pet=$pet petPid=$petPid fg=$fg fgPid=$fgPid center=($cx,$cy) rect=($($r.left),$($r.top),$($r.right),$($r.bottom))"

[CursorProbe]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 50
$ptChk = New-Object CursorProbe+POINT
[CursorProbe]::GetCursorPos([ref]$ptChk) | Out-Null
$inRect = ($ptChk.x -ge $r.left -and $ptChk.x -lt $r.right -and $ptChk.y -ge $r.top -and $ptChk.y -lt $r.bottom)
Write-Output "cursor_at=($($ptChk.x),$($ptChk.y)) pet_rect=($($r.left),$($r.top),$($r.right),$($r.bottom)) in_rect=$inRect"
if (-not $inRect) { Write-Output "ERROR: cursor not inside pet window rect"; exit 1 }
Write-Output "wiggle: ${WigglePx}px every ${WiggleMs}ms"

Write-Output "phase: polling"
$samples = 0; $transitions = 0; $showFlips = 0; $cursorChanges = 0
$prevShow = -1; $prevCur = [IntPtr]::Zero
$cursors = @{}
$cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CursorProbe+CURSORINFO])
$ci = New-Object CursorProbe+CURSORINFO
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$nextTick = 0.0
$nextWiggle = 0.0
$wiggleOn = $false
while ($sw.ElapsedMilliseconds -lt $DurationMs) {
    $ci.cbSize = $cbSize
    [CursorProbe]::GetCursorInfo([ref]$ci) | Out-Null
    $show = $ci.flags -band 1
    if ($samples -gt 0) {
        if ($show -ne $prevShow) { $showFlips++; $transitions++ }
        elseif ($ci.hCursor -ne $prevCur) { $cursorChanges++; $transitions++ }
    }
    $prevShow = $show; $prevCur = $ci.hCursor
    $key = "$($ci.hCursor)"
    if ($cursors.ContainsKey($key)) { $cursors[$key]++ } else { $cursors[$key] = 1 }
    $samples++
    if ($samples % 500 -eq 0 -and ($ci.pt.x -lt $r.left -or $ci.pt.x -ge $r.right -or $ci.pt.y -lt $r.top -or $ci.pt.y -ge $r.bottom)) {
        Write-Output "WARN: cursor drifted out of pet rect at sample $samples ($($ci.pt.x),$($ci.pt.y))"
    }
    if ($WigglePx -gt 0 -and $sw.ElapsedMilliseconds -ge $nextWiggle) {
        $wiggleOn = -not $wiggleOn
        if ($wiggleOn) { [CursorProbe]::SetCursorPos($cx + $WigglePx, $cy) | Out-Null }
        else { [CursorProbe]::SetCursorPos($cx, $cy) | Out-Null }
        $nextWiggle = $sw.ElapsedMilliseconds + $WiggleMs
    }
    $nextTick += $PollMs
    $remain = [int]($nextTick - $sw.ElapsedMilliseconds)
    if ($remain -gt 0) { Start-Sleep -Milliseconds $remain }
}
$sw.Stop()
if ($npProc) { Stop-Process -Id $npProc.Id -Force -ErrorAction SilentlyContinue }
Write-Output ("duration_ms={0} samples={1} rate_hz={2:N0}" -f $sw.ElapsedMilliseconds, $samples, ($samples/($sw.ElapsedMilliseconds/1000)))
Write-Output "transitions=$transitions show_flips=$showFlips cursor_changes=$cursorChanges"
Write-Output "distinct cursors:"
$cursors.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Output ("  hCursor={0} count={1}" -f $_.Key, $_.Value) }
Write-Output "phase: done"
