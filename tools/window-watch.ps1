# Debug tool: watch window visibility/rect changes for the launched Pet.exe process tree.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-watch.ps1 [-Seconds 15]
param(
  [int]$Seconds = 15,
  [string]$ExePath = "D:\Workspace\UnrealProject\KimiPet\Pet\Binaries\Win64\Pet.exe",
  [string]$ExeArgs = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const int DWMWA_CLOAKED = 14;
}
"@

if ($ExeArgs -ne '') {
  $proc = Start-Process -FilePath $ExePath -ArgumentList $ExeArgs -WorkingDirectory (Split-Path $ExePath) -PassThru
} else {
  $proc = Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path $ExePath) -PassThru
}
Write-Host "launched pid=$($proc.Id) args='$ExeArgs' at $(Get-Date -Format HH:mm:ss.fff)"

$start = Get-Date
$lastStates = @{}
$pids = @{}
$iter = 0
while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
  $elapsed = [int](((Get-Date) - $start).TotalMilliseconds)
  # refresh pid tree only every 20 iterations (Get-CimInstance is slow)
  if ($iter % 20 -eq 0) {
    $pids = @{}
    Get-CimInstance Win32_Process -Filter "Name='Pet.exe'" | ForEach-Object {
      if ($_.ProcessId -eq $proc.Id -or $_.ParentProcessId -eq $proc.Id) { $pids[$_.ProcessId] = $true }
    }
  }
  $iter++
  $states = New-Object System.Collections.Generic.List[string]
  if ($elapsed % 1000 -lt 100) {
    Write-Host "[$elapsed ms] heartbeat, tracked pids: $($pids.Keys -join ',')"
  }
  $cb = [WinEnum+EnumWindowsProc]{
    param($h, $l)
    $wpid = 0
    [void][WinEnum]::GetWindowThreadProcessId($h, [ref]$wpid)
    $sb = New-Object System.Text.StringBuilder 64
    [void][WinEnum]::GetClassNameW($h, $sb, 64)
    $cls = $sb.ToString()
    $r = New-Object WinEnum+RECT
    [void][WinEnum]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
    $vis = [WinEnum]::IsWindowVisible($h)
    $cloaked = 0
    [void][WinEnum]::DwmGetWindowAttribute($h, [WinEnum]::DWMWA_CLOAKED, [ref]$cloaked, 4)
    $isTarget = $pids.ContainsKey($wpid) -and $cls -ne ''
    # target-process windows, or ANY fullscreen-size visible window (catch mystery black window)
    if ($isTarget -or ($vis -and -not $cloaked -and $w -ge 1900 -and $hgt -ge 1000)) {
      $tb = New-Object System.Text.StringBuilder 128
      [void][WinEnum]::GetWindowTextW($h, $tb, 128)
      $states.Add("hwnd=$h pid=$wpid cls=$cls title='$($tb.ToString())' vis=$vis cloaked=$cloaked rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) ${w}x${hgt}")
    }
    return $true
  }
  [void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)
  foreach ($s in $states) {
    $key = ($s -split ' vis=')[0]
    if (-not $lastStates.ContainsKey($key) -or $lastStates[$key] -ne $s) {
      Write-Host "[$elapsed ms] $s"
      $lastStates[$key] = $s
    }
  }
  foreach ($k in @($lastStates.Keys)) {
    $found = $false
    foreach ($s in $states) { if ($s.StartsWith($k)) { $found = $true; break } }
    if (-not $found) { Write-Host "[$elapsed ms] GONE: $k"; $lastStates.Remove($k) }
  }
  Start-Sleep -Milliseconds 50
}

Get-CimInstance Win32_Process -Filter "Name='Pet.exe'" | ForEach-Object {
  if ($_.ProcessId -eq $proc.Id -or $_.ParentProcessId -eq $proc.Id) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "killed pid=$($_.ProcessId)"
  }
}
