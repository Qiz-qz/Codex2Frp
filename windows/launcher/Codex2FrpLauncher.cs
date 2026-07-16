using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Codex2FrpLauncher
{
    internal static class Program
    {
        internal const string AppDisplayName = "Codex2Frp";
        internal const string AppVersion = "1.4.2";
        internal const int ServicePort = 8988;
        internal const string ServicePortDisplay = "8988";
        internal const string DefaultSakuraDomain = "";
        internal const string DefaultSakuraTunnelId = "";
        internal const string DefaultSakuraRemotePort = "";
        internal const string RemoteUnavailableMessage = "远程连接网络未启动，当前仅支持局域网连接。";
        internal const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex2Frp";
        private const string LegacyUninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex2Frp";

        [STAThread]
        private static int Main(string[] args)
        {
            string projectRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            bool selfTest = HasArg(args, "--self-test");
            bool uninstall = HasArg(args, "--uninstall");
            bool silent = HasArg(args, "--silent");
            bool startService = HasArg(args, "--start-service");
            bool stopService = HasArg(args, "--stop-service");
            bool silentAutomation = silent || stopService;
            TryEnableDpiAwareness();

            if (uninstall) return Uninstall(projectRoot, silent);
            if (selfTest) return SelfTest(projectRoot);
            if (startService && !silentAutomation) return StartServiceAndShowPanel(projectRoot);
            if (startService || stopService) return RunServiceAutomation(projectRoot, startService, stopService);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                using (var form = new ControlPanelForm(projectRoot))
                {
                    Application.Run(form);
                }
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, AppDisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static int StartServiceAndShowPanel(string projectRoot)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                using (var form = new ControlPanelForm(projectRoot))
                {
                    form.StartServiceForAutomation();
                    Application.Run(form);
                }
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, AppDisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                WriteAutomationError(projectRoot, ex);
                return 1;
            }
        }

        private static int RunServiceAutomation(string projectRoot, bool startService, bool stopService)
        {
            int exitCode = 0;
            try
            {
                using (var form = new ControlPanelForm(projectRoot))
                {
                    if (stopService) form.StopServiceForAutomation();
                    if (startService) form.StartServiceForAutomation();
                }
            }
            catch (Exception ex)
            {
                WriteAutomationError(projectRoot, ex);
                exitCode = 1;
            }
            Environment.Exit(exitCode);
            return exitCode;
        }

        private static bool HasArg(string[] args, string expected)
        {
            return args != null && args.Any(arg => string.Equals(arg, expected, StringComparison.OrdinalIgnoreCase));
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static void TryEnableDpiAwareness()
        {
            // The launcher uses WinForms table layouts and should scale as one surface.
            // Forcing process DPI awareness can make the window bounds and control layout
            // use different coordinate systems on high-DPI desktops, clipping Chinese text.
        }

        private static void WriteAutomationError(string projectRoot, Exception ex)
        {
            try
            {
                string runtimeDir = Path.Combine(projectRoot, ".runtime");
                Directory.CreateDirectory(runtimeDir);
                File.WriteAllText(Path.Combine(runtimeDir, "launcher-automation.err.log"), ex.ToString(), Encoding.UTF8);
            }
            catch { }
        }

        private static int SelfTest(string projectRoot)
        {
            try
            {
                var runtime = new RuntimePaths(projectRoot);
                runtime.Ensure();
                if (!File.Exists(runtime.ServerScript)) return 2;
                string node = runtime.FindNodeExe();
                if (!File.Exists(node)) return 3;
                runtime.GetOrCreateMobileToken();
                return 0;
            }
            catch
            {
                return 1;
            }
        }

        private static int Uninstall(string installDir, bool silent)
        {
            if (!silent)
            {
                DialogResult answer = MessageBox.Show(
                    "将卸载 Codex2Frp，并删除安装目录中的程序文件。\n\n本地运行状态和日志会随安装目录一并删除，是否继续？",
                    "Codex2Frp 卸载",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning
                );
                if (answer != DialogResult.Yes) return 0;
            }

            try
            {
                StopRelatedProcesses(installDir);
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppDisplayName);
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppDisplayName);
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Codex2Frp");
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Codex2Frp");
                try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKeyPath, false); } catch { }
                try { Registry.CurrentUser.DeleteSubKeyTree(LegacyUninstallKeyPath, false); } catch { }

                var cleanup = new ProcessStartInfo
                {
                    FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                    Arguments = "/c ping 127.0.0.1 -n 3 > nul & rd /s /q " + Quote(installDir),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = Path.GetTempPath()
                };
                Process.Start(cleanup);

                if (!silent) MessageBox.Show("Codex2Frp 已卸载。", "Codex2Frp 卸载", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            catch (Exception ex)
            {
                if (!silent) MessageBox.Show(ex.Message, "Codex2Frp 卸载", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static void DeleteShortcut(string folder, string displayName)
        {
            try
            {
                string path = Path.Combine(folder, displayName + ".lnk");
                if (File.Exists(path)) File.Delete(path);
            }
            catch { }
        }

        internal static void StopRelatedProcesses(string installDir, bool includePowerShell = true)
        {
            string fullInstallDir = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Replace('/', '\\');
            int selfId = Process.GetCurrentProcess().Id;
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (process.Id == selfId) continue;
                    string name = process.ProcessName ?? string.Empty;
                    if (!CouldBeRelatedProcess(name)) continue;
                    string commandLine = GetCommandLine(process);
                    if (IsPowerShellProcess(name) && (!includePowerShell || !IsKnownCodexPowerShell(commandLine))) continue;
                    string executable = string.Empty;
                    try { executable = process.MainModule == null ? string.Empty : process.MainModule.FileName; } catch { }
                    if (IsNodeProcess(name) && !IsKnownCodexNode(commandLine, executable, fullInstallDir)) continue;
                    string haystack = (executable + "\n" + commandLine).Replace('/', '\\');
                    if (haystack.IndexOf(fullInstallDir, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    KillProcess(process);
                }
                catch { }
            }
        }

        internal static void StopKnownPortOwners(int port, string installDir)
        {
            foreach (int processId in GetTcpListeningProcessIds(port))
            {
                try
                {
                    Process process = Process.GetProcessById(processId);
                    if (!LooksLikeCodexServerProcess(process, installDir)) continue;
                    KillProcess(process);
                }
                catch { }
            }
        }

        internal static bool IsOwnedBackendProcess(Process process, string installDir)
        {
            return process != null && LooksLikeCodexServerProcess(process, installDir);
        }

        private static bool LooksLikeCodexServerProcess(Process process, string installDir)
        {
            string name = process.ProcessName ?? string.Empty;
            if (!CouldBeRelatedProcess(name)) return false;

            string fullInstallDir = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Replace('/', '\\');
            string commandLine = GetCommandLine(process);
            string executable = string.Empty;
            try { executable = process.MainModule == null ? string.Empty : process.MainModule.FileName; } catch { }
            string haystack = (executable + "\n" + commandLine).Replace('/', '\\');

            if (haystack.IndexOf(fullInstallDir, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (haystack.IndexOf("\\Codex2Frp\\", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (haystack.IndexOf("\\Codex2Frp\\", StringComparison.OrdinalIgnoreCase) >= 0) return true;

            bool isNode = name.Equals("node", StringComparison.OrdinalIgnoreCase) || name.Equals("node.exe", StringComparison.OrdinalIgnoreCase);
            return isNode && IsCodex2FrpNodeCommand(commandLine) &&
                haystack.IndexOf("\\.runtime\\node", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        internal static int[] GetTcpListeningProcessIds(int port)
        {
            try
            {
                string netstat = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "netstat.exe");
                var info = new ProcessStartInfo
                {
                    FileName = File.Exists(netstat) ? netstat : "netstat.exe",
                    Arguments = "-ano -p tcp",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8
                };
                using (Process process = Process.Start(info))
                {
                    if (process == null) return new int[0];
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(5000);
                    return output
                        .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                        .Select(line => TryParseListeningPid(line, port))
                        .Where(pid => pid > 0)
                        .Distinct()
                        .ToArray();
                }
            }
            catch
            {
                return new int[0];
            }
        }

        private static int TryParseListeningPid(string line, int port)
        {
            string[] parts = (line ?? string.Empty).Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5) return 0;
            if (!parts[0].Equals("TCP", StringComparison.OrdinalIgnoreCase)) return 0;
            if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) return 0;
            string localAddress = parts[1];
            if (!localAddress.EndsWith(":" + port, StringComparison.OrdinalIgnoreCase)) return 0;
            int pid;
            return int.TryParse(parts[4], out pid) ? pid : 0;
        }

        internal static void KillProcess(Process process)
        {
            if (process == null) return;
            if (process.Id == Process.GetCurrentProcess().Id) return;
            try
            {
                if (!process.HasExited) process.Kill();
                process.WaitForExit(5000);
            }
            catch { }
        }

        private static bool CouldBeRelatedProcess(string processName)
        {
            string name = processName ?? string.Empty;
            return
                name.Equals("node", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("node.exe", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("powershell", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp.exe", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp.exe", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsPowerShellProcess(string processName)
        {
            string name = processName ?? string.Empty;
            return name.Equals("powershell", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsNodeProcess(string processName)
        {
            string name = processName ?? string.Empty;
            return name.Equals("node", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("node.exe", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsKnownCodexNode(string commandLine, string executable, string fullInstallDir)
        {
            string haystack = ((executable ?? string.Empty) + "\n" + (commandLine ?? string.Empty)).Replace('/', '\\');
            if (haystack.IndexOf(fullInstallDir, StringComparison.OrdinalIgnoreCase) < 0) return false;
            return IsCodex2FrpNodeCommand(commandLine) ||
                haystack.IndexOf("\\.runtime\\node", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool IsCodex2FrpNodeCommand(string commandLine)
        {
            string value = commandLine ?? string.Empty;
            return value.IndexOf("server.js", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("server-log-bootstrap.js", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool IsKnownCodexPowerShell(string commandLine)
        {
            string value = commandLine ?? string.Empty;
            return value.IndexOf("windows-wpf-control-panel.ps1", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("open-windows-control-panel.cmd", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("start-windows-local.ps1", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("launch-main-codex-cdp.ps1", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        internal static string GetCommandLine(Process process)
        {
            try
            {
                using (var searcher = new System.Management.ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + process.Id))
                {
                    foreach (System.Management.ManagementObject item in searcher.Get())
                    {
                        return Convert.ToString(item["CommandLine"]) ?? string.Empty;
                    }
                }
            }
            catch { }
            return string.Empty;
        }

        internal static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }
    }

    internal sealed class RuntimePaths
    {
        public readonly string ProjectRoot;
        public readonly string RuntimeDir;
        public readonly string NodeDir;
        public readonly string NodeDownloadDir;
        public readonly string PidPath;
        public readonly string TokenPath;
        public readonly string StdoutPath;
        public readonly string StderrPath;
        public readonly string ServerScript;

        public RuntimePaths(string projectRoot)
        {
            ProjectRoot = projectRoot;
            RuntimeDir = Path.Combine(ProjectRoot, ".runtime");
            NodeDir = Path.Combine(RuntimeDir, "node");
            NodeDownloadDir = Path.Combine(RuntimeDir, "node-download");
            PidPath = Path.Combine(RuntimeDir, "server.pid");
            TokenPath = Path.Combine(RuntimeDir, "mobile-token.txt");
            StdoutPath = Path.Combine(RuntimeDir, "server.out.log");
            StderrPath = Path.Combine(RuntimeDir, "server.err.log");
            ServerScript = Path.Combine(ProjectRoot, "server.js");
        }

        public void Ensure()
        {
            Directory.CreateDirectory(RuntimeDir);
        }

        public string GetOrCreateMobileToken()
        {
            Ensure();
            try
            {
                if (File.Exists(TokenPath))
                {
                    string existing = File.ReadAllText(TokenPath, Encoding.ASCII).Trim();
                    if (existing.Length >= 16) return existing;
                }
            }
            catch { }

            byte[] bytes = new byte[18];
            using (var rng = new RNGCryptoServiceProvider())
            {
                rng.GetBytes(bytes);
            }
            string token = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            File.WriteAllText(TokenPath, token, Encoding.ASCII);
            return token;
        }

        public string FindNodeExe()
        {
            string direct = Path.Combine(NodeDir, "node.exe");
            if (IsNodeExe(direct)) return direct;
            string bin = Path.Combine(ProjectRoot, "bin", "node", "node.exe");
            if (IsNodeExe(bin)) return bin;
            if (Directory.Exists(NodeDownloadDir))
            {
                foreach (string file in Directory.GetFiles(NodeDownloadDir, "node.exe", SearchOption.AllDirectories))
                {
                    if (IsNodeExe(file)) return file;
                }
            }
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (string folder in pathEnv.Split(Path.PathSeparator))
            {
                try
                {
                    string candidate = Path.Combine(folder.Trim(), "node.exe");
                    if (IsNodeExe(candidate)) return candidate;
                }
                catch { }
            }
            throw new FileNotFoundException("没有找到可用的 Node.js 运行时。请重新安装 Codex2Frp。");
        }

        private static bool IsNodeExe(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return false;
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = path,
                    Arguments = "--version",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var process = Process.Start(info))
                {
                    if (process == null) return false;
                    string version = process.StandardOutput.ReadLine() ?? string.Empty;
                    process.WaitForExit(5000);
                    return process.ExitCode == 0 && version.StartsWith("v", StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }
    }

    internal sealed class ControlPanelForm : Form
    {
        private readonly RuntimePaths _paths;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly Label _statusLabel;
        private readonly Label _subStatusLabel;
        private readonly TextBox _urlBox;
        private readonly TextBox _domainBox;
        private readonly TextBox _tunnelIdBox;
        private readonly TextBox _remotePortBox;
        private readonly TextBox _detailsBox;
        private readonly Button _startButton;
        private readonly Button _stopButton;
        private readonly Button _saveSakuraButton;
        private readonly Button _editSakuraButton;
        private readonly ProgressBar _activityBar;
        private readonly Color _accent = Color.FromArgb(139, 246, 184);
        private readonly Color _accentDeep = Color.FromArgb(18, 72, 48);
        private readonly Color _danger = Color.FromArgb(247, 118, 142);
        private readonly Color _bg = Color.FromArgb(9, 11, 13);
        private readonly Color _card = Color.FromArgb(25, 28, 31);
        private readonly Color _cardSoft = Color.FromArgb(32, 36, 40);
        private readonly Color _border = Color.FromArgb(64, 71, 78);
        private readonly Color _ink = Color.FromArgb(245, 247, 250);
        private readonly Color _muted = Color.FromArgb(168, 176, 186);
        private readonly Color _panel = Color.FromArgb(18, 21, 24);
        private bool _busy;
        private bool _exitConfirmed;
        private bool _controlWarningShown;
        private bool _sakuraFormFromCache;
        private bool _sakuraFormEditMode;
        private int _statusRefreshInFlight;
        private int _statusRefreshAgain;
        private string _lastRemoteUnavailableNoticeKey = "";

        public ControlPanelForm(string projectRoot)
        {
            _paths = new RuntimePaths(projectRoot);
            _paths.Ensure();
            _paths.GetOrCreateMobileToken();

            Text = Program.AppDisplayName + " v" + Program.AppVersion;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            MinimumSize = new Size(920, 680);
            ClientSize = new Size(1120, 760);
            BackColor = _bg;
            Font = new Font("Segoe UI", 10F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var shell = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.White,
                Padding = new Padding(0)
            };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 76F));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            Controls.Add(shell);

            var header = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(19, 31, 36)
            };
            var title = new Label
            {
                Text = "Codex2Frp",
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 17F, FontStyle.Bold),
                AutoSize = false,
                Location = new Point(24, 10),
                Size = new Size(220, 32)
            };
            var subtitle = new Label
            {
                Text = "本机 Codex 服务与远程链接访问面板",
                ForeColor = Color.FromArgb(190, 221, 216),
                AutoSize = false,
                Location = new Point(26, 44),
                Size = new Size(440, 24)
            };
            _statusLabel = new Label
            {
                Text = "正在读取状态…",
                ForeColor = Color.White,
                TextAlign = ContentAlignment.MiddleRight,
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
                AutoSize = false,
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                Location = new Point(440, 14),
                Size = new Size(190, 24)
            };
            _subStatusLabel = new Label
            {
                Text = "",
                ForeColor = Color.FromArgb(190, 221, 216),
                TextAlign = ContentAlignment.MiddleRight,
                AutoSize = false,
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                Location = new Point(330, 42),
                Size = new Size(300, 22)
            };
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            header.Controls.Add(_statusLabel);
            header.Controls.Add(_subStatusLabel);
            shell.Controls.Add(header, 0, 0);

            var main = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(16, 18, 16, 16),
                BackColor = Color.White,
                AutoScroll = true
            };
            shell.Controls.Add(main, 0, 1);

            var urlLabel = Caption("当前本机链接", 0, 0, 180);
            _urlBox = new TextBox
            {
                Location = new Point(0, 28),
                Width = 660,
                Height = 28,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                ReadOnly = true,
                BorderStyle = BorderStyle.FixedSingle
            };
            main.Controls.Add(urlLabel);
            main.Controls.Add(_urlBox);

            int y = 70;
            _startButton = PrimaryButton("启动服务", 0, y, 112);
            _stopButton = SecondaryButton("停止服务", 124, y, 112);
            var openButton = SecondaryButton("打开本机页面", 248, y, 132);
            var copyLocalButton = SecondaryButton("复制本机链接", 0, y + 42, 132);
            var copyLanButton = SecondaryButton("复制局域网链接", 144, y + 42, 144);
            var copySakuraButton = SecondaryButton("复制远程链接", 300, y + 42, 150);
            main.Controls.AddRange(new Control[] { _startButton, _stopButton, openButton, copyLocalButton, copyLanButton, copySakuraButton });

            var sakura = new GroupBox
            {
                Text = "远程链接访问",
                ForeColor = _ink,
                Location = new Point(0, 160),
                Size = new Size(660, 126),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                BackColor = _panel
            };
            main.Controls.Add(sakura);

            sakura.Controls.Add(Caption("子域名", 18, 30, 72));
            _domainBox = Input(90, 26, 340, Program.DefaultSakuraDomain);
            sakura.Controls.Add(_domainBox);
            _tunnelIdBox = Input(0, 0, 1, Program.DefaultSakuraTunnelId);
            _tunnelIdBox.Visible = false;
            sakura.Controls.Add(Caption("远程端口", 445, 30, 76));
            _remotePortBox = Input(525, 26, 105, Program.DefaultSakuraRemotePort);
            sakura.Controls.Add(_remotePortBox);

            _editSakuraButton = SecondaryButton("修改表单", 18, 68, 104);
            sakura.Controls.Add(_editSakuraButton);
            _saveSakuraButton = PrimaryButton("保存并检查", 134, 68, 130);
            sakura.Controls.Add(_saveSakuraButton);
            var help = new Label
            {
                Text = "填写远程访问链接或子域名和公网端口；保存时会检查远程链接是否可访问。",
                Location = new Point(282, 68),
                Size = new Size(356, 36),
                ForeColor = _muted,
                BackColor = _panel
            };
            sakura.Controls.Add(help);

            var toolsY = 304;
            var cdpButton = SecondaryButton("启用 Codex 控制", 0, toolsY, 152);
            var logsButton = SecondaryButton("打开日志目录", 156, toolsY, 132);
            var refreshButton = SecondaryButton("刷新状态", 300, toolsY, 112);
            main.Controls.AddRange(new Control[] { cdpButton, logsButton, refreshButton });

            _detailsBox = new TextBox
            {
                Location = new Point(0, 352),
                Size = new Size(660, 150),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
                Multiline = true,
                ScrollBars = ScrollBars.Vertical,
                ReadOnly = true,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9F),
                BackColor = Color.FromArgb(250, 251, 252)
            };
            main.Controls.Add(_detailsBox);

            var footer = new Label
            {
                Text = "Codex2Frp v" + Program.AppVersion + " · Qiz · 移动端桥接套件",
                ForeColor = _muted,
                AutoSize = false,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
                Location = new Point(0, 542),
                Size = new Size(660, 24)
            };
            main.Controls.Add(footer);

            _startButton.Click += delegate { BeginStartServer(); };
            _stopButton.Click += delegate { RunBackgroundUiAction(StopServer, "正在停止服务，请稍候..."); };
            openButton.Click += delegate { RunBackgroundUiAction(delegate { EnsureServerRunning(); Process.Start(GetLocalUrl()); }, "正在打开本机控制台..."); };
            copyLocalButton.Click += delegate { RunUiAction(delegate { Clipboard.SetText(GetLocalUrl()); }); };
            copyLanButton.Click += delegate { RunUiAction(delegate { Clipboard.SetText(GetLanUrlOrThrow()); }); };
            copySakuraButton.Click += delegate
            {
                string remoteUrl = string.Empty;
                RunBackgroundUiAction(delegate { remoteUrl = GetSakuraUrl(); }, "正在检查远程链接...", delegate
                {
                    Clipboard.SetText(remoteUrl);
                    _detailsBox.Text = "远程链接已复制。" + Environment.NewLine + Environment.NewLine + remoteUrl;
                });
            };
            logsButton.Click += delegate { RunUiAction(delegate { _paths.Ensure(); Process.Start(_paths.RuntimeDir); }); };
            refreshButton.Click += delegate { UpdateModernStatus(); };
            cdpButton.Click += delegate { StartCodexCdp(); };
            _saveSakuraButton.Click += delegate { RunUiAction(SaveSakuraConfig); };
            _editSakuraButton.Click += delegate { RunUiAction(UnlockSakuraFormForEdit); };

            _activityBar = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 32,
                Visible = false,
                Height = 6,
                Dock = DockStyle.Bottom
            };

            ApplyModernResponsiveLayout(openButton, copyLocalButton, copyLanButton, copySakuraButton, cdpButton, logsButton, refreshButton);

            _timer = new System.Windows.Forms.Timer { Interval = 4000 };
            _timer.Tick += delegate { UpdateModernStatus(); };
            _timer.Start();
            Shown += delegate { EnsureReadableWindowBounds(); UpdateModernStatus(); };
        }

        private void EnsureReadableWindowBounds()
        {
            Rectangle area = Screen.FromControl(this).WorkingArea;
            int targetWidth = Math.Min(1120, Math.Max(920, area.Width - 48));
            int targetHeight = Math.Min(760, Math.Max(680, area.Height - 48));
            if (Width < targetWidth || Height < targetHeight)
            {
                Size = new Size(Math.Max(Width, targetWidth), Math.Max(Height, targetHeight));
            }
            Left = Math.Max(area.Left + 24, Math.Min(Left, area.Right - Width - 24));
            Top = Math.Max(area.Top + 24, Math.Min(Top, area.Bottom - Height - 24));
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_exitConfirmed && ShouldPromptForClose(e.CloseReason))
            {
                DialogResult answer = MessageBox.Show(
                    this,
                    "是否退出 Codex2Frp 并关闭所有后端进程？\r\n\r\n选择“是”将停止本机后端、Codex 控制辅助进程和相关隐藏进程；选择“否”仅最小化到任务栏，后端继续运行。",
                    "退出 Codex2Frp",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2
                );

                if (answer != DialogResult.Yes)
                {
                    e.Cancel = true;
                    MinimizeToTaskbar();
                    return;
                }

                _exitConfirmed = true;
                SetBusy("正在关闭后端进程...");
                ShutdownAllProcessesForExit();
                SetBusy(string.Empty);
            }

            try { _timer.Stop(); } catch { }
            base.OnFormClosing(e);
        }

        private static bool ShouldPromptForClose(CloseReason reason)
        {
            return reason == CloseReason.UserClosing ||
                reason == CloseReason.None ||
                reason == CloseReason.TaskManagerClosing;
        }

        private void MinimizeToTaskbar()
        {
            ShowInTaskbar = true;
            Visible = true;
            WindowState = FormWindowState.Minimized;
        }

        private void ApplyModernResponsiveLayout(Button openButton, Button copyLocalButton, Button copyLanButton, Button copySakuraButton, Button cdpButton, Button logsButton, Button refreshButton)
        {
            Controls.Clear();

            _startButton.Text = "启动服务";
            _stopButton.Text = "停止服务";
            openButton.Text = "打开页面";
            copyLocalButton.Text = "复制本机";
            copyLanButton.Text = "复制局域网";
            copySakuraButton.Text = "复制远程";
            cdpButton.Text = "启用 Codex 控制";
            logsButton.Text = "打开日志目录";
            refreshButton.Text = "刷新状态";
            _saveSakuraButton.Text = "保存并检查";
            _editSakuraButton.Text = "修改表单";

            var shell = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = _bg,
                Padding = new Padding(0)
            };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 94F));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            Controls.Add(shell);

            shell.Controls.Add(BuildModernHeader(), 0, 0);
            shell.Controls.Add(BuildModernMainPanel(openButton, copyLocalButton, copyLanButton, copySakuraButton, cdpButton, logsButton, refreshButton), 0, 1);
        }

        private Control BuildModernHeader()
        {
            var header = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(12, 15, 18),
                ColumnCount = 2,
                RowCount = 1,
                Padding = new Padding(24, 14, 24, 12)
            };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62F));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38F));
            header.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            var titleStack = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.Transparent,
                Margin = new Padding(0)
            };
            titleStack.RowStyles.Add(new RowStyle(SizeType.Absolute, 36F));
            titleStack.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            titleStack.Controls.Add(new Label
            {
                Text = "Codex2Frp",
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 15F, FontStyle.Bold),
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(0)
            }, 0, 0);
            titleStack.Controls.Add(new Label
            {
                Text = "本机 Codex 桥接服务与远程链接访问控制台",
                ForeColor = _muted,
                Font = new Font("Segoe UI", 9F),
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(1, 0, 0, 0)
            }, 0, 1);

            var statusStack = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3,
                BackColor = Color.Transparent,
                Margin = new Padding(12, 0, 0, 0)
            };
            statusStack.RowStyles.Add(new RowStyle(SizeType.Percent, 44F));
            statusStack.RowStyles.Add(new RowStyle(SizeType.Percent, 36F));
            statusStack.RowStyles.Add(new RowStyle(SizeType.Absolute, 8F));

            _statusLabel.Text = "正在读取状态...";
            _statusLabel.ForeColor = Color.White;
            _statusLabel.TextAlign = ContentAlignment.MiddleRight;
            _statusLabel.Font = new Font("Segoe UI Semibold", 10.5F, FontStyle.Bold);
            _statusLabel.Dock = DockStyle.Fill;
            _statusLabel.Margin = new Padding(0);
            _subStatusLabel.ForeColor = _muted;
            _subStatusLabel.TextAlign = ContentAlignment.MiddleRight;
            _subStatusLabel.Dock = DockStyle.Fill;
            _subStatusLabel.Margin = new Padding(0);
            _subStatusLabel.AutoEllipsis = true;
            _activityBar.Dock = DockStyle.Fill;
            _activityBar.Margin = new Padding(120, 3, 0, 0);
            statusStack.Controls.Add(_statusLabel, 0, 0);
            statusStack.Controls.Add(_subStatusLabel, 0, 1);
            statusStack.Controls.Add(_activityBar, 0, 2);

            header.Controls.Add(titleStack, 0, 0);
            header.Controls.Add(statusStack, 1, 0);
            return header;
        }

        private Control BuildModernMainPanel(Button openButton, Button copyLocalButton, Button copyLanButton, Button copySakuraButton, Button cdpButton, Button logsButton, Button refreshButton)
        {
            var main = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 6,
                Padding = new Padding(16, 16, 16, 14),
                BackColor = _bg,
                AutoScroll = false
            };
            main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 106F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 128F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 184F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 58F));
            main.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 30F));

            var linkPanel = ModernCard(2);
            linkPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28F));
            linkPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            linkPanel.Controls.Add(ModernSectionTitle("当前访问链接"), 0, 0);
            StyleTextBox(_urlBox, true);
            _urlBox.Margin = new Padding(0, 4, 0, 0);
            linkPanel.Controls.Add(_urlBox, 0, 1);
            main.Controls.Add(linkPanel, 0, 0);

            var actionsPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                BackColor = _bg,
                ColumnCount = 2,
                RowCount = 3,
                Padding = new Padding(0, 2, 0, 0),
                Margin = new Padding(0, 0, 0, 8)
            };
            actionsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            actionsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            actionsPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 33.34F));
            actionsPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
            actionsPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
            StyleButton(_startButton, 0, true);
            StyleButton(_stopButton, 0, false);
            StyleButton(openButton, 0, false);
            StyleButton(copyLocalButton, 0, false);
            StyleButton(copyLanButton, 0, false);
            StyleButton(copySakuraButton, 0, false);
            actionsPanel.Controls.Add(_startButton, 0, 0);
            actionsPanel.Controls.Add(_stopButton, 1, 0);
            actionsPanel.Controls.Add(openButton, 0, 1);
            actionsPanel.Controls.Add(copyLocalButton, 1, 1);
            actionsPanel.Controls.Add(copyLanButton, 0, 2);
            actionsPanel.Controls.Add(copySakuraButton, 1, 2);
            main.Controls.Add(actionsPanel, 0, 1);

            main.Controls.Add(BuildModernSakuraPanel(), 0, 2);

            var toolsPanel = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                BackColor = _bg,
                Padding = new Padding(0, 2, 0, 0),
                Margin = new Padding(0, 0, 0, 8)
            };
            StyleButton(cdpButton, 150, false);
            StyleButton(logsButton, 136, false);
            StyleButton(refreshButton, 118, false);
            toolsPanel.Controls.AddRange(new Control[] { cdpButton, logsButton, refreshButton });
            main.Controls.Add(toolsPanel, 0, 3);

            var detailsPanel = ModernCard(2);
            detailsPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30F));
            detailsPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            detailsPanel.Controls.Add(ModernSectionTitle("运行状态与日志"), 0, 0);
            _detailsBox.Dock = DockStyle.Fill;
            _detailsBox.Margin = new Padding(0);
            _detailsBox.Multiline = true;
            _detailsBox.WordWrap = true;
            _detailsBox.ScrollBars = ScrollBars.Vertical;
            _detailsBox.ReadOnly = true;
            _detailsBox.Font = new Font("Cascadia Mono", 9.5F);
            _detailsBox.ForeColor = Color.FromArgb(235, 238, 242);
            _detailsBox.BackColor = Color.FromArgb(10, 12, 14);
            _detailsBox.BorderStyle = BorderStyle.FixedSingle;
            detailsPanel.Controls.Add(_detailsBox, 0, 1);
            main.Controls.Add(detailsPanel, 0, 4);

            main.Controls.Add(new Label
            {
                Text = "Codex2Frp v" + Program.AppVersion + " · Qiz · 移动端桥接套件",
                ForeColor = _muted,
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(2, 4, 0, 0)
            }, 0, 5);

            return main;
        }

        private Control BuildModernSakuraPanel()
        {
            var sakura = ModernCard(3);
            sakura.RowStyles.Add(new RowStyle(SizeType.Absolute, 32F));
            sakura.RowStyles.Add(new RowStyle(SizeType.Absolute, 92F));
            sakura.RowStyles.Add(new RowStyle(SizeType.Absolute, 32F));
            sakura.Controls.Add(ModernSectionTitle("远程链接访问"), 0, 0);

            var grid = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 2,
                BackColor = _card,
                Margin = new Padding(0, 4, 0, 2)
            };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 88F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 34F));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));

            StyleTextBox(_domainBox, false);
            StyleTextBox(_remotePortBox, false);
            StyleButton(_saveSakuraButton, 0, true);
            StyleButton(_editSakuraButton, 0, false);
            _saveSakuraButton.Dock = DockStyle.Fill;
            _saveSakuraButton.Margin = new Padding(8, 0, 0, 4);
            _editSakuraButton.Dock = DockStyle.Fill;
            _editSakuraButton.Margin = new Padding(8, 0, 0, 4);

            grid.Controls.Add(ModernCaption("子域名"), 0, 0);
            grid.Controls.Add(_domainBox, 1, 0);
            grid.Controls.Add(ModernCaption("远程端口"), 0, 1);
            var routeRow = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 3,
                RowCount = 1,
                BackColor = _card,
                Margin = new Padding(0)
            };
            routeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            routeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104F));
            routeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 128F));
            routeRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            routeRow.Controls.Add(_remotePortBox, 0, 0);
            routeRow.Controls.Add(_editSakuraButton, 1, 0);
            routeRow.Controls.Add(_saveSakuraButton, 2, 0);
            grid.Controls.Add(routeRow, 1, 1);
            sakura.Controls.Add(grid, 0, 1);

            var help = new Label
            {
                Text = "仅保留手动远程链接和端口；保存时会核对 App 可访问性。",
                Dock = DockStyle.Fill,
                ForeColor = _muted,
                BackColor = _card,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Microsoft YaHei UI", 8.2F),
                AutoEllipsis = false,
                Margin = new Padding(0, 2, 0, 0)
            };
            sakura.Controls.Add(help, 0, 2);
            return sakura;
        }

        private TableLayoutPanel ModernCard(int rows)
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = rows,
                BackColor = _card,
                Padding = new Padding(12, 12, 12, 12),
                Margin = new Padding(0, 0, 0, 12)
            };
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            return panel;
        }

        private Label ModernSectionTitle(string text)
        {
            return new Label
            {
                Text = text,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold),
                ForeColor = _ink,
                BackColor = Color.Transparent,
                Margin = new Padding(0)
            };
        }

        private Label ModernCaption(string text)
        {
            return new Label
            {
                Text = text,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = _muted,
                BackColor = Color.Transparent,
                Font = new Font("Segoe UI", 9F),
                Margin = new Padding(0, 5, 8, 2)
            };
        }

        private void StyleTextBox(TextBox box, bool readOnly)
        {
            box.Dock = DockStyle.Fill;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.Margin = new Padding(0, 3, 8, 5);
            box.BackColor = readOnly ? Color.FromArgb(14, 16, 18) : Color.FromArgb(12, 14, 16);
            box.ForeColor = _ink;
            box.Font = new Font("Segoe UI", 9.5F);
            box.ReadOnly = readOnly;
        }

        private void StyleButton(Button button, int width, bool primary)
        {
            if (width > 0)
            {
                button.Size = new Size(width, 36);
                button.Dock = DockStyle.None;
            }
            else
            {
                button.Dock = DockStyle.Fill;
            }
            button.FlatStyle = FlatStyle.Flat;
            button.Cursor = Cursors.Hand;
            button.UseVisualStyleBackColor = false;
            button.Margin = new Padding(0, 0, 8, 7);
            button.Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold);
            button.BackColor = primary ? _accentDeep : _cardSoft;
            button.ForeColor = primary ? _accent : _ink;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = primary ? Color.FromArgb(48, 128, 86) : _border;
            button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(25, 96, 64) : Color.FromArgb(44, 49, 54);
            button.FlatAppearance.MouseDownBackColor = primary ? Color.FromArgb(15, 58, 40) : Color.FromArgb(20, 23, 26);
        }

        private void ApplyResponsiveLayout(Button openButton, Button copyLocalButton, Button copyLanButton, Button copySakuraButton, Button cdpButton, Button logsButton, Button refreshButton)
        {
            Controls.Clear();

            _startButton.Text = "启动服务";
            _stopButton.Text = "停止服务";
            openButton.Text = "打开页面";
            copyLocalButton.Text = "复制本机";
            copyLanButton.Text = "复制局域网";
            copySakuraButton.Text = "复制远程";
            cdpButton.Text = "启用 Codex 控制";
            logsButton.Text = "打开日志目录";
            refreshButton.Text = "刷新状态";
            _saveSakuraButton.Text = "保存";
            _editSakuraButton.Text = "修改表单";

            var shell = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.White,
                Padding = new Padding(0)
            };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 70F));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            Controls.Add(shell);

            shell.Controls.Add(BuildHeader(), 0, 0);
            shell.Controls.Add(BuildMainPanel(openButton, copyLocalButton, copyLanButton, copySakuraButton, cdpButton, logsButton, refreshButton), 0, 1);
        }

        private Control BuildHeader()
        {
            var header = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(19, 31, 36),
                ColumnCount = 2,
                RowCount = 1,
                Padding = new Padding(22, 9, 22, 8)
            };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62F));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38F));
            header.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            var titleStack = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.Transparent,
                Margin = new Padding(0)
            };
            titleStack.RowStyles.Add(new RowStyle(SizeType.Percent, 54F));
            titleStack.RowStyles.Add(new RowStyle(SizeType.Percent, 46F));
            titleStack.Controls.Add(new Label
            {
                Text = "Codex2Frp",
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(0)
            }, 0, 0);
            titleStack.Controls.Add(new Label
            {
                Text = "本机 Codex 服务与远程链接访问面板",
                ForeColor = Color.FromArgb(190, 221, 216),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(1, 0, 0, 0)
            }, 0, 1);

            var statusStack = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.Transparent,
                Margin = new Padding(12, 0, 0, 0)
            };
            statusStack.RowStyles.Add(new RowStyle(SizeType.Percent, 56F));
            statusStack.RowStyles.Add(new RowStyle(SizeType.Percent, 44F));
            _statusLabel.Text = "正在读取状态...";
            _statusLabel.ForeColor = Color.White;
            _statusLabel.TextAlign = ContentAlignment.MiddleRight;
            _statusLabel.Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold);
            _statusLabel.Dock = DockStyle.Fill;
            _statusLabel.Margin = new Padding(0);
            _subStatusLabel.ForeColor = Color.FromArgb(190, 221, 216);
            _subStatusLabel.TextAlign = ContentAlignment.MiddleRight;
            _subStatusLabel.Dock = DockStyle.Fill;
            _subStatusLabel.Margin = new Padding(0);
            statusStack.Controls.Add(_statusLabel, 0, 0);
            statusStack.Controls.Add(_subStatusLabel, 0, 1);

            header.Controls.Add(titleStack, 0, 0);
            header.Controls.Add(statusStack, 1, 0);
            return header;
        }

        private Control BuildMainPanel(Button openButton, Button copyLocalButton, Button copyLanButton, Button copySakuraButton, Button cdpButton, Button logsButton, Button refreshButton)
        {
            var main = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 6,
                Padding = new Padding(18, 16, 18, 12),
                BackColor = Color.White,
                AutoScroll = true
            };
            main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 76F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 96F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 174F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 54F));
            main.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 28F));

            var linkPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.White,
                Margin = new Padding(0, 0, 0, 10)
            };
            linkPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 24F));
            linkPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            linkPanel.Controls.Add(ResponsiveSectionTitle("当前本机链接"), 0, 0);
            PrepareTextBox(_urlBox);
            _urlBox.ReadOnly = true;
            _urlBox.Margin = new Padding(0, 4, 0, 0);
            linkPanel.Controls.Add(_urlBox, 0, 1);
            main.Controls.Add(linkPanel, 0, 0);

            var actionsPanel = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                BackColor = Color.White,
                Margin = new Padding(0, 0, 0, 12)
            };
            PrepareButton(_startButton, 118, true);
            PrepareButton(_stopButton, 118, false);
            PrepareButton(openButton, 136, false);
            PrepareButton(copyLocalButton, 136, false);
            PrepareButton(copyLanButton, 148, false);
            PrepareButton(copySakuraButton, 168, false);
            actionsPanel.Controls.AddRange(new Control[] { _startButton, _stopButton, openButton, copyLocalButton, copyLanButton, copySakuraButton });
            main.Controls.Add(actionsPanel, 0, 1);

            main.Controls.Add(BuildSakuraPanel(), 0, 2);

            var toolsPanel = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                BackColor = Color.White,
                Margin = new Padding(0, 0, 0, 8)
            };
            PrepareButton(cdpButton, 146, false);
            PrepareButton(logsButton, 136, false);
            PrepareButton(refreshButton, 112, false);
            toolsPanel.Controls.AddRange(new Control[] { cdpButton, logsButton, refreshButton });
            main.Controls.Add(toolsPanel, 0, 3);

            var detailsPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = Color.White,
                Margin = new Padding(0, 0, 0, 8)
            };
            detailsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            detailsPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 26F));
            detailsPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            detailsPanel.Controls.Add(ResponsiveSectionTitle("运行状态与日志"), 0, 0);
            _detailsBox.Dock = DockStyle.Fill;
            _detailsBox.Margin = new Padding(0);
            _detailsBox.Font = new Font("Consolas", 9F);
            _detailsBox.BackColor = Color.FromArgb(250, 251, 252);
            _detailsBox.BorderStyle = BorderStyle.FixedSingle;
            detailsPanel.Controls.Add(_detailsBox, 0, 1);
            main.Controls.Add(detailsPanel, 0, 4);

            main.Controls.Add(new Label
            {
                Text = "Codex2Frp v" + Program.AppVersion + " · Qiz · 移动端桥接套件",
                ForeColor = _muted,
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(0)
            }, 0, 5);

            return main;
        }

        private Control BuildSakuraPanel()
        {
            var sakura = new GroupBox
            {
                Text = "远程链接访问",
                ForeColor = _ink,
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 0, 0, 12),
                BackColor = _panel
            };
            var grid = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 6,
                RowCount = 3,
                Padding = new Padding(12, 12, 12, 6),
                BackColor = _panel
            };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 72F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 72F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 18F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 76F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 16F));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 30F));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 34F));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            PrepareTextBox(_domainBox);
            PrepareTextBox(_remotePortBox);
            PrepareButton(_saveSakuraButton, 128, true);
            PrepareButton(_editSakuraButton, 104, false);
            _saveSakuraButton.Dock = DockStyle.Fill;
            _saveSakuraButton.Margin = new Padding(8, 2, 0, 4);
            _editSakuraButton.Dock = DockStyle.Fill;
            _editSakuraButton.Margin = new Padding(8, 2, 0, 4);

            grid.Controls.Add(ResponsiveCaption("子域名"), 0, 0);
            grid.Controls.Add(_domainBox, 1, 0);
            grid.SetColumnSpan(_domainBox, 3);
            grid.Controls.Add(ResponsiveCaption("远程端口"), 4, 0);
            grid.Controls.Add(_remotePortBox, 5, 0);
            grid.Controls.Add(_editSakuraButton, 4, 1);
            grid.Controls.Add(_saveSakuraButton, 5, 1);

            var help = new Label
            {
                Text = "填写远程访问链接或子域名和公网端口；保存时会检查远程链接是否可访问。",
                Dock = DockStyle.Fill,
                ForeColor = _muted,
                BackColor = _panel,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Microsoft YaHei UI", 8.5F),
                AutoEllipsis = true,
                Margin = new Padding(0, 4, 0, 0)
            };
            grid.Controls.Add(help, 0, 2);
            grid.SetColumnSpan(help, 6);
            sakura.Controls.Add(grid);
            return sakura;
        }

        private Label ResponsiveSectionTitle(string text)
        {
            return new Label
            {
                Text = text,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
                ForeColor = _ink,
                BackColor = Color.Transparent,
                Margin = new Padding(0)
            };
        }

        private Label ResponsiveCaption(string text)
        {
            return new Label
            {
                Text = text,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = _muted,
                BackColor = Color.Transparent,
                Margin = new Padding(0, 2, 6, 2)
            };
        }

        private void PrepareTextBox(TextBox box)
        {
            box.Dock = DockStyle.Fill;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.Margin = new Padding(0, 2, 8, 4);
        }

        private void PrepareButton(Button button, int width, bool primary)
        {
            button.Size = new Size(width, 34);
            button.FlatStyle = FlatStyle.Flat;
            button.Cursor = Cursors.Hand;
            button.UseVisualStyleBackColor = false;
            button.Margin = new Padding(0, 0, 10, 10);
            button.BackColor = primary ? _accent : Color.White;
            button.ForeColor = primary ? Color.White : _ink;
            button.FlatAppearance.BorderColor = primary ? _accent : Color.FromArgb(204, 212, 218);
        }

        public void StartServiceForAutomation()
        {
            StartServer();
        }

        public void StopServiceForAutomation()
        {
            StopServer();
        }

        private Label Caption(string text, int x, int y, int width)
        {
            return new Label
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 24),
                ForeColor = _muted,
                BackColor = Color.Transparent
            };
        }

        private TextBox Input(int x, int y, int width, string value)
        {
            return new TextBox
            {
                Text = value,
                Location = new Point(x, y),
                Size = new Size(width, 26),
                BorderStyle = BorderStyle.FixedSingle
            };
        }

        private Button PrimaryButton(string text, int x, int y, int width)
        {
            var button = ButtonBase(text, x, y, width);
            button.BackColor = _accent;
            button.ForeColor = Color.White;
            button.FlatAppearance.BorderColor = _accent;
            return button;
        }

        private Button SecondaryButton(string text, int x, int y, int width)
        {
            var button = ButtonBase(text, x, y, width);
            button.BackColor = Color.White;
            button.ForeColor = _ink;
            button.FlatAppearance.BorderColor = Color.FromArgb(204, 212, 218);
            return button;
        }

        private Button ButtonBase(string text, int x, int y, int width)
        {
            return new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 34),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
        }

        private void RunUiAction(Action action)
        {
            try
            {
                SetBusy("正在处理，请稍候...");
                action();
                SetBusy(string.Empty);
                UpdateModernStatus();
            }
            catch (Exception ex)
            {
                SetBusy(string.Empty);
                MessageBox.Show(ex.Message, Program.AppDisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                UpdateModernStatus();
            }
        }

        private void RunBackgroundUiAction(Action action, string busyMessage, Action successUiAction = null)
        {
            if (_busy) return;
            SetBusy(string.IsNullOrWhiteSpace(busyMessage) ? "正在处理，请稍候..." : busyMessage);
            ThreadPool.QueueUserWorkItem(delegate
            {
                Exception error = null;
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    error = ex;
                }

                try
                {
                    if (IsDisposed || !IsHandleCreated) return;
                    BeginInvoke((MethodInvoker)delegate
                    {
                        SetBusy(string.Empty);
                        if (error != null)
                        {
                            MessageBox.Show(error.Message, Program.AppDisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                        else if (successUiAction != null)
                        {
                            successUiAction();
                        }
                        UpdateModernStatus();
                    });
                }
                catch { }
            });
        }

        private void BeginStartServer()
        {
            if (_busy) return;
            SetBusy("正在启动服务，请稍候...");
            _startButton.Enabled = false;
            _stopButton.Enabled = false;

            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                Exception error = null;
                try
                {
                    StartServer();
                }
                catch (Exception ex)
                {
                    error = ex;
                }

                try
                {
                    if (IsDisposed || !IsHandleCreated) return;
                    BeginInvoke((MethodInvoker)delegate
                    {
                        SetBusy(string.Empty);
                        if (error != null)
                        {
                            MessageBox.Show(error.Message, Program.AppDisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                        UpdateModernStatus();
                        if (error == null)
                        {
                            CheckCodexControlAfterStartup();
                        }
                    });
                }
                catch { }
            });
        }

        private void SetBusy(string message)
        {
            _busy = !string.IsNullOrWhiteSpace(message);
            UseWaitCursor = _busy;
            if (_activityBar != null)
            {
                _activityBar.Visible = _busy;
            }
            if (_busy)
            {
                _statusLabel.Text = message;
                _subStatusLabel.Text = "正在同步服务状态和本机路由";
                _statusLabel.ForeColor = _accent;
            }
        }

        private Process GetServerProcess()
        {
            string token = _paths.GetOrCreateMobileToken();
            try
            {
                if (File.Exists(_paths.PidPath))
                {
                    string raw = File.ReadAllText(_paths.PidPath, Encoding.ASCII).Trim();
                    int pid;
                    if (int.TryParse(raw, out pid))
                    {
                        Process process = Process.GetProcessById(pid);
                        if (!process.HasExited && Program.IsOwnedBackendProcess(process, _paths.ProjectRoot)) return process;
                        TryDelete(_paths.PidPath);
                    }
                }
            }
            catch
            {
            }
            if (!WaitForServerHealth(token, 800)) return null;
            foreach (int pid in Program.GetTcpListeningProcessIds(Program.ServicePort))
            {
                try
                {
                    Process process = Process.GetProcessById(pid);
                    if (process.HasExited) continue;
                    File.WriteAllText(_paths.PidPath, process.Id.ToString(), Encoding.ASCII);
                    return process;
                }
                catch { }
            }
            return null;
        }

        private string GetLocalUrl()
        {
            return "http://127.0.0.1:" + Program.ServicePortDisplay + "/?token=" + Uri.EscapeDataString(_paths.GetOrCreateMobileToken());
        }

        private string GetLanUrlOrThrow()
        {
            string address = GetLanAddress();
            if (string.IsNullOrEmpty(address)) throw new InvalidOperationException("没有找到可供手机访问的局域网 IPv4 地址。");
            return "http://" + address + ":" + Program.ServicePortDisplay + "/?token=" + Uri.EscapeDataString(_paths.GetOrCreateMobileToken());
        }

        private string GetSakuraUrl()
        {
            EnsureServerRunning();
            string route = ExtractSakuraRouteBaseUrl(GetLocalJson("/codex/config"));
            if (string.IsNullOrWhiteSpace(route)) route = BuildSakuraUrlBaseFromFields();
            if (string.IsNullOrWhiteSpace(route)) throw new InvalidOperationException(Program.RemoteUnavailableMessage);
            EnsureRemoteLinkAvailable(route);
            return AppendToken(route);
        }

        private string GetSakuraUrlPreview()
        {
            return AppendToken(BuildSakuraUrlBaseFromFields());
        }

        private void LoadSakuraCachedForm()
        {
            if (_sakuraFormEditMode) return;
            string status = GetLocalJson("/codex/sakura/status");
            string domain = ExtractJsonString(status, "preferredDomain");
            string remotePort = ExtractJsonNumber(status, "remotePort");
            if (string.IsNullOrWhiteSpace(domain) && string.IsNullOrWhiteSpace(remotePort)) return;

            if (!string.IsNullOrWhiteSpace(domain)) _domainBox.Text = domain;
            if (!string.IsNullOrWhiteSpace(remotePort)) _remotePortBox.Text = remotePort;
            _sakuraFormFromCache = true;
        }

        private bool CheckRemoteUnavailableNotice(bool running)
        {
            if (!running) return false;
            string route = BuildSakuraUrlBaseFromFields();
            if (string.IsNullOrWhiteSpace(route)) return false;
            try
            {
                string status = GetLocalJson("/codex/sakura/status", 2500);
                if (!Regex.IsMatch(status ?? string.Empty, "\"code\"\\s*:\\s*\"REMOTE_NETWORK_UNAVAILABLE\"", RegexOptions.IgnoreCase)) return false;
                string key = route;
                _lastRemoteUnavailableNoticeKey = key;
                _detailsBox.Text =
                    Program.RemoteUnavailableMessage + Environment.NewLine + Environment.NewLine +
                    "说明：远程链接暂不可访问，请先使用局域网链接。";
                return true;
            }
            catch { return false; }
        }

        private void ApplySakuraFormLockState(bool running)
        {
            bool locked = running && _sakuraFormFromCache && !_sakuraFormEditMode;
            _domainBox.ReadOnly = locked;
            _remotePortBox.ReadOnly = locked;
            Color fill = locked ? Color.FromArgb(38, 42, 46) : Color.FromArgb(12, 14, 16);
            Color text = locked ? _muted : _ink;
            foreach (TextBox box in new[] { _domainBox, _remotePortBox })
            {
                box.BackColor = fill;
                box.ForeColor = text;
            }
            _saveSakuraButton.Enabled = !locked;
            _editSakuraButton.Enabled = !running;
            _editSakuraButton.Text = locked ? "停止后修改" : "修改表单";
        }

        private void UnlockSakuraFormForEdit()
        {
            if (GetServerProcess() != null)
            {
                throw new InvalidOperationException("请先停止服务，再修改从缓存读取的远程链接表单。");
            }
            _sakuraFormEditMode = true;
            ApplySakuraFormLockState(false);
            _detailsBox.Text =
                "远程链接表单已解锁。" + Environment.NewLine + Environment.NewLine +
                "修改远程地址或端口后，请点击“保存并检查”重新保存并核对连接。";
        }

        private string BuildSakuraUrlBaseFromFields()
        {
            return BuildSakuraUrlBaseFromValues(_domainBox.Text, _remotePortBox.Text);
        }

        private static string BuildSakuraUrlBaseFromValues(string domainValue, string remotePortValue)
        {
            string domain = (domainValue ?? string.Empty).Trim();
            if (domain.Length == 0) return string.Empty;
            string baseUrl = domain.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || domain.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? domain.TrimEnd('/')
                : "https://" + domain.TrimEnd('/');
            int port;
            if (int.TryParse((remotePortValue ?? string.Empty).Trim(), out port) && port > 0 && port <= 65535)
            {
                var builder = new UriBuilder(baseUrl);
                if (builder.Port == 80 || builder.Port == 443 || builder.Port == -1) builder.Port = port;
                baseUrl = builder.Uri.AbsoluteUri.TrimEnd('/');
            }
            return baseUrl;
        }

        private void ValidateSakuraForm()
        {
            string domain = (_domainBox.Text ?? string.Empty).Trim();
            string remotePort = (_remotePortBox.Text ?? string.Empty).Trim();
            var errors = new StringBuilder();

            if (string.IsNullOrWhiteSpace(domain))
            {
                errors.AppendLine("- 子域名/远程地址不能为空；这是 App 远程连接后端真正需要的地址。");
            }
            else if (!IsValidSakuraRemoteAddress(domain))
            {
                errors.AppendLine("- 子域名/远程地址格式不正确；请填写域名、IP，或完整 http/https 地址，不要带路径。");
            }
            int port;
            if (string.IsNullOrWhiteSpace(remotePort))
            {
                errors.AppendLine("- 远程端口不能为空；这是远程服务分配的公网端口。");
            }
            else if (!int.TryParse(remotePort, out port) || port < 1 || port > 65535)
            {
                errors.AppendLine("- 远程端口必须是 1-65535 的数字。");
            }
            if (errors.Length > 0)
            {
                throw new InvalidOperationException("远程链接表单填写错误：" + Environment.NewLine + errors.ToString().TrimEnd());
            }
        }

        private static bool IsValidSakuraRemoteAddress(string value)
        {
            string text = (value ?? string.Empty).Trim();
            if (text.Length == 0) return true;
            if (!Regex.IsMatch(text, "^[a-zA-Z][a-zA-Z0-9+.-]*://")) text = "http://" + text;
            Uri uri;
            if (!Uri.TryCreate(text, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
            if (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) return false;
            if (!string.IsNullOrEmpty(uri.AbsolutePath) && uri.AbsolutePath != "/") return false;
            string host = uri.Host ?? string.Empty;
            if (host.Length == 0 || host.IndexOfAny(new[] { ' ', '\t', '\r', '\n' }) >= 0) return false;
            return Regex.IsMatch(host, @"^[A-Za-z0-9.-]+$") || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase);
        }

        private string AppendToken(string baseUrl)
        {
            string clean = (baseUrl ?? string.Empty).Trim().TrimEnd('/');
            if (string.IsNullOrWhiteSpace(clean)) return string.Empty;
            return clean + "/?token=" + Uri.EscapeDataString(_paths.GetOrCreateMobileToken());
        }

        private static string ExtractSakuraRouteBaseUrl(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return string.Empty;
            foreach (Match item in Regex.Matches(json, "\\{[^{}]*\"kind\"\\s*:\\s*\"sakura\"[^{}]*\\}", RegexOptions.IgnoreCase | RegexOptions.Singleline))
            {
                Match route = Regex.Match(item.Value, "\"baseUrl\"\\s*:\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase | RegexOptions.Singleline);
                if (route.Success) return route.Groups[1].Value.Replace("\\/", "/").TrimEnd('/');
            }
            return string.Empty;
        }

        private static string ExtractJsonString(string json, string property)
        {
            if (string.IsNullOrWhiteSpace(json)) return string.Empty;
            Match match = Regex.Match(json, "\"" + Regex.Escape(property) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            if (!match.Success) return string.Empty;
            return Regex.Unescape(match.Groups[1].Value);
        }

        private static string ExtractJsonNumber(string json, string property)
        {
            if (string.IsNullOrWhiteSpace(json)) return string.Empty;
            Match match = Regex.Match(json, "\"" + Regex.Escape(property) + "\"\\s*:\\s*(\\d+)", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            return match.Success ? match.Groups[1].Value : string.Empty;
        }

        private static bool ExtractJsonBool(string json, string property)
        {
            if (string.IsNullOrWhiteSpace(json)) return false;
            Match match = Regex.Match(json, "\"" + Regex.Escape(property) + "\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            return match.Success && string.Equals(match.Groups[1].Value, "true", StringComparison.OrdinalIgnoreCase);
        }

        private void VerifyRemoteHealth(string baseUrl)
        {
            string clean = (baseUrl ?? string.Empty).Trim().TrimEnd('/');
            if (string.IsNullOrWhiteSpace(clean)) throw new InvalidOperationException("远程链接为空。");
            string healthUrl = clean + "/codex/health?token=" + Uri.EscapeDataString(_paths.GetOrCreateMobileToken());
            var request = (HttpWebRequest)WebRequest.Create(healthUrl);
            request.Method = "GET";
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300)
                {
                    throw new InvalidOperationException("远程健康检查失败: HTTP " + (int)response.StatusCode);
                }
            }
        }

        private void EnsureRemoteLinkAvailable(string baseUrl)
        {
            try
            {
                VerifyRemoteHealth(baseUrl);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(Program.RemoteUnavailableMessage + " " + ex.Message, ex);
            }
        }

        private static string GetLanAddress()
        {
            foreach (NetworkInterface item in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (item.OperationalStatus != OperationalStatus.Up) continue;
                var props = item.GetIPProperties();
                foreach (UnicastIPAddressInformation address in props.UnicastAddresses)
                {
                    if (address.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    string text = address.Address.ToString();
                    if (IsPrivateIpv4(text)) return text;
                }
            }
            return string.Empty;
        }

        private static bool IsPrivateIpv4(string value)
        {
            string[] parts = (value ?? string.Empty).Split('.');
            if (parts.Length != 4) return false;
            int a, b;
            if (!int.TryParse(parts[0], out a) || !int.TryParse(parts[1], out b)) return false;
            return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
        }

        private void EnsureServerRunning()
        {
            if (GetServerProcess() == null) StartServer();
        }

        private void StartServer()
        {
            string token = _paths.GetOrCreateMobileToken();
            Process existing = GetServerProcess();
            if (existing != null && WaitForServerHealth(token, 1500)) return;
            StopServer();
            string node = _paths.FindNodeExe();
            string bootstrap = Path.Combine(_paths.ProjectRoot, "scripts", "server-log-bootstrap.js");
            if (!File.Exists(bootstrap)) throw new FileNotFoundException("缺少服务启动脚本。", bootstrap);
            TryDelete(_paths.StdoutPath);
            TryDelete(_paths.StderrPath);
            var info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = Program.Quote(bootstrap),
                WorkingDirectory = _paths.ProjectRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            info.EnvironmentVariables["PORT"] = Program.ServicePort.ToString();
            info.EnvironmentVariables["HOST"] = "0.0.0.0";
            info.EnvironmentVariables["MOBILE_TYPER_TOKEN"] = token;
            info.EnvironmentVariables["CODEX2FRP_APP_NAME"] = "Codex2Frp";
            info.EnvironmentVariables["CODEX2FRP_LOCAL_ONLY"] = "0";
            info.EnvironmentVariables["CODEX2FRP_DISABLE_IMESSAGE_NOTIFY"] = "1";
            info.EnvironmentVariables["CODEX2FRP_CDP_PORT"] = "39252";
            info.EnvironmentVariables["CODEX2FRP_STDOUT"] = _paths.StdoutPath;
            info.EnvironmentVariables["CODEX2FRP_STDERR"] = _paths.StderrPath;
            Process launched = Process.Start(info);
            if (launched == null) throw new InvalidOperationException("服务进程未能启动。");
            File.WriteAllText(_paths.PidPath, launched.Id.ToString(), Encoding.ASCII);
            System.Threading.Thread.Sleep(900);
            Process process = GetServerProcess();
            if (process == null && WaitForServerHealth(token, 20000))
            {
                TryDelete(_paths.PidPath);
                return;
            }
            if (process == null || !WaitForServerHealth(token, 12000)) throw new InvalidOperationException("服务未能启动，请打开日志目录查看错误。");
        }

        private bool WaitForServerHealth(string token, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Program.ServicePortDisplay + "/codex/health?token=" + Uri.EscapeDataString(token));
                    request.Method = "GET";
                    request.Timeout = 1200;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 300) return true;
                    }
                }
                catch { }
                System.Threading.Thread.Sleep(300);
            }
            return false;
        }

        private void StopServer()
        {
            Process process = GetServerProcess();
            if (process != null)
            {
                Program.KillProcess(process);
            }
            Program.StopRelatedProcesses(_paths.ProjectRoot, false);
            Program.StopKnownPortOwners(Program.ServicePort, _paths.ProjectRoot);
            TryDelete(_paths.PidPath);
        }

        private void ShutdownAllProcessesForExit()
        {
            try { StopServer(); } catch { }
            try { Program.StopRelatedProcesses(_paths.ProjectRoot, true); } catch { }
            try { Program.StopKnownPortOwners(Program.ServicePort, _paths.ProjectRoot); } catch { }
            TryDelete(_paths.PidPath);
        }

        private void StartCodexCdp()
        {
            DialogResult answer = MessageBox.Show(
                this,
                "启用 Codex 控制会强制关闭当前所有 Codex 客户端窗口，然后重新启动一个支持 CDP 控制的 Codex 客户端。\r\n\r\n请先确认当前 Codex 中没有正在进行的重要任务、未保存输入或关键输出。是否继续？",
                "启用 Codex 控制",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2
            );
            if (answer != DialogResult.OK) return;

            string result = string.Empty;
            RunBackgroundUiAction(delegate
            {
                EnsureServerRunning();
                result = PostLocalJson("/codex/control-port", "{\"autoOpen\":true,\"forceRestart\":true,\"allowIsolatedProfile\":false}");
            }, "正在启用 Codex 控制，请稍候...", delegate
            {
                _detailsBox.Text =
                    "Codex 控制已启用。\r\n\r\n" +
                    "后端已重启为单一 CDP Codex 客户端。后续模型、思考强度、速度和发送操作都会在这个客户端窗口中完成，不会再为调节操作另开 Codex。\r\n\r\n" +
                    result;
            });
        }

        private void CheckCodexControlAfterStartup()
        {
            if (_controlWarningShown) return;
            try
            {
                string config = GetLocalJson("/codex/config");
                if (Regex.IsMatch(config, "\"controlPort\"\\s*:\\s*\\{[\\s\\S]*?\"ready\"\\s*:\\s*true", RegexOptions.IgnoreCase))
                {
                    return;
                }
            }
            catch
            {
                return;
            }

            _controlWarningShown = true;
            _detailsBox.Text =
                "Codex 控制尚未启用。\r\n\r\n" +
                "当前没有检测到正在运行且可操控的 CDP Codex 窗口。App 端调节模型、思考强度和速度前，需要先点击“启用 Codex 控制”。\r\n\r\n" +
                "点击后会提示你确认；确认后将强制关闭当前所有 Codex 客户端，并重新启动一个支持 CDP 控制的 Codex 客户端。";
            MessageBox.Show(
                this,
                "当前没有检测到可操控的 CDP Codex 窗口。\r\n\r\n如果需要在 App 端调节模型、思考强度或速度，请点击“启用 Codex 控制”。",
                "需要启用 Codex 控制",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        private void SaveSakuraConfig()
        {
            EnsureServerRunning();
            ValidateSakuraForm();
            var json = new StringBuilder();
            json.Append("{");
            json.Append("\"enabled\":true,");
            json.Append("\"apiBase\":\"https://api.natfrp.com/v4\",");
            json.Append("\"preferredDomain\":\"").Append(JsonEscape((_domainBox.Text ?? string.Empty).Trim())).Append("\",");
            json.Append("\"remotePort\":\"").Append(JsonEscape((_remotePortBox.Text ?? string.Empty).Trim())).Append("\",");
            json.Append("\"managedTunnelIds\":[]");
            json.Append("}");
            PostLocalJson("/codex/sakura/config", json.ToString());
            string route = BuildSakuraUrlBaseFromFields();
            if (string.IsNullOrWhiteSpace(route)) throw new InvalidOperationException("远程链接表单填写错误：远程链接为空。");

            string message = "手动远程链接检查通过。";

            try
            {
                EnsureRemoteLinkAvailable(route);
            }
            catch (Exception ex)
            {
                _detailsBox.Text =
                    Program.RemoteUnavailableMessage + Environment.NewLine + Environment.NewLine +
                    ex.Message + Environment.NewLine + Environment.NewLine +
                    "说明：请核对远程地址、端口和远程连接网络状态。";
                throw new InvalidOperationException(Program.RemoteUnavailableMessage, ex);
            }
            _sakuraFormFromCache = false;
            _sakuraFormEditMode = false;
            _detailsBox.Text =
                "远程链接配置可用。" + Environment.NewLine + Environment.NewLine +
                "可用远程链接: " + AppendToken(route) + Environment.NewLine +
                "检查结果: " + (string.IsNullOrWhiteSpace(message) ? "远程链接已可访问。" : message) + Environment.NewLine + Environment.NewLine +
                "说明：子域名/远程地址和远程端口决定 App 连接。";
        }

        private string PostLocalJson(string path, string body)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body ?? "{}");
            var request = (HttpWebRequest)WebRequest.Create(LocalApiUrl(path));
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 75000;
            request.ReadWriteTimeout = 75000;
            request.ContentLength = payload.Length;
            try
            {
                using (Stream stream = request.GetRequestStream())
                {
                    stream.Write(payload, 0, payload.Length);
                }
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (WebException ex)
            {
                string detail = string.Empty;
                var response = ex.Response as HttpWebResponse;
                if (response != null)
                {
                    using (response)
                    using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null, Encoding.UTF8))
                    {
                        detail = reader.ReadToEnd();
                    }
                }
                string message = ExtractJsonString(detail, "message");
                if (string.IsNullOrWhiteSpace(message)) message = ex.Message;
                throw new InvalidOperationException(message, ex);
            }
        }

        private string GetLocalJson(string path)
        {
            return GetLocalJson(path, 12000);
        }

        private string GetLocalJson(string path, int timeoutMs)
        {
            var request = (HttpWebRequest)WebRequest.Create(LocalApiUrl(path));
            request.Method = "GET";
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private string LocalApiUrl(string path)
        {
            string cleanPath = string.IsNullOrWhiteSpace(path) ? "/" : path;
            string separator = cleanPath.IndexOf('?') >= 0 ? "&" : "?";
            return "http://127.0.0.1:" + Program.ServicePortDisplay + cleanPath + separator + "token=" + Uri.EscapeDataString(_paths.GetOrCreateMobileToken());
        }

        private sealed class StatusRefreshRequest
        {
            public string Domain = "";
            public string RemotePort = "";
            public bool SakuraFormEditMode;
        }

        private sealed class StatusSnapshot
        {
            public bool Running;
            public int ProcessId;
            public string LocalUrl = "";
            public string CachedDomain = "";
            public string CachedRemotePort = "";
            public bool HasCachedSakura;
            public bool RemoteUnavailable;
            public string RemoteUnavailableKey = "";
            public string Details = "";
            public string Error = "";
        }

        private void UpdateModernStatus()
        {
            if (_busy) return;
            QueueStatusRefresh();
        }

        private void QueueStatusRefresh()
        {
            if (Interlocked.CompareExchange(ref _statusRefreshInFlight, 1, 0) != 0)
            {
                Interlocked.Exchange(ref _statusRefreshAgain, 1);
                return;
            }

            var request = new StatusRefreshRequest
            {
                Domain = _domainBox.Text ?? string.Empty,
                RemotePort = _remotePortBox.Text ?? string.Empty,
                SakuraFormEditMode = _sakuraFormEditMode
            };

            ThreadPool.QueueUserWorkItem(delegate
            {
                StatusSnapshot snapshot;
                try
                {
                    snapshot = BuildStatusSnapshot(request);
                }
                catch (Exception ex)
                {
                    snapshot = new StatusSnapshot
                    {
                        LocalUrl = GetLocalUrl(),
                        Details = "状态刷新失败：" + ex.Message,
                        Error = ex.Message
                    };
                }

                try
                {
                    if (!IsDisposed && IsHandleCreated)
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            Interlocked.Exchange(ref _statusRefreshInFlight, 0);
                            if (!_busy) ApplyStatusSnapshot(snapshot);
                            if (Interlocked.Exchange(ref _statusRefreshAgain, 0) == 1) UpdateModernStatus();
                        });
                        return;
                    }
                }
                catch { }

                Interlocked.Exchange(ref _statusRefreshInFlight, 0);
            });
        }

        private StatusSnapshot BuildStatusSnapshot(StatusRefreshRequest request)
        {
            var snapshot = new StatusSnapshot();
            string token = _paths.GetOrCreateMobileToken();
            snapshot.LocalUrl = GetLocalUrl();
            Process process = GetServerProcess();
            snapshot.Running = process != null;
            snapshot.ProcessId = process == null ? 0 : process.Id;

            string sakuraStatus = string.Empty;
            if (snapshot.Running && !request.SakuraFormEditMode)
            {
                try
                {
                    sakuraStatus = GetLocalJson("/codex/sakura/status", 2500);
                    string domain = ExtractJsonString(sakuraStatus, "preferredDomain");
                    string remotePort = ExtractJsonNumber(sakuraStatus, "remotePort");
                    if (!string.IsNullOrWhiteSpace(domain) || !string.IsNullOrWhiteSpace(remotePort))
                    {
                        snapshot.CachedDomain = domain;
                        snapshot.CachedRemotePort = remotePort;
                        snapshot.HasCachedSakura = true;
                    }
                }
                catch { }
            }

            string effectiveDomain = snapshot.HasCachedSakura && !string.IsNullOrWhiteSpace(snapshot.CachedDomain)
                ? snapshot.CachedDomain
                : request.Domain;
            string effectiveRemotePort = snapshot.HasCachedSakura && !string.IsNullOrWhiteSpace(snapshot.CachedRemotePort)
                ? snapshot.CachedRemotePort
                : request.RemotePort;
            string route = BuildSakuraUrlBaseFromValues(effectiveDomain, effectiveRemotePort);
            if (snapshot.Running && !string.IsNullOrWhiteSpace(route) &&
                Regex.IsMatch(sakuraStatus ?? string.Empty, "\"code\"\\s*:\\s*\"REMOTE_NETWORK_UNAVAILABLE\"", RegexOptions.IgnoreCase))
            {
                snapshot.RemoteUnavailable = true;
                snapshot.RemoteUnavailableKey = route;
            }

            var lines = new StringBuilder();
            if (snapshot.RemoteUnavailable)
            {
                lines.AppendLine(Program.RemoteUnavailableMessage);
                lines.AppendLine();
                lines.AppendLine("说明：远程链接暂不可访问，请先使用局域网链接。");
                snapshot.Details = lines.ToString();
                return snapshot;
            }

            lines.AppendLine("本机链接: " + snapshot.LocalUrl);
            string lan = GetLanAddress();
            if (!string.IsNullOrEmpty(lan))
            {
                lines.AppendLine("局域网链接: http://" + lan + ":" + Program.ServicePortDisplay + "/?token=" + Uri.EscapeDataString(token));
            }
            else
            {
                lines.AppendLine("局域网链接: 暂未发现可用的局域网 IPv4 地址");
            }
            lines.AppendLine("远程链接: " + AppendToken(route));
            lines.AppendLine("服务状态: " + (snapshot.Running ? "运行中" : "未运行"));
            lines.AppendLine("安装目录: " + _paths.ProjectRoot);
            lines.AppendLine();
            lines.AppendLine("日志:");
            string output = ReadLogTail(_paths.StdoutPath, 32);
            lines.AppendLine(string.IsNullOrWhiteSpace(output) ? "暂无输出日志。" : output);
            string errors = ReadLogTail(_paths.StderrPath, 32);
            if (!string.IsNullOrWhiteSpace(errors))
            {
                lines.AppendLine();
                lines.AppendLine("错误日志:");
                lines.AppendLine(errors);
            }
            snapshot.Details = lines.ToString();
            return snapshot;
        }

        private void ApplyStatusSnapshot(StatusSnapshot snapshot)
        {
            _urlBox.Text = snapshot.LocalUrl;
            if (snapshot.HasCachedSakura && !_sakuraFormEditMode)
            {
                if (!string.IsNullOrWhiteSpace(snapshot.CachedDomain)) _domainBox.Text = snapshot.CachedDomain;
                if (!string.IsNullOrWhiteSpace(snapshot.CachedRemotePort)) _remotePortBox.Text = snapshot.CachedRemotePort;
                _sakuraFormFromCache = true;
            }
            ApplySakuraFormLockState(snapshot.Running);
            _activityBar.Visible = false;
            UseWaitCursor = false;
            _statusLabel.Text = snapshot.Running ? "服务运行中" : "服务已停止";
            _statusLabel.ForeColor = snapshot.Running ? _accent : _danger;
            _subStatusLabel.Text = snapshot.Running ? "PID " + snapshot.ProcessId + " · 端口 " + Program.ServicePortDisplay : "点击“启动服务”后再从手机访问";
            _startButton.Enabled = !snapshot.Running;
            _stopButton.Enabled = snapshot.Running;
            _startButton.BackColor = snapshot.Running ? Color.FromArgb(28, 30, 31) : _accentDeep;
            _startButton.ForeColor = snapshot.Running ? _muted : _accent;
            _stopButton.BackColor = snapshot.Running ? Color.FromArgb(34, 26, 28) : Color.FromArgb(28, 30, 31);
            _stopButton.ForeColor = snapshot.Running ? Color.FromArgb(255, 188, 198) : _muted;
            if (snapshot.RemoteUnavailable) _lastRemoteUnavailableNoticeKey = snapshot.RemoteUnavailableKey;
            _detailsBox.Text = snapshot.Details;
        }

        private void UpdateStatus()
        {
            Process process = GetServerProcess();
            _urlBox.Text = GetLocalUrl();
            bool running = process != null;
            _statusLabel.Text = running ? "服务运行中" : "服务已停止";
            _subStatusLabel.Text = running ? "PID " + process.Id + " · 端口 " + Program.ServicePortDisplay : "点击启动服务后再从手机访问";
            _startButton.Enabled = !running;
            _stopButton.Enabled = running;
            _startButton.BackColor = running ? Color.FromArgb(218, 225, 230) : _accent;
            _startButton.ForeColor = running ? _muted : Color.White;
            _stopButton.BackColor = running ? Color.White : Color.FromArgb(241, 244, 246);
            _stopButton.ForeColor = running ? _ink : _muted;

            var lines = new StringBuilder();
            lines.AppendLine("本机链接: " + GetLocalUrl());
            string lan = GetLanAddress();
            if (!string.IsNullOrEmpty(lan)) lines.AppendLine("局域网链接: http://" + lan + ":" + Program.ServicePortDisplay + "/?token=" + Uri.EscapeDataString(_paths.GetOrCreateMobileToken()));
            lines.AppendLine("远程链接: " + GetSakuraUrlPreview());
            lines.AppendLine("服务状态: " + (running ? "运行中" : "未运行"));
            lines.AppendLine();
            lines.AppendLine("日志:");
            lines.AppendLine(ReadLogTail(_paths.StdoutPath, 24));
            string errors = ReadLogTail(_paths.StderrPath, 24);
            if (!string.IsNullOrWhiteSpace(errors))
            {
                lines.AppendLine();
                lines.AppendLine("错误日志:");
                lines.AppendLine(errors);
            }
            _detailsBox.Text = lines.ToString();
        }

        private static string ReadLogTail(string path, int lines)
        {
            try
            {
                if (!File.Exists(path)) return string.Empty;
                string[] rows = File.ReadAllLines(path, Encoding.UTF8);
                return string.Join(Environment.NewLine, rows.Skip(Math.Max(0, rows.Length - lines)).ToArray());
            }
            catch
            {
                return string.Empty;
            }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        private static string JsonEscape(string value)
        {
            return (value ?? string.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
        }
    }
}
