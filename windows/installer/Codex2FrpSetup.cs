using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Codex2FrpSetup
{
    internal static class Program
    {
        internal const string AppDisplayName = "Codex2Frp";
        internal const int ServicePort = 8988;
        internal const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex2Frp";
        internal const string LegacyAppDisplayName = "Codex2Frp";
        internal const string LegacyUninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex2Frp";

        [STAThread]
        private static int Main(string[] args)
        {
            InstallOptions options = InstallOptions.Parse(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                bool ownsMutex = false;
                using (var mutex = new Mutex(false, @"Local\Codex2FrpSetup", out ownsMutex))
                {
                    if (!mutex.WaitOne(0))
                    {
                        if (!options.Silent)
                        {
                            MessageBox.Show(
                                AppDisplayName + " 安装程序正在运行。\n\n请等待当前安装完成后再试。",
                                AppDisplayName + " 安装程序",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Information
                            );
                        }
                        return 0;
                    }
                    try
                    {
                        if (options.Silent)
                        {
                            try
                            {
                                Installer.Run(options, null);
                                if (options.LaunchAfterInstall)
                                {
                                    string exePath = Path.Combine(options.InstallDir, AppDisplayName + ".exe");
                                    try
                                    {
                                        Process.Start(new ProcessStartInfo
                                        {
                                            FileName = exePath,
                                            WorkingDirectory = options.InstallDir,
                                            UseShellExecute = true
                                        });
                                    }
                                    catch
                                    {
                                    }
                                }
                                return 0;
                            }
                            catch (Exception ex)
                            {
                                Console.Error.WriteLine(ex);
                                return 1;
                            }
                        }

                        using (var form = new ModernSetupForm(options))
                        {
                            Application.Run(form);
                            return form.ExitCode;
                        }
                    }
                    finally
                    {
                        mutex.ReleaseMutex();
                    }
                }
            }
            catch (Exception ex)
            {
                if (options.Silent)
                {
                    Console.Error.WriteLine(ex);
                }
                else
                {
                    MessageBox.Show(
                        ex.ToString(),
                        AppDisplayName + " 安装程序",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                return 1;
            }
        }
    }

    internal delegate void SetupProgressHandler(string status, int percent);

    internal static class Installer
    {
        public static void Run(InstallOptions options, SetupProgressHandler progress)
        {
            Report(progress, "正在准备安装…", 0);
            Directory.CreateDirectory(options.InstallDir);

            bool restoreRunningService = IsInstalledBackendRunning(options.InstallDir);

            Report(progress, "正在停止正在运行的旧版本…", -1);
            StopInstalledCodex2FrpProcesses(options.InstallDir);
            WaitForInstalledLauncherUnlock(options.InstallDir);

            Report(progress, "正在读取安装内容…", -1);
            string tempZip = Path.Combine(Path.GetTempPath(), "codex2frp-windows-payload-" + Process.GetCurrentProcess().Id + ".zip");
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Codex2FrpSetup.Payload.zip"))
            {
                if (payload == null) throw new InvalidOperationException("Embedded payload was not found.");
                using (FileStream output = File.Create(tempZip))
                {
                    payload.CopyTo(output);
                }
            }

            try
            {
                Report(progress, "正在清理旧文件…", -1);
                CleanInstallDir(options.InstallDir);

                long installedBytes = ExtractPayload(tempZip, options.InstallDir, progress);

                string exePath = Path.Combine(options.InstallDir, Program.AppDisplayName + ".exe");
                if (!File.Exists(exePath))
                {
                    throw new FileNotFoundException("The installed launcher was not found after extraction.", exePath);
                }

                Report(progress, "正在创建快捷方式…", 96);
                if (options.CreateShortcut)
                {
                    CreateShortcut(
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Program.AppDisplayName + ".lnk"),
                        exePath,
                        options.InstallDir
                    );
                }
                CreateShortcut(
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Program.AppDisplayName + ".lnk"),
                    exePath,
                    options.InstallDir
                );

                Report(progress, "正在注册卸载信息…", 98);
                RegisterUninstall(options.InstallDir, exePath, installedBytes);

                if (restoreRunningService)
                {
                    Report(progress, "正在恢复后台服务…", 99);
                    StartInstalledBackendService(exePath, options.InstallDir);
                }

                Report(progress, "安装完成", 100);
            }
            finally
            {
                try { File.Delete(tempZip); } catch { }
            }
        }

        private static void Report(SetupProgressHandler progress, string status, int percent)
        {
            if (progress != null) progress(status, percent);
        }

        private static void CleanInstallDir(string installDir)
        {
            if (!Directory.Exists(installDir)) return;
            foreach (string entry in Directory.GetFileSystemEntries(installDir))
            {
                if (string.Equals(Path.GetFileName(entry), ".runtime", StringComparison.OrdinalIgnoreCase))
                {
                    PruneRuntimeDirectory(entry);
                    continue;
                }
                try
                {
                    if (Directory.Exists(entry)) Directory.Delete(entry, true);
                    else File.Delete(entry);
                }
                catch
                {
                }
            }
        }

        private static long ExtractPayload(string zipPath, string installDir, SetupProgressHandler progress)
        {
            string installRoot = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            long installedBytes = 0;
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                int total = archive.Entries.Count;
                int done = 0;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    done += 1;
                    string relativePath = (entry.FullName ?? string.Empty).Replace('/', Path.DirectorySeparatorChar);
                    if (string.IsNullOrWhiteSpace(relativePath)) continue;
                    string targetPath = Path.GetFullPath(Path.Combine(installDir, relativePath));
                    if (!targetPath.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Unsafe payload path: " + entry.FullName);
                    }

                    if (relativePath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
                    {
                        Directory.CreateDirectory(targetPath);
                        continue;
                    }

                    string parent = Path.GetDirectoryName(targetPath);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    if (File.Exists(targetPath)) File.Delete(targetPath);
                    entry.ExtractToFile(targetPath);
                    installedBytes += entry.Length;

                    if (total > 0 && (done % 16 == 0 || done == total))
                    {
                        // 解压占进度条 5% 到 95% 的区间。
                        int percent = 5 + (int)(done * 90L / total);
                        Report(progress, "正在复制文件… (" + done + "/" + total + ")", percent);
                    }
                }
            }
            return installedBytes;
        }

        private static void RegisterUninstall(string installDir, string exePath, long installedBytes)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Program.UninstallKeyPath))
                {
                    if (key == null) return;
                    key.SetValue("DisplayName", Program.AppDisplayName);
                    key.SetValue("DisplayVersion", SetupVersion.Value);
                    key.SetValue("Publisher", "Qiz");
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("DisplayIcon", exePath + ",0");
                    key.SetValue("UninstallString", "\"" + exePath + "\" --uninstall");
                    key.SetValue("QuietUninstallString", "\"" + exePath + "\" --uninstall --silent");
                    key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    long kb = installedBytes / 1024;
                    if (kb > int.MaxValue) kb = int.MaxValue;
                    key.SetValue("EstimatedSize", (int)kb, RegistryValueKind.DWord);
                }
                try { Registry.CurrentUser.DeleteSubKeyTree(Program.LegacyUninstallKeyPath, false); } catch { }
            }
            catch
            {
                // 注册失败不阻塞安装，只是不出现在“应用与功能”列表。
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.WorkingDirectory = workingDirectory;
            shortcut.IconLocation = targetPath + ",0";
            shortcut.Save();
        }

        private static void StopInstalledCodex2FrpProcesses(string installDir)
        {
            string fullInstallDir = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (!CouldBeCodex2FrpProcess(process.ProcessName)) continue;
                    string commandLine = GetCommandLine(process);
                    string executable = string.Empty;
                    try { executable = process.MainModule == null ? string.Empty : process.MainModule.FileName; } catch { }
                    string haystack = (executable + "\n" + commandLine).Replace('/', '\\');
                    if (haystack.IndexOf(fullInstallDir.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (!IsCodex2FrpProcess(process.ProcessName, commandLine, executable)) continue;
                    process.Kill();
                    process.WaitForExit(5000);
                }
                catch
                {
                }
            }
            StopCodex2FrpPortOwners(Program.ServicePort);
        }

        private static bool IsInstalledBackendRunning(string installDir)
        {
            string fullInstallDir = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            foreach (int pid in GetTcpListeningProcessIds(Program.ServicePort))
            {
                try
                {
                    Process process = Process.GetProcessById(pid);
                    if (process.HasExited || !CouldBeCodex2FrpProcess(process.ProcessName)) continue;
                    string commandLine = GetCommandLine(process);
                    string executable = string.Empty;
                    try { executable = process.MainModule == null ? string.Empty : process.MainModule.FileName; } catch { }
                    string haystack = (executable + "\n" + commandLine).Replace('/', '\\');
                    if (haystack.IndexOf(fullInstallDir.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (IsCodex2FrpProcess(process.ProcessName, commandLine, executable)) return true;
                }
                catch
                {
                }
            }
            return false;
        }

        private static void StartInstalledBackendService(string exePath, string installDir)
        {
            var info = new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = "--silent --start-service",
                WorkingDirectory = installDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process process = Process.Start(info))
            {
                if (process == null) throw new InvalidOperationException("The installed backend launcher did not start.");
                if (!process.WaitForExit(15000))
                {
                    try { process.Kill(); } catch { }
                    throw new TimeoutException("The installed backend launcher did not finish starting the service.");
                }
                if (process.ExitCode != 0)
                {
                    throw new InvalidOperationException("The installed backend launcher could not restore the service.");
                }
            }

            DateTime deadline = DateTime.UtcNow.AddSeconds(20);
            while (DateTime.UtcNow < deadline)
            {
                if (IsInstalledBackendRunning(installDir)) return;
                Thread.Sleep(250);
            }
            throw new TimeoutException("The installed backend service did not resume after the upgrade.");
        }

        private static void WaitForInstalledLauncherUnlock(string installDir)
        {
            string exePath = Path.Combine(installDir, Program.AppDisplayName + ".exe");
            if (!File.Exists(exePath)) return;

            DateTime deadline = DateTime.UtcNow.AddSeconds(10);
            Exception lastError = null;
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    using (new FileStream(exePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    {
                    }
                    return;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    Thread.Sleep(250);
                    StopInstalledCodex2FrpProcesses(installDir);
                }
            }

            if (lastError != null)
            {
                throw new IOException("The installed launcher is still locked by a running process: " + exePath, lastError);
            }
        }

        private static void StopCodex2FrpPortOwners(int port)
        {
            foreach (int pid in GetTcpListeningProcessIds(port))
            {
                try
                {
                    Process process = Process.GetProcessById(pid);
                    if (process.HasExited) continue;
                    if (!CouldBeCodex2FrpProcess(process.ProcessName)) continue;
                    string commandLine = GetCommandLine(process);
                    string executable = string.Empty;
                    try { executable = process.MainModule == null ? string.Empty : process.MainModule.FileName; } catch { }
                    if (!IsCodex2FrpProcess(process.ProcessName, commandLine, executable)) continue;
                    process.Kill();
                    process.WaitForExit(5000);
                }
                catch
                {
                }
            }
        }

        private static int[] GetTcpListeningProcessIds(int port)
        {
            var result = new System.Collections.Generic.List<int>();
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
                    RedirectStandardError = true
                };
                using (Process process = Process.Start(info))
                {
                    if (process == null) return result.ToArray();
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(5000);
                    string[] lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    foreach (string line in lines)
                    {
                        int pid = TryParseListeningPid(line, port);
                        if (pid > 0 && !result.Contains(pid)) result.Add(pid);
                    }
                }
            }
            catch
            {
            }
            return result.ToArray();
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

        private static bool CouldBeCodex2FrpProcess(string processName)
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

        private static bool IsCodex2FrpProcess(string processName, string commandLine, string executable)
        {
            string name = processName ?? string.Empty;
            string text = ((commandLine ?? string.Empty) + "\n" + (executable ?? string.Empty)).Replace('/', '\\');
            if (name.Equals("node", StringComparison.OrdinalIgnoreCase) || name.Equals("node.exe", StringComparison.OrdinalIgnoreCase))
            {
                return IsCodex2FrpNodeCommand(text);
            }
            if (name.Equals("powershell", StringComparison.OrdinalIgnoreCase) || name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase))
            {
                return text.IndexOf("windows-wpf-control-panel.ps1", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            if (
                name.Equals("Codex2Frp", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp.exe", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Codex2Frp.exe", StringComparison.OrdinalIgnoreCase)
            )
            {
                return true;
            }
            return false;
        }

        private static bool IsCodex2FrpNodeCommand(string text)
        {
            string value = text ?? string.Empty;
            return value.IndexOf("server.js", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("server-log-bootstrap.js", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string GetCommandLine(Process process)
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
            catch
            {
            }
            return string.Empty;
        }

        private static void PruneRuntimeDirectory(string runtimeDir)
        {
            if (!Directory.Exists(runtimeDir)) return;
            string[] replaceable = { "node-download", "node" };
            foreach (string name in replaceable)
            {
                string target = Path.Combine(runtimeDir, name);
                try
                {
                    if (Directory.Exists(target)) Directory.Delete(target, true);
                    else if (File.Exists(target)) File.Delete(target);
                }
                catch
                {
                }
            }
        }
    }

    internal sealed class ModernSetupForm : Form
    {
        private readonly InstallOptions _options;
        private readonly TextBox _installDirBox;
        private readonly Label _statusLabel;
        private readonly ProgressBar _progressBar;
        private readonly Button _installButton;
        private readonly Button _browseButton;
        private readonly Button _cancelButton;
        private bool _installing;

        public int ExitCode { get; private set; }

        public ModernSetupForm(InstallOptions options)
        {
            _options = options;
            Text = Program.AppDisplayName + " 安装程序";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 260);
            BackColor = Color.FromArgb(13, 13, 13);
            Font = new Font("Microsoft YaHei UI", 9F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = new Label
            {
                Text = "安装或更新 Codex2Frp",
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                AutoSize = false,
                Location = new Point(24, 20),
                Size = new Size(500, 32)
            };
            var subtitle = new Label
            {
                Text = "请选择安装路径。安装过程会保留 .runtime 中的 token、远程链接配置和日志。",
                ForeColor = Color.FromArgb(161, 161, 170),
                AutoSize = false,
                Location = new Point(26, 56),
                Size = new Size(500, 24)
            };
            var pathLabel = new Label
            {
                Text = "安装位置",
                ForeColor = Color.FromArgb(244, 244, 245),
                AutoSize = false,
                Location = new Point(26, 96),
                Size = new Size(120, 22)
            };
            _installDirBox = new TextBox
            {
                Text = _options.InstallDir,
                Location = new Point(26, 122),
                Size = new Size(398, 28),
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(18, 18, 18),
                ForeColor = Color.White
            };
            _browseButton = Button("浏览...", 436, 120, 92, false);
            _browseButton.Click += delegate { BrowseInstallDir(); };

            _statusLabel = new Label
            {
                Text = "准备安装",
                ForeColor = Color.FromArgb(161, 161, 170),
                AutoSize = false,
                Location = new Point(26, 166),
                Size = new Size(500, 22)
            };
            _progressBar = new ProgressBar
            {
                Location = new Point(26, 194),
                Size = new Size(502, 12),
                Minimum = 0,
                Maximum = 100,
                Style = ProgressBarStyle.Continuous
            };
            _installButton = Button("开始安装", 312, 222, 104, true);
            _cancelButton = Button("取消", 424, 222, 104, false);
            _installButton.Click += delegate { BeginInstall(); };
            _cancelButton.Click += delegate { Close(); };

            Controls.Add(title);
            Controls.Add(subtitle);
            Controls.Add(pathLabel);
            Controls.Add(_installDirBox);
            Controls.Add(_browseButton);
            Controls.Add(_statusLabel);
            Controls.Add(_progressBar);
            Controls.Add(_installButton);
            Controls.Add(_cancelButton);
            FormClosing += OnFormClosing;
        }

        private Button Button(string text, int x, int y, int width, bool primary)
        {
            var button = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 32),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
                UseVisualStyleBackColor = false,
                BackColor = primary ? Color.FromArgb(18, 64, 45) : Color.FromArgb(24, 26, 27),
                ForeColor = primary ? Color.FromArgb(142, 240, 183) : Color.FromArgb(244, 244, 245)
            };
            button.FlatAppearance.BorderColor = primary ? Color.FromArgb(48, 128, 86) : Color.FromArgb(48, 48, 48);
            return button;
        }

        private void BrowseInstallDir()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 Codex2Frp 安装位置";
                dialog.SelectedPath = _installDirBox.Text;
                dialog.ShowNewFolderButton = true;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    _installDirBox.Text = dialog.SelectedPath;
                }
            }
        }

        private void BeginInstall()
        {
            try
            {
                _options.SetInstallDir(_installDirBox.Text);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, Program.AppDisplayName + " 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            _installing = true;
            _installButton.Enabled = false;
            _browseButton.Enabled = false;
            _cancelButton.Enabled = false;
            _installDirBox.ReadOnly = true;
            _progressBar.Style = ProgressBarStyle.Marquee;
            _progressBar.MarqueeAnimationSpeed = 28;
            _statusLabel.Text = "正在准备安装...";
            var worker = new Thread(RunInstall);
            worker.IsBackground = true;
            worker.Start();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (_installing && e.CloseReason == CloseReason.UserClosing && _progressBar.Value < 100)
            {
                e.Cancel = true;
            }
        }

        private void RunInstall()
        {
            try
            {
                Installer.Run(_options, ReportProgress);
                ExitCode = 0;
                BeginInvoke((MethodInvoker)OnInstallSucceeded);
            }
            catch (Exception ex)
            {
                ExitCode = 1;
                Exception captured = ex;
                BeginInvoke((MethodInvoker)delegate { OnInstallFailed(captured); });
            }
        }

        private void ReportProgress(string status, int percent)
        {
            if (IsDisposed) return;
            BeginInvoke((MethodInvoker)delegate
            {
                _statusLabel.Text = status;
                if (percent < 0)
                {
                    if (_progressBar.Style != ProgressBarStyle.Marquee)
                    {
                        _progressBar.Style = ProgressBarStyle.Marquee;
                        _progressBar.MarqueeAnimationSpeed = 28;
                    }
                }
                else
                {
                    if (_progressBar.Style != ProgressBarStyle.Continuous)
                    {
                        _progressBar.Style = ProgressBarStyle.Continuous;
                    }
                    _progressBar.Value = Math.Min(100, Math.Max(0, percent));
                }
            });
        }

        private void OnInstallSucceeded()
        {
            _installing = false;
            _progressBar.Style = ProgressBarStyle.Continuous;
            _progressBar.Value = 100;
            _statusLabel.Text = "安装完成";
            if (_options.LaunchAfterInstall)
            {
                string exePath = Path.Combine(_options.InstallDir, Program.AppDisplayName + ".exe");
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = exePath,
                        WorkingDirectory = _options.InstallDir,
                        UseShellExecute = true
                    });
                }
                catch { }
            }
            Close();
        }

        private void OnInstallFailed(Exception ex)
        {
            _installing = false;
            MessageBox.Show(ex.ToString(), Program.AppDisplayName + " 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly InstallOptions _options;
        private readonly Label _titleLabel;
        private readonly Label _statusLabel;
        private readonly ProgressBar _progressBar;
        private bool _started;

        public int ExitCode { get; private set; }

        public SetupForm(InstallOptions options)
        {
            _options = options;

            Text = Program.AppDisplayName + " 安装程序";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(440, 132);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            _titleLabel = new Label
            {
                Text = "正在安装 " + Program.AppDisplayName,
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                AutoSize = false,
                Location = new Point(20, 16),
                Size = new Size(400, 26)
            };
            _statusLabel = new Label
            {
                Text = "正在准备…",
                ForeColor = Color.FromArgb(96, 102, 112),
                AutoSize = false,
                Location = new Point(20, 48),
                Size = new Size(400, 22)
            };
            _progressBar = new ProgressBar
            {
                Location = new Point(20, 78),
                Size = new Size(400, 18),
                Minimum = 0,
                Maximum = 100,
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 25
            };

            Controls.Add(_titleLabel);
            Controls.Add(_statusLabel);
            Controls.Add(_progressBar);

            Shown += OnShown;
            FormClosing += OnFormClosing;
        }

        private void OnShown(object sender, EventArgs e)
        {
            if (_started) return;
            _started = true;
            var worker = new Thread(RunInstall);
            worker.IsBackground = true;
            worker.Start();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            // 安装过程中不允许关闭，避免文件复制到一半被打断。
            if (_started && e.CloseReason == CloseReason.UserClosing && _progressBar.Value < 100 && Visible)
            {
                e.Cancel = true;
            }
        }

        private void RunInstall()
        {
            try
            {
                Installer.Run(_options, ReportProgress);
                ExitCode = 0;
                BeginInvoke((MethodInvoker)OnInstallSucceeded);
            }
            catch (Exception ex)
            {
                ExitCode = 1;
                Exception captured = ex;
                BeginInvoke((MethodInvoker)delegate { OnInstallFailed(captured); });
            }
        }

        private void ReportProgress(string status, int percent)
        {
            if (IsDisposed) return;
            BeginInvoke((MethodInvoker)delegate
            {
                _statusLabel.Text = status;
                if (percent < 0)
                {
                    if (_progressBar.Style != ProgressBarStyle.Marquee)
                    {
                        _progressBar.Style = ProgressBarStyle.Marquee;
                    }
                }
                else
                {
                    if (_progressBar.Style != ProgressBarStyle.Continuous)
                    {
                        _progressBar.Style = ProgressBarStyle.Continuous;
                    }
                    _progressBar.Value = Math.Min(100, Math.Max(0, percent));
                }
            });
        }

        private void OnInstallSucceeded()
        {
            _progressBar.Style = ProgressBarStyle.Continuous;
            _progressBar.Value = 100;
            _statusLabel.Text = "安装完成";
            Hide();

            MessageBox.Show(
                Program.AppDisplayName + " 已安装或更新完成。\n\n可以从桌面快捷方式或开始菜单启动。",
                Program.AppDisplayName + " 安装程序",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );

            if (_options.LaunchAfterInstall)
            {
                string exePath = Path.Combine(_options.InstallDir, Program.AppDisplayName + ".exe");
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = exePath,
                        WorkingDirectory = _options.InstallDir,
                        UseShellExecute = true
                    });
                }
                catch
                {
                }
            }
            Close();
        }

        private void OnInstallFailed(Exception ex)
        {
            Hide();
            MessageBox.Show(
                ex.ToString(),
                Program.AppDisplayName + " 安装程序",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            Close();
        }
    }

    internal sealed class InstallOptions
    {
        public string InstallDir { get; private set; }

        public bool Silent { get; private set; }

        public bool LaunchAfterInstall { get; private set; }

        public bool CreateShortcut { get; private set; }

        private InstallOptions()
        {
            InstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                PickDefaultInstallFolder()
            );
            LaunchAfterInstall = true;
            CreateShortcut = true;
        }

        private static string PickDefaultInstallFolder()
        {
            string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs");
            string modern = Path.Combine(programs, Program.AppDisplayName);
            string legacy = Path.Combine(programs, Program.LegacyAppDisplayName);
            if (Directory.Exists(legacy) && !Directory.Exists(modern)) return Program.LegacyAppDisplayName;
            return Program.AppDisplayName;
        }

        public static InstallOptions Parse(string[] args)
        {
            var options = new InstallOptions();
            int argCount = args == null ? 0 : args.Length;
            for (int i = 0; i < argCount; i += 1)
            {
                string arg = args[i] ?? string.Empty;
                if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase))
                {
                    options.Silent = true;
                    options.LaunchAfterInstall = false;
                    continue;
                }
                if (arg.Equals("--no-launch", StringComparison.OrdinalIgnoreCase))
                {
                    options.LaunchAfterInstall = false;
                    continue;
                }
                if (arg.Equals("--no-shortcut", StringComparison.OrdinalIgnoreCase))
                {
                    options.CreateShortcut = false;
                    continue;
                }
                if (arg.StartsWith("--install-dir=", StringComparison.OrdinalIgnoreCase))
                {
                    options.InstallDir = NormalizeInstallDir(arg.Substring("--install-dir=".Length));
                    continue;
                }
                if (arg.Equals("--install-dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    i += 1;
                    options.InstallDir = NormalizeInstallDir(args[i]);
                }
            }
            return options;
        }

        public void SetInstallDir(string value)
        {
            InstallDir = NormalizeInstallDir(value);
        }

        private static string NormalizeInstallDir(string value)
        {
            string candidate = (value ?? string.Empty).Trim().Trim('"');
            if (candidate.Length == 0) throw new ArgumentException("Install directory cannot be empty.");
            string full = Path.GetFullPath(candidate);
            if (full.Length < 4) throw new ArgumentException("Install directory is not valid.");
            return full;
        }
    }
}
