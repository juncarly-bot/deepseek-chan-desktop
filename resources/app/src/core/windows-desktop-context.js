'use strict'

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { normalizeDesktopSample, unknownDesktopContext } = require('./desktop-context')

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class DscDesktopNative {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
}
'@
Add-Type -TypeDefinition $source
$idle = $null
$last = New-Object DscDesktopNative+LASTINPUTINFO
$last.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($last)
if ([DscDesktopNative]::GetLastInputInfo([ref]$last)) {
  $now = [DscDesktopNative]::GetTickCount()
  $idle = [uint32]($now - [uint32]$last.dwTime)
}
$hwnd = [DscDesktopNative]::GetForegroundWindow()
$name = $null
$fullscreen = $null
if ($hwnd -ne [IntPtr]::Zero) {
  [uint32]$pid = 0
  [void][DscDesktopNative]::GetWindowThreadProcessId($hwnd, [ref]$pid)
  if ($pid -gt 0) { try { $name = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {} }
  $window = New-Object DscDesktopNative+RECT
  if ([DscDesktopNative]::GetWindowRect($hwnd, [ref]$window)) {
    $monitor = [DscDesktopNative]::MonitorFromWindow($hwnd, 2)
    $info = New-Object DscDesktopNative+MONITORINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if ($monitor -ne [IntPtr]::Zero -and [DscDesktopNative]::GetMonitorInfo($monitor, [ref]$info)) {
      $m = $info.rcMonitor
      $tol = 12
      $fullscreen = ($window.Left -le ($m.Left + $tol) -and $window.Top -le ($m.Top + $tol) -and $window.Right -ge ($m.Right - $tol) -and $window.Bottom -ge ($m.Bottom - $tol))
    }
  }
}
[pscustomobject]@{ idleMs=$idle; processName=$name; fullscreen=$fullscreen } | ConvertTo-Json -Compress
`

function createWindowsDesktopContextReader({ platform = process.platform, execFileImpl = execFile } = {}) {
  const run = typeof execFileImpl === 'function' ? execFileImpl : execFile
  return async function readDesktopContext({ signal } = {}) {
    if (platform !== 'win32') return unknownDesktopContext()
    try {
      const { stdout } = await promisify(run)('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT,
      ], { windowsHide:true, timeout:2500, maxBuffer:4096, encoding:'utf8', signal })
      const sample = JSON.parse(String(stdout || '').trim())
      return normalizeDesktopSample(sample)
    } catch {
      return unknownDesktopContext()
    }
  }
}

module.exports = { createWindowsDesktopContextReader, POWERSHELL_SCRIPT }
