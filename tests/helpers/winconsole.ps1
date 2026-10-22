# Drive a terminal program in a REAL Windows console (conhost) and read its screen.
#
# Starts any command line in a new console window, injects keyboard and mouse input as console
# input records (what the console host itself delivers: key down + key up, mouse button, wheel)
# and dumps the screen text. Works for any program that reads the console (Ratatui, Node, Bun,
# Go, Python ...), so the same script checks every framework's export.
#
# Usage (Windows PowerShell 5.1 / 7):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/helpers/winconsole.ps1 `
#       -Exe <program> [-Args "<arguments>"] [-WorkDir <dir>] [-Cols 120] [-Rows 30] `
#       [-Settle 3] -Steps "dump,tab,t:hello,click:10:4,wheel:10:10:-3,dump,q"
#
# Parameters
#   -Exe      program to start (a path, or a name on PATH such as node, bun, go, cargo)
#   -Args     its arguments as one string (e.g. "run ." or "dist\app.js")
#   -WorkDir  working directory (default: current)
#   -Cols/-Rows  console size in cells (set with `mode con` before the program starts)
#   -Settle   seconds to wait after start before the first step (default 3)
#   -Pause    milliseconds after every step before the screen is read (default 400)
#   -Steps    comma separated input steps (executed in order; the screen is dumped after every
#             step unless -Quiet is given, and always by the "dump" step):
#       tab  shift+tab  enter  esc  space  backspace  delete  up  down  left  right
#       pgup pgdn  home  end  f1..f12      a named key (press + release)
#       t:text                              type text, one key per character
#       ctrl:x  alt:x                       a letter with Ctrl / Alt held
#       click:X:Y   rclick:X:Y              left / right click at screen cell (0-based)
#       move:X:Y                            move the mouse
#       wheel:X:Y:N                         mouse wheel at X,Y; N notches, negative = down
#       q                                   the key q (a common quit key)
#       wait:MS                             pause
#       dump                                print the screen now
#   -Quiet    only print "dump" steps, the final status and the exit code
#
# Output (stdout, UTF-8): for every dump a header "=== <step> (<cols>x<rows>) ===" followed by the
# rows of the visible console window (trailing blanks removed), and at the end either
# "EXITED code <n>" or "still running" (the process is then killed).
# Exit code of this script: 0 normally, 1 if the console could not be attached.

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Args = "",
  [string]$WorkDir = "",
  [int]$Cols = 120,
  [int]$Rows = 30,
  [double]$Settle = 3,
  [int]$Pause = 400,
  [string]$Steps = "dump",
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Con {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string n, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder sb, uint len, COORD c, out uint read);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD size; public COORD cur; public ushort attr; public SMALL_RECT win; public COORD max; }
  [StructLayout(LayoutKind.Explicit, Size=20)] public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public ushort UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
    [FieldOffset(4)] public short MouseX;
    [FieldOffset(6)] public short MouseY;
    [FieldOffset(8)] public uint ButtonState;
    [FieldOffset(12)] public uint MouseControl;
    [FieldOffset(16)] public uint MouseFlags;
  }
  public static INPUT_RECORD Key(ushort vk, char ch, bool down, uint state) {
    var r = new INPUT_RECORD(); r.EventType = 1; r.bKeyDown = down ? 1 : 0; r.wRepeatCount = 1;
    r.wVirtualKeyCode = vk; r.wVirtualScanCode = 0; r.UnicodeChar = ch; r.dwControlKeyState = state; return r;
  }
  public static INPUT_RECORD Mouse(short x, short y, uint buttons, uint flags) {
    var r = new INPUT_RECORD(); r.EventType = 2; r.MouseX = x; r.MouseY = y; r.ButtonState = buttons; r.MouseControl = 0; r.MouseFlags = flags; return r;
  }
}
"@
Add-Type -TypeDefinition $src

# `mode con` sets the console size; cmd keeps the console of the program.
$inner = if ($Args) { "`"$Exe`" $Args" } else { "`"$Exe`"" }
$cmd = "mode con cols=$Cols lines=$Rows >nul && $inner"
$psi = @{ FilePath = "cmd.exe"; ArgumentList = @("/c", $cmd); PassThru = $true; WindowStyle = "Normal" }
if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
$p = Start-Process @psi
Start-Sleep -Milliseconds ([int]($Settle * 1000))

[Con]::FreeConsole() | Out-Null
if (-not [Con]::AttachConsole([uint32]$p.Id)) {
  Write-Output "attach failed $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 1
}
$access = [uint32]3221225472  # GENERIC_READ | GENERIC_WRITE
$in = [Con]::CreateFile("CONIN$", $access, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$out = [Con]::CreateFile("CONOUT$", $access, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)

function Dump($label) {
  $info = New-Object Con+CSBI
  [Con]::GetConsoleScreenBufferInfo($out, [ref]$info) | Out-Null
  $w = $info.size.X; $h = $info.win.B - $info.win.T + 1
  Write-Output "=== $label (${w}x${h}) ==="
  for ($y = $info.win.T; $y -le $info.win.B; $y++) {
    $sb = New-Object System.Text.StringBuilder $w
    $n = 0
    $c = New-Object Con+COORD; $c.X = 0; $c.Y = $y
    [Con]::ReadConsoleOutputCharacter($out, $sb, [uint32]$w, $c, [ref]$n) | Out-Null
    Write-Output $sb.ToString().TrimEnd([char]0, [char]32)
  }
}
function Send($recs) {
  $n = 0
  [Con]::WriteConsoleInput($in, $recs, [uint32]$recs.Length, [ref]$n) | Out-Null
  Start-Sleep -Milliseconds $Pause
}
function KeyPair([int]$vk, [char]$ch, [uint32]$state = 0) {
  @([Con]::Key([uint16]$vk, $ch, $true, $state), [Con]::Key([uint16]$vk, $ch, $false, $state))
}
$named = @{
  "tab" = @(9, 9); "enter" = @(13, 13); "esc" = @(27, 27); "space" = @(32, 32); "backspace" = @(8, 8)
  "delete" = @(46, 0); "up" = @(38, 0); "down" = @(40, 0); "left" = @(37, 0); "right" = @(39, 0)
  "pgup" = @(33, 0); "pgdn" = @(34, 0); "home" = @(36, 0); "end" = @(35, 0)
}
$LEFT_CTRL = 8; $LEFT_ALT = 2; $SHIFT = 16

foreach ($step in $Steps.Split(",")) {
  $k = $step.Trim()
  if ($k -eq "") { continue }
  $quietStep = $false
  if ($named.ContainsKey($k)) { Send (KeyPair $named[$k][0] ([char]$named[$k][1])) }
  elseif ($k -eq "shift+tab") { Send (KeyPair 9 ([char]9) $SHIFT) }
  elseif ($k -match '^f(\d+)$') { Send (KeyPair (111 + [int]$Matches[1]) ([char]0)) }
  elseif ($k -eq "q") { Send (KeyPair 81 'q') }
  elseif ($k -match '^t:(.+)$') {
    foreach ($ch in $Matches[1].ToCharArray()) {
      $shift = if ([char]::IsUpper($ch)) { $SHIFT } else { 0 }
      Send (KeyPair ([int][char]::ToUpper($ch)) $ch $shift)
    }
  }
  elseif ($k -match '^ctrl:(.)$') { Send (KeyPair ([int][char]::ToUpper($Matches[1][0])) ([char]([int][char]::ToUpper($Matches[1][0]) - 64)) $LEFT_CTRL) }
  elseif ($k -match '^alt:(.)$') { Send (KeyPair ([int][char]::ToUpper($Matches[1][0])) $Matches[1][0] $LEFT_ALT) }
  elseif ($k -match '^(click|rclick):(\d+):(\d+)$') {
    $x = [int16]$Matches[2]; $y = [int16]$Matches[3]
    $btn = if ($Matches[1] -eq "click") { 1 } else { 2 }
    Send @([Con]::Mouse($x, $y, 0, 1), [Con]::Mouse($x, $y, $btn, 0), [Con]::Mouse($x, $y, 0, 0))
  }
  elseif ($k -match '^move:(\d+):(\d+)$') { Send @([Con]::Mouse([int16]$Matches[1], [int16]$Matches[2], 0, 1)) }
  elseif ($k -match '^wheel:(\d+):(\d+):(-?\d+)$') {
    $x = [int16]$Matches[1]; $y = [int16]$Matches[2]; $n = [int]$Matches[3]
    $delta = if ($n -ge 0) { [uint64]120 } else { [uint64]65416 }  # +-120 in the high word
    for ($i = 0; $i -lt [Math]::Abs($n); $i++) { Send @([Con]::Mouse($x, $y, [uint32]($delta * 65536), 4)) }
  }
  elseif ($k -match '^wait:(\d+)$') { Start-Sleep -Milliseconds ([int]$Matches[1]); $quietStep = $true }
  elseif ($k -eq "dump") { Dump "dump"; continue }
  else { Write-Output "unknown step: $k"; continue }
  if (-not $Quiet -and -not $quietStep) { Dump $k }
}
Start-Sleep -Milliseconds 500
if ($p.HasExited) { Write-Output "EXITED code $($p.ExitCode)" }
else {
  Write-Output "still running"
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
