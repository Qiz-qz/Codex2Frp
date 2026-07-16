'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CodexControlError } = require('../codex/errors');

const NATIVE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
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

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
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
    private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);
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

    public static long FocusedWindow() {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return 0;
        uint ignored;
        uint threadId = GetWindowThreadProcessId(foreground, out ignored);
        var info = new GUITHREADINFO { cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO)) };
        return GetGUIThreadInfo(threadId, ref info) ? info.hwndFocus.ToInt64() : 0;
    }

    public static WindowInfo[] ListWindows(uint filterProcessId) {
        var rows = new List<WindowInfo>();
        var processNames = new Dictionary<uint, string>();
        EnumWindows(delegate(IntPtr handle, IntPtr state) {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (filterProcessId != 0 && processId != filterProcessId) return true;
            string processName;
            if (!processNames.TryGetValue(processId, out processName)) {
                processName = "";
                try {
                    using (var process = Process.GetProcessById((int)processId)) {
                        processName = process.ProcessName + ".exe";
                    }
                } catch {}
                processNames[processId] = processName;
            }
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

    public static bool RestoreFocus(long rawHandle) {
        var handle = new IntPtr(rawHandle);
        if (!IsWindow(handle)) return false;
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint currentThread = GetCurrentThreadId();
        uint targetThread = GetWindowThreadProcessId(handle, out ignored);
        bool attached = false;
        try {
            if (targetThread != 0 && targetThread != currentThread) {
                attached = AttachThreadInput(currentThread, targetThread, true);
            }
            SetFocus(handle);
            return FocusedWindow() == handle.ToInt64() && GetForegroundWindow() == foreground;
        } finally {
            if (attached) AttachThreadInput(currentThread, targetThread, false);
        }
    }

    public static bool Valid(long rawHandle) {
        return IsWindow(new IntPtr(rawHandle));
    }
}

public static class Codex2FrpFocusNativeHost {
    private static int ValueStart(string json, string key) {
        int keyIndex = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (keyIndex < 0) throw new InvalidOperationException("Required helper field is unavailable.");
        int colon = json.IndexOf(':', keyIndex + key.Length + 2);
        if (colon < 0) throw new InvalidOperationException("Required helper field is invalid.");
        int index = colon + 1;
        while (index < json.Length && Char.IsWhiteSpace(json[index])) index++;
        return index;
    }

    private static string StringValue(string json, string key) {
        int index = ValueStart(json, key);
        if (index >= json.Length || json[index] != '"') throw new InvalidOperationException("Expected a string helper field.");
        index++;
        var value = new StringBuilder();
        while (index < json.Length) {
            char current = json[index++];
            if (current == '"') return value.ToString();
            if (current != '\\') { value.Append(current); continue; }
            if (index >= json.Length) break;
            char escaped = json[index++];
            switch (escaped) {
                case '"': value.Append('"'); break;
                case '\\': value.Append('\\'); break;
                case '/': value.Append('/'); break;
                case 'b': value.Append('\b'); break;
                case 'f': value.Append('\f'); break;
                case 'n': value.Append('\n'); break;
                case 'r': value.Append('\r'); break;
                case 't': value.Append('\t'); break;
                case 'u':
                    if (index + 4 > json.Length) throw new InvalidOperationException("Invalid Unicode escape.");
                    value.Append((char)Int32.Parse(json.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                    index += 4;
                    break;
                default: throw new InvalidOperationException("Invalid string escape.");
            }
        }
        throw new InvalidOperationException("Unterminated string helper field.");
    }

    private static long LongValue(string json, string key) {
        int index = ValueStart(json, key);
        bool quoted = index < json.Length && json[index] == '"';
        if (quoted) index++;
        int start = index;
        if (index < json.Length && json[index] == '-') index++;
        while (index < json.Length && Char.IsDigit(json[index])) index++;
        if (index == start || (index == start + 1 && json[start] == '-')) throw new InvalidOperationException("Expected an integer helper field.");
        if (quoted && (index >= json.Length || json[index] != '"')) throw new InvalidOperationException("Invalid quoted integer helper field.");
        return Int64.Parse(json.Substring(start, index - start), CultureInfo.InvariantCulture);
    }

    private static long OptionalLongValue(string json, string key, long fallback) {
        return json.IndexOf("\"" + key + "\"", StringComparison.Ordinal) < 0 ? fallback : LongValue(json, key);
    }

    private static bool BoolValue(string json, string key) {
        int index = ValueStart(json, key);
        if (String.CompareOrdinal(json, index, "true", 0, 4) == 0) return true;
        if (String.CompareOrdinal(json, index, "false", 0, 5) == 0) return false;
        throw new InvalidOperationException("Expected a boolean helper field.");
    }

    private static string ObjectValue(string json, string key) {
        int start = ValueStart(json, key);
        if (start >= json.Length || json[start] != '{') throw new InvalidOperationException("Expected an object helper field.");
        int depth = 0;
        bool quoted = false;
        bool escaped = false;
        for (int index = start; index < json.Length; index++) {
            char current = json[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (current == '\\') escaped = true;
                else if (current == '"') quoted = false;
                continue;
            }
            if (current == '"') quoted = true;
            else if (current == '{') depth++;
            else if (current == '}' && --depth == 0) return json.Substring(start, index - start + 1);
        }
        throw new InvalidOperationException("Unterminated object helper field.");
    }

    private static string JsonString(string value) {
        var output = new StringBuilder("\"");
        foreach (char current in value ?? "") {
            switch (current) {
                case '"': output.Append("\\\""); break;
                case '\\': output.Append("\\\\"); break;
                case '\b': output.Append("\\b"); break;
                case '\f': output.Append("\\f"); break;
                case '\n': output.Append("\\n"); break;
                case '\r': output.Append("\\r"); break;
                case '\t': output.Append("\\t"); break;
                default:
                    if (current < 32) output.Append("\\u" + ((int)current).ToString("x4", CultureInfo.InvariantCulture));
                    else output.Append(current);
                    break;
            }
        }
        return output.Append('"').ToString();
    }

    private static string BoolJson(bool value) { return value ? "true" : "false"; }
    private static string Number(long value) { return value.ToString(CultureInfo.InvariantCulture); }
    private static string HandleResult(long handle) { return "{\"handle\":" + JsonString(Number(handle)) + "}"; }
    private static string OkResult(bool ok) { return "{\"ok\":" + BoolJson(ok) + "}"; }

    private static string Dispatch(string json) {
        string operation = StringValue(json, "operation");
        switch (operation) {
            case "__health":
                return OkResult(true);
            case "listTopLevelWindows": {
                var result = new StringBuilder("{\"windows\":[");
                bool first = true;
                long rawProcessId = OptionalLongValue(json, "processId", 0);
                if (rawProcessId < 0 || rawProcessId > UInt32.MaxValue) throw new InvalidOperationException("Invalid process filter.");
                foreach (var window in Codex2FrpFocusNative.ListWindows((uint)rawProcessId)) {
                    if (!first) result.Append(',');
                    first = false;
                    result.Append("{\"handle\":").Append(JsonString(Number(window.Handle)))
                        .Append(",\"ownerHandle\":").Append(window.OwnerHandle == 0 ? "null" : JsonString(Number(window.OwnerHandle)))
                        .Append(",\"processId\":").Append(Number(window.ProcessId))
                        .Append(",\"processName\":").Append(JsonString(window.ProcessName))
                        .Append(",\"title\":").Append(JsonString(window.Title))
                        .Append(",\"visible\":").Append(BoolJson(window.Visible)).Append('}');
                }
                return result.Append("]}").ToString();
            }
            case "getForegroundWindow":
                return HandleResult(Codex2FrpFocusNative.ForegroundWindow());
            case "getFocusedWindow":
                return HandleResult(Codex2FrpFocusNative.FocusedWindow());
            case "getWindowPlacement": {
                var placement = Codex2FrpFocusNative.GetPlacement(LongValue(json, "handle"));
                return "{\"placement\":{\"flags\":" + Number(placement.Flags)
                    + ",\"showCmd\":" + Number(placement.ShowCmd)
                    + ",\"showState\":" + JsonString(placement.ShowState)
                    + ",\"visible\":" + BoolJson(placement.Visible)
                    + ",\"minimized\":" + BoolJson(placement.Minimized)
                    + ",\"maximized\":" + BoolJson(placement.Maximized)
                    + ",\"minPosition\":{\"x\":" + Number(placement.MinPosition.X) + ",\"y\":" + Number(placement.MinPosition.Y) + "}"
                    + ",\"maxPosition\":{\"x\":" + Number(placement.MaxPosition.X) + ",\"y\":" + Number(placement.MaxPosition.Y) + "}"
                    + ",\"normalPosition\":{\"left\":" + Number(placement.NormalPosition.Left) + ",\"top\":" + Number(placement.NormalPosition.Top)
                    + ",\"right\":" + Number(placement.NormalPosition.Right) + ",\"bottom\":" + Number(placement.NormalPosition.Bottom) + "}}}";
            }
            case "setWindowPlacement": {
                string placement = ObjectValue(json, "placement");
                string min = ObjectValue(placement, "minPosition");
                string max = ObjectValue(placement, "maxPosition");
                string normal = ObjectValue(placement, "normalPosition");
                var ok = Codex2FrpFocusNative.SetPlacement(
                    LongValue(json, "handle"),
                    Convert.ToUInt32(LongValue(placement, "flags")),
                    Convert.ToUInt32(LongValue(placement, "showCmd")),
                    Convert.ToInt32(LongValue(min, "x")), Convert.ToInt32(LongValue(min, "y")),
                    Convert.ToInt32(LongValue(max, "x")), Convert.ToInt32(LongValue(max, "y")),
                    Convert.ToInt32(LongValue(normal, "left")), Convert.ToInt32(LongValue(normal, "top")),
                    Convert.ToInt32(LongValue(normal, "right")), Convert.ToInt32(LongValue(normal, "bottom")),
                    BoolValue(placement, "visible")
                );
                return OkResult(ok);
            }
            case "activateWindow":
                return OkResult(Codex2FrpFocusNative.Activate(LongValue(json, "handle")));
            case "setForegroundWindow":
                return OkResult(Codex2FrpFocusNative.Focus(LongValue(json, "handle")));
            case "setFocusedWindow":
                return OkResult(Codex2FrpFocusNative.RestoreFocus(LongValue(json, "handle")));
            case "isWindow":
                return OkResult(Codex2FrpFocusNative.Valid(LongValue(json, "handle")));
            default:
                throw new InvalidOperationException("Unsupported Win32 focus operation.");
        }
    }

    public static int Main() {
        try {
            Console.Out.Write(Dispatch(Console.In.ReadToEnd()));
            return 0;
        } catch {
            Console.Error.Write("The Win32 focus helper failed.");
            return 1;
        }
    }
}
`;

const NATIVE_SOURCE_HASH = crypto.createHash('sha256').update(NATIVE_SOURCE, 'utf8').digest('hex');

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildNativeAssemblyScript(assemblyPath) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$assemblyPath = ${quotePowerShellLiteral(assemblyPath)}
$parent = Split-Path -Parent $assemblyPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) {
  $source = @'
${NATIVE_SOURCE}
'@
  $tempPath = Join-Path $parent ('.' + [IO.Path]::GetFileName($assemblyPath) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp.exe')
  try {
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $tempPath -OutputType ConsoleApplication | Out-Null
    try {
      Move-Item -LiteralPath $tempPath -Destination $assemblyPath -ErrorAction Stop
    } catch {
      if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) { throw }
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
      Remove-Item -LiteralPath $tempPath -Force
    }
  }
}
`;
}

function createPowerShellWin32Runner(options = {}) {
  const platform = options.platform || process.platform;
  const execute = options.execFileSync || execFileSync;
  const existsSync = options.existsSync || fs.existsSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const unlinkSync = options.unlinkSync || fs.unlinkSync;
  const powershellPath = options.powershellPath || 'powershell.exe';
  const runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), '.runtime', 'win32-focus'));
  const helperPath = path.join(runtimeDir, `Codex2FrpFocusNative-${NATIVE_SOURCE_HASH}.exe`);
  let assemblyReady = false;

  function invokePowerShell(script) {
    return execute(powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '$input | Out-String | Invoke-Expression',
    ], {
      encoding: 'utf8',
      input: script,
      windowsHide: false,
      shell: false,
      maxBuffer: 1024 * 1024,
    });
  }

  function invokeNativeHelper(operation, payload = {}) {
    return execute(helperPath, [], {
      encoding: 'utf8',
      input: JSON.stringify({ operation, payload }),
      windowsHide: false,
      shell: false,
      maxBuffer: 1024 * 1024,
    });
  }

  function parseNativeOutput(output) {
    const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  }

  function ensureNativeAssembly() {
    if (assemblyReady) return;
    try {
      mkdirSync(runtimeDir, { recursive: true });
      if (existsSync(helperPath)) {
        try {
          const health = parseNativeOutput(invokeNativeHelper('__health', {}));
          if (!health || health.ok !== true) throw new Error('The Win32 focus helper health check failed.');
          assemblyReady = true;
          return;
        } catch {
          unlinkSync(helperPath);
        }
      }
      invokePowerShell(buildNativeAssemblyScript(helperPath));
      if (!existsSync(helperPath)) {
        throw new Error('The native bridge compiler did not produce the expected helper.');
      }
      const health = parseNativeOutput(invokeNativeHelper('__health', {}));
      if (!health || health.ok !== true) throw new Error('The Win32 focus helper health check failed.');
      assemblyReady = true;
    } catch (error) {
      throw new CodexControlError(
        'WIN32_FOCUS_ASSEMBLY_FAILED',
        'The Win32 focus native bridge could not be prepared.',
        { nativeSourceHash: NATIVE_SOURCE_HASH },
        { cause: error },
      );
    }
  }

  return (operation, payload = {}) => {
    if (platform !== 'win32') {
      throw new CodexControlError(
        'WIN32_FOCUS_UNAVAILABLE',
        'The Win32 focus adapter is available only on Windows.',
        { platform },
      );
    }
    ensureNativeAssembly();
    let output;
    try {
      output = invokeNativeHelper(operation, payload);
    } catch (error) {
      throw new CodexControlError(
        'WIN32_FOCUS_BRIDGE_FAILED',
        'The Win32 focus bridge failed.',
        { operation },
        { cause: error },
      );
    }
    try {
      return parseNativeOutput(output);
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

  listTopLevelWindows(filter) {
    const rawProcessId = filter && filter.processId;
    if (rawProcessId != null && (
      !Number.isSafeInteger(Number(rawProcessId))
      || Number(rawProcessId) <= 0
      || Number(rawProcessId) > 0xffff_ffff
    )) {
      throw new TypeError('The Win32 window process filter must be a positive safe integer.');
    }
    const processId = rawProcessId == null ? 0 : Number(rawProcessId);
    const result = this.runner('listTopLevelWindows', { processId }) || {};
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

  getFocusedWindow() {
    const result = this.runner('getFocusedWindow', {}) || {};
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

  setFocusedWindow(handle) {
    const result = this.runner('setFocusedWindow', { handle: String(handle) }) || {};
    return result.ok === true;
  }

  isWindow(handle) {
    const result = this.runner('isWindow', { handle: String(handle) }) || {};
    return result.ok === true;
  }
}

module.exports = {
  NATIVE_SOURCE_HASH,
  Win32FocusAdapter,
  buildNativeAssemblyScript,
  createPowerShellWin32Runner,
};
