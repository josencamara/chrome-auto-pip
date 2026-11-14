[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('chrome','vivaldi')][string] $Browser,
    [Parameter(Mandatory)][ValidateRange(0,9)][int] $Digit,
    [ValidateRange(0,2147483647)][int] $BrowserProcessId = 0,
    [ValidateRange(0,3600)][int] $RunSeconds = 0,
    [string] $EventLog
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AutoPipWindowsInput {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyInput {
        public ushort key, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput {
        public int x, y;
        public uint mouseData, flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)] public KeyInput key;
        [FieldOffset(0)] public MouseInput mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input {
        public uint type;
        public InputUnion details;
    }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
    public static uint ForegroundProcess() {
        uint processId;
        GetWindowThreadProcessId(GetForegroundWindow(), out processId);
        return processId;
    }
    public static bool ShortcutKeysDown(int digit) {
        return GetAsyncKeyState(48 + digit) < 0 || GetAsyncKeyState(16) < 0 || GetAsyncKeyState(17) < 0 || GetAsyncKeyState(18) < 0 || GetAsyncKeyState(91) < 0 || GetAsyncKeyState(92) < 0;
    }
    private static Input Key(int key, bool release) {
        return new Input { type = 1, details = new InputUnion {
            key = new KeyInput { key = (ushort)key, flags = release ? 2u : 0u }
        }};
    }
    public static uint Shortcut(int digit) {
        int key = 48 + digit;
        var input = new[] { Key(17,false), Key(16,false), Key(key,false),
            Key(key,true), Key(16,true), Key(17,true) };
        return SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input)));
    }
}
"@
function Write-SwitchEvent($Kind, $ForegroundId, $Sent = $null) {
    if (-not $EventLog) { return }
    [ordered]@{
        at = [DateTime]::UtcNow.ToString('o')
        type = $Kind
        foregroundProcess = $ForegroundId
        sent = $Sent
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $EventLog
}

$mutex = [System.Threading.Mutex]::new($false, "Local\AutoPiP-AppSwitch-${Digit}")
$holdsMutex = $false
try {
    try { $holdsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $holdsMutex = $true }
    if (-not $holdsMutex) { throw "An Auto PiP helper already uses Ctrl+Shift+$Digit." }

    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $previousId = -1
    $sourceProcessId = 0
    $withoutForegroundSince = $null
    $leftAt = $null
    $destination = 0
    $stableSince = 0
    Write-Host "Watching $Browser for app switches. Ctrl+C stops the helper."
    while ($RunSeconds -eq 0 -or $clock.Elapsed.TotalSeconds -lt $RunSeconds) {
        $id = [AutoPipWindowsInput]::ForegroundProcess()
        $now = $clock.ElapsedMilliseconds
        if ($id -eq 0) {
            if ($null -eq $withoutForegroundSince) { $withoutForegroundSince = $now }
            if ($now - $withoutForegroundSince -gt 1500) {
                $sourceProcessId = 0
                $previousId = 0
                $leftAt = $null
            }
            Start-Sleep -Milliseconds 45
            continue
        }
        $withoutForegroundSince = $null
        if ($id -ne $previousId) {
            $process = Get-Process -Id $id -ErrorAction SilentlyContinue
            $isBrowser = $process.ProcessName -eq $Browser -and
                ($BrowserProcessId -eq 0 -or $id -eq $BrowserProcessId)
            if ($isBrowser) {
                $leftAt = $null
                if ($sourceProcessId -eq 0 -or $previousId -ne $sourceProcessId) {
                    Write-SwitchEvent 'browser_focused' $id
                }
                $sourceProcessId = $id
            } elseif ($sourceProcessId -ne 0 -and $previousId -eq $sourceProcessId) {
                $leftAt = $now
            }
            $destination = $id
            $stableSince = $now
            $previousId = $id
        }

        if ($null -ne $leftAt) {
            if ($now - $leftAt -gt 1500) {
                $leftAt = $null
            } elseif ($id -eq $destination -and $now - $stableSince -ge 350 -and
                -not [AutoPipWindowsInput]::ShortcutKeysDown($Digit) -and
                [AutoPipWindowsInput]::ForegroundProcess() -eq $destination) {
                $leftAt = $null
                $source = Get-Process -Id $sourceProcessId -ErrorAction SilentlyContinue
                if ($source.ProcessName -eq $Browser) {
                    $sent = [AutoPipWindowsInput]::Shortcut($Digit)
                    Write-SwitchEvent 'shortcut_sent' $id $sent
                    if ($sent -ne 6) { Write-Warning "Windows accepted only $sent of 6 shortcut events." }
                }
            }
        }
        Start-Sleep -Milliseconds 45
    }
} finally {
    if ($holdsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
