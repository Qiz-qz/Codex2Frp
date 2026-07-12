'use strict';

const { execFileSync } = require('node:child_process');
const { CodexControlError } = require('../codex/errors');

const NATIVE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class Codex2FrpFocusNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public uint Length;
        public uint Flags;
        public uint ShowCmd;
        public POINT MinPosition;
        public POINT MaxPosition;
        public RECT NormalPosition;
    }

    public sealed class WindowInfo {
        public long Handle { get; set; }
        public long OwnerHandle { get; set; }
        public uint ProcessId { get; set; }
        public string ProcessName { get; set; }
        public string Title { get; set; }
        public bool Visible { get; set; }
    }

    public sealed class PlacementInfo {
        public uint Flags { get; set; }
        public uint ShowCmd { get; set; }
        public string ShowState { get; set; }
        public bool Visible { get; set; }
        public bool Minimized { get; set; }
        public bool Maximized { get; set; }
        public POINT MinPosition { get; set; }
        public POINT MaxPosition { get; set; }
        public RECT NormalPosition { get; set; }
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPlacement(IntPtr hWnd, [In] ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    public static long ForegroundWindow() {
        return GetForegroundWindow().ToInt64();
    }

    public static WindowInfo[] ListWindows() {
        var rows = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr handle, IntPtr state) {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            string processName = "";
            try {
                using (var process = Process.GetProcessById((int)processId)) {
                    processName = process.ProcessName + ".exe";
                }
            } catch {}
            int length = Math.Max(0, GetWindowTextLength(handle));
            var title = new StringBuilder(length + 1);
            if (length > 0) GetWindowText(handle, title, title.Capacity);
            rows.Add(new WindowInfo {
                Handle = handle.ToInt64(),
                OwnerHandle = GetWindow(handle, 4).ToInt64(),
                ProcessId = processId,
                ProcessName = processName,
                Title = title.ToString(),
                Visible = IsWindowVisible(handle)
            });
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }

    public static PlacementInfo GetPlacement(long rawHandle) {
        var handle = new IntPtr(rawHandle);
        var placement = new WINDOWPLACEMENT();
        placement.Length = (uint)Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (!GetWindowPlacement(handle, ref placement)) {
            throw new InvalidOperationException("GetWindowPlacement failed.");
        }
        bool minimized = IsIconic(handle);
        bool maximized = IsZoomed(handle);
        return new PlacementInfo {
            Flags = placement.Flags,
            ShowCmd = placement.ShowCmd,
            ShowState = minimized ? "minimized" : (maximized ? "maximized" : "normal"),
            Visible = IsWindowVisible(handle),
            Minimized = minimized,
            Maximized = maximized,
            MinPosition = placement.MinPosition,
            MaxPosition = placement.MaxPosition,
            NormalPosition = placement.NormalPosition
        };
    }

    public static bool SetPlacement(
        long rawHandle,
        uint flags,
        uint showCmd,
        int minX,
        int minY,
        int maxX,
        int maxY,
        int left,
        int top,
        int right,
        int bottom,
        bool visible
    ) {
        var handle = new IntPtr(rawHandle);
        var placement = new WINDOWPLACEMENT {
            Length = (uint)Marshal.SizeOf(typeof(WINDOWPLACEMENT)),
            Flags = flags,
            ShowCmd = showCmd,
            MinPosition = new POINT { X = minX, Y = minY },
            MaxPosition = new POINT { X = maxX, Y = maxY },
            NormalPosition = new RECT { Left = left, Top = top, Right = right, Bottom = bottom }
        };
        bool placed = SetWindowPlacement(handle, ref placement);
        if (!visible) {
            ShowWindowAsync(handle, 0);
        } else if (!IsWindowVisible(handle)) {
            int command = showCmd == 3 ? 3 : (showCmd == 2 || showCmd == 6 || showCmd == 7 || showCmd == 11 ? 7 : 4);
            ShowWindowAsync(handle, command);
        }
        return placed;
    }

    private static bool ClaimForeground(IntPtr handle, bool restoreWindow) {
        if (!IsWindow(handle)) return false;
        if (restoreWindow) {
            if (IsIconic(handle)) ShowWindow(handle, 9);
            else if (!IsWindowVisible(handle)) ShowWindow(handle, 5);
        }
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
        uint targetThread = GetWindowThreadProcessId(handle, out ignored);
        bool attachedForeground = false;
        bool attachedTarget = false;
        try {
            if (foregroundThread != 0 && foregroundThread != currentThread) {
                attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
            }
            if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
                attachedTarget = AttachThreadInput(currentThread, targetThread, true);
            }
            BringWindowToTop(handle);
            SetActiveWindow(handle);
            SetForegroundWindow(handle);
            return GetForegroundWindow() == handle;
        } finally {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    public static bool Activate(long rawHandle) {
        return ClaimForeground(new IntPtr(rawHandle), true);
    }

    public static bool Focus(long rawHandle) {
        return ClaimForeground(new IntPtr(rawHandle), false);
    }

    public static bool Valid(long rawHandle) {
        return IsWindow(new IntPtr(rawHandle));
    }
}
`;

function buildPowerShellScript(operation, payload) {
  const request = Buffer.from(JSON.stringify({ operation, payload }), 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
${NATIVE_SOURCE}
'@
Add-Type -TypeDefinition $source -Language CSharp | Out-Null
$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}'))
$request = $requestJson | ConvertFrom-Json
$payload = $request.payload
switch ([string]$request.operation) {
  'listTopLevelWindows' {
    $windows = @([Codex2FrpFocusNative]::ListWindows() | ForEach-Object {
      [pscustomobject]@{
        handle = [string]$_.Handle
        ownerHandle = if ($_.OwnerHandle -eq 0) { $null } else { [string]$_.OwnerHandle }
        processId = [int]$_.ProcessId
        processName = [string]$_.ProcessName
        title = [string]$_.Title
        visible = [bool]$_.Visible
      }
    })
    $result = @{ windows = $windows }
  }
  'getForegroundWindow' {
    $result = @{ handle = [string][Codex2FrpFocusNative]::ForegroundWindow() }
  }
  'getWindowPlacement' {
    $placement = [Codex2FrpFocusNative]::GetPlacement([long]$payload.handle)
    $result = @{ placement = @{
      flags = [int]$placement.Flags
      showCmd = [int]$placement.ShowCmd
      showState = [string]$placement.ShowState
      visible = [bool]$placement.Visible
      minimized = [bool]$placement.Minimized
      maximized = [bool]$placement.Maximized
      minPosition = @{ x = [int]$placement.MinPosition.X; y = [int]$placement.MinPosition.Y }
      maxPosition = @{ x = [int]$placement.MaxPosition.X; y = [int]$placement.MaxPosition.Y }
      normalPosition = @{
        left = [int]$placement.NormalPosition.Left
        top = [int]$placement.NormalPosition.Top
        right = [int]$placement.NormalPosition.Right
        bottom = [int]$placement.NormalPosition.Bottom
      }
    } }
  }
  'setWindowPlacement' {
    $placement = $payload.placement
    $ok = [Codex2FrpFocusNative]::SetPlacement(
      [long]$payload.handle,
      [uint32]$placement.flags,
      [uint32]$placement.showCmd,
      [int]$placement.minPosition.x,
      [int]$placement.minPosition.y,
      [int]$placement.maxPosition.x,
      [int]$placement.maxPosition.y,
      [int]$placement.normalPosition.left,
      [int]$placement.normalPosition.top,
      [int]$placement.normalPosition.right,
      [int]$placement.normalPosition.bottom,
      [bool]$placement.visible
    )
    $result = @{ ok = [bool]$ok }
  }
  'activateWindow' {
    $result = @{ ok = [bool][Codex2FrpFocusNative]::Activate([long]$payload.handle) }
  }
  'setForegroundWindow' {
    $result = @{ ok = [bool][Codex2FrpFocusNative]::Focus([long]$payload.handle) }
  }
  'isWindow' {
    $result = @{ ok = [bool][Codex2FrpFocusNative]::Valid([long]$payload.handle) }
  }
  default { throw "Unsupported Win32 focus operation: $($request.operation)" }
}
$result | ConvertTo-Json -Depth 8 -Compress
`;
}

function createPowerShellWin32Runner(options = {}) {
  const platform = options.platform || process.platform;
  const execute = options.execFileSync || execFileSync;
  const powershellPath = options.powershellPath || 'powershell.exe';
  return (operation, payload = {}) => {
    if (platform !== 'win32') {
      throw new CodexControlError(
        'WIN32_FOCUS_UNAVAILABLE',
        'The Win32 focus adapter is available only on Windows.',
        { platform },
      );
    }
    const script = buildPowerShellScript(operation, payload);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let output;
    try {
      output = execute(powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded,
      ], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new CodexControlError(
        'WIN32_FOCUS_BRIDGE_FAILED',
        'The Win32 focus bridge failed.',
        { operation },
        { cause: error },
      );
    }
    const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    try {
      return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    } catch (error) {
      throw new CodexControlError(
        'WIN32_FOCUS_BRIDGE_INVALID_RESPONSE',
        'The Win32 focus bridge returned invalid JSON.',
        { operation },
        { cause: error },
      );
    }
  };
}

function normalizeHandle(value) {
  if (value == null || value === '' || String(value) === '0') return null;
  return String(value);
}

class Win32FocusAdapter {
  constructor(options = {}) {
    this.runner = options.runner || createPowerShellWin32Runner(options);
  }

  listTopLevelWindows() {
    const result = this.runner('listTopLevelWindows', {}) || {};
    return (Array.isArray(result.windows) ? result.windows : []).map(window => ({
      handle: normalizeHandle(window.handle),
      ownerHandle: normalizeHandle(window.ownerHandle),
      processId: Number(window.processId) || 0,
      processName: String(window.processName || ''),
      title: String(window.title || ''),
      visible: window.visible === true,
    })).filter(window => window.handle);
  }

  getForegroundWindow() {
    const result = this.runner('getForegroundWindow', {}) || {};
    return normalizeHandle(result.handle);
  }

  getWindowPlacement(handle) {
    const result = this.runner('getWindowPlacement', { handle: String(handle) }) || {};
    return result.placement ? structuredClone(result.placement) : null;
  }

  setWindowPlacement(handle, placement) {
    const result = this.runner('setWindowPlacement', {
      handle: String(handle),
      placement: structuredClone(placement),
    }) || {};
    return result.ok === true;
  }

  activateWindow(handle) {
    const result = this.runner('activateWindow', { handle: String(handle) }) || {};
    return result.ok === true;
  }

  setForegroundWindow(handle) {
    const result = this.runner('setForegroundWindow', { handle: String(handle) }) || {};
    return result.ok === true;
  }

  isWindow(handle) {
    const result = this.runner('isWindow', { handle: String(handle) }) || {};
    return result.ok === true;
  }
}

module.exports = {
  Win32FocusAdapter,
  buildPowerShellScript,
  createPowerShellWin32Runner,
};
