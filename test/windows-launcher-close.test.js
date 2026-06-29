'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const launcherSource = fs.readFileSync(
  path.join(__dirname, '..', 'windows', 'launcher', 'Codex2FrpLauncher.cs'),
  'utf8',
);
const setupManifestSource = fs.readFileSync(
  path.join(__dirname, '..', 'windows', 'installer', 'Codex2FrpSetup.manifest'),
  'utf8',
);
const setupSource = fs.readFileSync(
  path.join(__dirname, '..', 'windows', 'installer', 'Codex2FrpSetup.cs'),
  'utf8',
);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function bodyAfter(marker) {
  return bodyAfterIn(launcherSource, marker);
}

function bodyAfterIn(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} exists`);
  const brace = source.indexOf('{', start);
  assert.notEqual(brace, -1, `${marker} has a body`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, index);
    }
  }
  throw new Error(`${marker} body not found`);
}

test('launcher close button asks before either exiting all backend processes or minimizing', () => {
  const closeBody = bodyAfter('protected override void OnFormClosing(FormClosingEventArgs e)');
  assert.match(closeBody, /ShouldPromptForClose\(e\.CloseReason\)/, 'close interception uses an explicit close-reason policy');
  assert.match(closeBody, /MessageBox\.Show\(/, 'the close button asks for confirmation');
  assert.match(closeBody, /MessageBoxButtons\.YesNo/, 'confirmation offers yes/no choices');
  assert.match(closeBody, /MessageBoxDefaultButton\.Button2/, 'No is the default to avoid accidental shutdown');
  assert.match(closeBody, /ShutdownAllProcessesForExit\(\)/, 'Yes path shuts down all backend-related processes');
  assert.match(closeBody, /MinimizeToTaskbar\(\)/, 'No path keeps the app available from the taskbar');
  assert.match(closeBody, /e\.Cancel\s*=\s*true/, 'No path cancels the close event');
});

test('launcher close-reason policy also catches raw WM_CLOSE automation', () => {
  const policyBody = bodyAfter('private static bool ShouldPromptForClose(CloseReason reason)');
  assert.match(policyBody, /CloseReason\.UserClosing/, 'normal title-bar and Alt+F4 closes require confirmation');
  assert.match(policyBody, /CloseReason\.None/, 'raw WM_CLOSE messages also require confirmation instead of exiting silently');
  assert.match(policyBody, /CloseReason\.TaskManagerClosing/, 'external close requests still require confirmation and cleanup');
  assert.doesNotMatch(policyBody, /CloseReason\.WindowsShutDown/, 'Windows shutdown is not blocked by a confirmation dialog');
});

test('launcher exit shutdown is stronger than the ordinary stop button', () => {
  const shutdownBody = bodyAfter('private void ShutdownAllProcessesForExit()');
  assert.match(shutdownBody, /StopServer\(\)/, 'exit shutdown first uses the normal service stop path');
  assert.match(shutdownBody, /Program\.StopRelatedProcesses\(_paths\.ProjectRoot,\s*true\)/, 'exit shutdown also kills known helper PowerShell processes');
  assert.match(shutdownBody, /Program\.StopKnownPortOwners\(Program\.ServicePort,\s*_paths\.ProjectRoot\)/, 'exit shutdown clears stale port owners');
  assert.match(shutdownBody, /TryDelete\(_paths\.PidPath\)/, 'exit shutdown removes stale pid state');

  const stopBody = bodyAfter('private void StopServer()');
  assert.match(stopBody, /Program\.StopRelatedProcesses\(_paths\.ProjectRoot,\s*false\)/, 'ordinary stop remains conservative about PowerShell');
});

test('launcher minimizing keeps a visible taskbar entry instead of leaving a hidden tray-only process', () => {
  const minimizeBody = bodyAfter('private void MinimizeToTaskbar()');
  assert.match(minimizeBody, /ShowInTaskbar\s*=\s*true/, 'minimized panel remains findable from the taskbar');
  assert.match(minimizeBody, /Visible\s*=\s*true/, 'the form is not hidden into the notification area');
  assert.match(minimizeBody, /WindowState\s*=\s*FormWindowState\.Minimized/, 'No answer minimizes the existing panel');
});

test('manual start-service keeps a visible control panel unless explicitly silent', () => {
  const mainBody = bodyAfter('private static int Main(string[] args)');
  assert.match(mainBody, /silentAutomation/, 'launcher distinguishes silent automation from manual start-service');
  assert.match(mainBody, /StartServiceAndShowPanel/, 'manual start-service starts backend and keeps the panel visible');
  assert.match(mainBody, /Application\.Run\(form\)/, 'visible start-service enters the WinForms message loop');
});

test('launcher display version follows package version', () => {
  const versionMatch = launcherSource.match(/internal const string AppVersion = "([^"]+)";/);
  assert.ok(versionMatch, 'launcher declares the visible app version');
  assert.equal(versionMatch[1], packageJson.version, 'launcher UI version matches package.json');
  const manifestVersion = setupManifestSource.match(/assemblyIdentity version="([^"]+)"/);
  assert.ok(manifestVersion, 'setup manifest declares an assembly version');
  assert.equal(manifestVersion[1], `${packageJson.version}.0`, 'setup manifest version matches package.json');
});

test('manual start button starts backend outside the UI thread', () => {
  assert.match(launcherSource, /_startButton\.Click\s*\+=\s*delegate\s*\{\s*BeginStartServer\(\);\s*\};/, 'start button delegates to a non-blocking launcher path');
  assert.doesNotMatch(launcherSource, /_startButton\.Click\s*\+=\s*delegate\s*\{\s*RunUiAction\(StartServer\);\s*\};/, 'start button must not synchronously run StartServer on the WinForms UI thread');
  assert.doesNotMatch(launcherSource, /Shown\s*\+=\s*delegate\s*\{[\s\S]*BeginStartServer\(\);[\s\S]*\};/, 'ordinary launcher startup must not start the backend service automatically');
  assert.match(launcherSource, /Shown\s*\+=\s*delegate\s*\{[\s\S]*EnsureReadableWindowBounds\(\);[\s\S]*\};/, 'ordinary launcher startup restores a readable window size before updating state');

  const beginBody = bodyAfter('private void BeginStartServer()');
  assert.match(beginBody, /ThreadPool\.QueueUserWorkItem/, 'backend startup work is queued outside the UI thread');
  assert.match(beginBody, /BeginInvoke\(/, 'UI updates are marshalled back to the WinForms thread');
  assert.match(beginBody, /StartServer\(\)/, 'the non-blocking path still uses the normal startup implementation');
});

test('launcher accepts an already healthy installed backend even if the pid is stale', () => {
  const startBody = bodyAfter('private void StartServer()');
  const processBody = bodyAfter('private Process GetServerProcess()');
  assert.match(startBody, /GetServerProcess\(\)[\s\S]*WaitForServerHealth\(token,\s*1500\)[\s\S]*return;/, 'startup keeps an already healthy installed backend instead of stopping it first');
  assert.match(startBody, /process == null && WaitForServerHealth\(token,\s*20000\)/, 'startup treats a healthy local backend as success when a duplicate child exits');
  assert.match(startBody, /TryDelete\(_paths\.PidPath\)[\s\S]*return;/, 'stale pid state is cleared after adopting the healthy backend');
  assert.match(processBody, /WaitForServerHealth\(token,\s*800\)/, 'status refresh can verify a server even when server.pid is missing');
  assert.match(processBody, /Program\.GetTcpListeningProcessIds\(Program\.ServicePort\)/, 'status refresh can recover the real PID from the listening port');
  assert.match(processBody, /File\.WriteAllText\(_paths\.PidPath,\s*process\.Id\.ToString\(\)/, 'recovered healthy server PID is written back for later refreshes');
});

test('status refresh does not synchronously query backend config for Sakura preview', () => {
  const previewBody = bodyAfter('private string GetSakuraUrlPreview()');
  assert.doesNotMatch(previewBody, /GetLocalJson\(/, 'preview rendering must not block the UI on /codex/config');
  assert.doesNotMatch(previewBody, /PostLocalJson\(/, 'preview rendering must not trigger backend reconciliation from the UI timer');
  assert.match(previewBody, /BuildSakuraUrlBaseFromFields\(\)/, 'preview can still show the configured Sakura URL from local fields');
});

test('launcher Sakura form starts empty and validates before saving', () => {
  assert.match(launcherSource, /internal const string DefaultSakuraDomain = "";/, 'launcher must not prefill a personal Sakura domain');
  assert.match(launcherSource, /internal const string DefaultSakuraTunnelId = "";/, 'launcher must not prefill a personal Sakura tunnel id');
  assert.match(launcherSource, /internal const string DefaultSakuraRemotePort = "";/, 'launcher must not prefill a personal Sakura remote port');
  assert.doesNotMatch(launcherSource, /Caption\("隧道 ID"|ModernCaption\("隧道 ID"|ResponsiveCaption\("隧道 ID"/, 'launcher should not expose tunnel id as a primary Sakura form field');
  assert.doesNotMatch(launcherSource, /API 密钥|访问密钥|_accessKeyBox|CachedApiTokenPlaceholder/, 'launcher should not expose or retain API key form state');
  assert.doesNotMatch(launcherSource, /_detectSakuraButton|AutoDetectSakuraConfig|\/codex\/sakura\/discover/, 'launcher should not expose Sakura auto-detection');

  const saveBody = bodyAfter('private void SaveSakuraConfig()');
  assert.match(saveBody, /ValidateSakuraForm\(\)/, 'save checks local form values before posting');
  assert.match(saveBody, /EnsureRemoteLinkAvailable\(route\)/, 'save verifies the actual manual remote URL');
  assert.doesNotMatch(saveBody, /apiToken|accessKey|CachedApiTokenPlaceholder|\/codex\/sakura\/reconcile|ExtractSakuraResultOk/, 'save no longer has API-key or auto-reconcile branches');
  assert.match(saveBody, /RemoteUnavailableMessage/, 'save shows a clear unavailable message instead of silently succeeding');
  assert.match(saveBody, /_detailsBox\.Text/, 'save writes the result into the visible details area');
});

test('launcher uses remote-link wording and a single remote-unavailable prompt', () => {
  const stringLiterals = [...launcherSource.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(match => match[1]);
  const visibleText = stringLiterals
    .filter(text => /[\u4e00-\u9fff]|Sakura|sakura/i.test(text))
    .filter(text => !/^\/codex\/sakura\//.test(text))
    .filter(text => !/kind\\"\\s\*:|sakura\\"|server-log-bootstrap|Codex2Frp|Software\\Microsoft/.test(text))
    .join('\n');
  assert.doesNotMatch(visibleText, /Sakura/i, 'visible launcher strings should say remote link instead of Sakura');

  assert.match(launcherSource, /RemoteUnavailableMessage/, 'launcher centralizes the remote-unavailable user prompt');
  assert.match(launcherSource, /远程连接网络未启动，当前仅支持局域网连接。/, 'launcher uses the required unavailable wording');

  const copyBody = bodyAfter('private string GetSakuraUrl()');
  assert.match(copyBody, /EnsureRemoteLinkAvailable\(route\)/, 'copying the remote link reuses the same remote availability check');
  assert.doesNotMatch(copyBody, /VerifyRemoteHealth\(route\)/, 'copying the remote link should not throw a different health-check message');

  const saveBody = bodyAfter('private void SaveSakuraConfig()');
  assert.match(saveBody, /EnsureRemoteLinkAvailable\(route\)/, 'saving the remote form reuses the same remote availability check');
  assert.doesNotMatch(saveBody, /SakuraFrp 不可用|SakuraFrp 配置可用|SakuraFrp route is ready/, 'save result text should not expose Sakura branding');
});

test('launcher locks cached Sakura form while service is running and unlocks it for stopped edits', () => {
  assert.match(launcherSource, /_editSakuraButton/, 'launcher exposes a modify form button');
  assert.match(launcherSource, /LoadSakuraCachedForm/, 'launcher can populate the Sakura form from cached backend config');
  assert.match(launcherSource, /ApplySakuraFormLockState/, 'launcher centralizes Sakura form lock styling');
  assert.match(launcherSource, /UnlockSakuraFormForEdit/, 'launcher has an explicit stopped-service edit action');

  const loadBody = bodyAfter('private void LoadSakuraCachedForm()');
  assert.match(loadBody, /\/codex\/sakura\/status/, 'cached Sakura form is read from the backend status endpoint');
  assert.match(loadBody, /preferredDomain/, 'cached Sakura domain is restored into the form');
  assert.match(loadBody, /remotePort/, 'cached Sakura remote port is restored into the form');
  assert.doesNotMatch(loadBody, /apiTokenMasked|apiTokenPresent|_sakuraCachedApiTokenPresent/, 'cached Sakura form no longer tracks API-token state');
  assert.match(loadBody, /_sakuraFormFromCache\s*=\s*true/, 'cached form state is marked as cache-derived');

  const lockBody = bodyAfter('private void ApplySakuraFormLockState(bool running)');
  assert.match(lockBody, /running && _sakuraFormFromCache && !_sakuraFormEditMode/, 'cached values lock only while service is running');
  assert.match(lockBody, /_domainBox\.ReadOnly\s*=\s*locked/, 'domain field is locked when cache-derived and running');
  assert.match(lockBody, /_remotePortBox\.ReadOnly\s*=\s*locked/, 'remote port field is locked when cache-derived and running');
  assert.doesNotMatch(lockBody, /_accessKeyBox|_detectSakuraButton/, 'lock state only manages the remaining manual host and port fields');
  assert.match(lockBody, /Color\.FromArgb\(38,\s*42,\s*46\)/, 'locked cached fields use a gray fill');
  assert.match(lockBody, /_editSakuraButton\.Enabled\s*=\s*!running/, 'modify button is only usable after stopping the service');

  const unlockBody = bodyAfter('private void UnlockSakuraFormForEdit()');
  assert.match(unlockBody, /GetServerProcess\(\)\s*!=\s*null/, 'modify action refuses while the service is still running');
  assert.match(unlockBody, /_sakuraFormEditMode\s*=\s*true/, 'modify action switches the form into edit mode');
  assert.match(unlockBody, /ApplySakuraFormLockState\(false\)/, 'modify action refreshes editable field styling');
  assert.doesNotMatch(unlockBody, /API 密钥|_accessKeyBox|CachedApiTokenPlaceholder/, 'modify guidance only mentions the remaining link and port fields');

  const statusBody = bodyAfter('private void UpdateModernStatus()');
  assert.match(statusBody, /QueueStatusRefresh\(\)/, 'status refresh delegates expensive work to the background refresh path');
  assert.doesNotMatch(statusBody, /GetServerProcess\(|GetLocalJson\(|ReadLogTail\(|CheckRemoteUnavailableNotice\(/, 'status refresh does not run process, network, log, or remote checks on the UI thread');
  const buildSnapshotBody = bodyAfter('private StatusSnapshot BuildStatusSnapshot');
  assert.match(buildSnapshotBody, /GetLocalJson\("\/codex\/sakura\/status",\s*2500\)/, 'background status snapshot imports cached Sakura values with a short timeout');
  assert.match(buildSnapshotBody, /ReadLogTail\(_paths\.StdoutPath,\s*32\)/, 'background status snapshot reads logs outside the UI thread');
  const applySnapshotBody = bodyAfter('private void ApplyStatusSnapshot');
  assert.match(applySnapshotBody, /_sakuraFormFromCache\s*=\s*true/, 'applying a background snapshot marks restored Sakura values as cache-derived');
  assert.match(applySnapshotBody, /ApplySakuraFormLockState\(snapshot\.Running\)/, 'applying a background snapshot locks cached fields while the service is running');

  const saveBody = bodyAfter('private void SaveSakuraConfig()');
  assert.match(saveBody, /_sakuraFormFromCache\s*=\s*false/, 'saving clears the cache-derived marker');
  assert.match(saveBody, /_sakuraFormEditMode\s*=\s*false/, 'saving exits edit mode after validation');
});

test('launcher status and long actions stay off the WinForms UI thread', () => {
  assert.doesNotMatch(launcherSource, /Application\.DoEvents\(\)/, 'launcher must not pump nested UI events during busy states');
  const queueBody = bodyAfter('private void QueueStatusRefresh()');
  assert.match(queueBody, /Interlocked\.CompareExchange/, 'status refresh coalesces overlapping timer ticks');
  assert.match(queueBody, /ThreadPool\.QueueUserWorkItem/, 'status refresh work runs outside the UI thread');
  assert.match(queueBody, /BeginInvoke\(/, 'status refresh applies results back on the WinForms thread');
  assert.match(queueBody, /BuildStatusSnapshot\(request\)/, 'status refresh gathers process, network, and log state in a snapshot');

  const cdpButtonBody = launcherSource.slice(launcherSource.indexOf('cdpButton.Click'), launcherSource.indexOf('_saveSakuraButton.Click'));
  assert.match(cdpButtonBody, /StartCodexCdp\(\)/, 'Codex control click opens confirmation immediately on the UI thread');
  const cdpBody = bodyAfter('private void StartCodexCdp()');
  assert.match(cdpBody, /RunBackgroundUiAction/, 'Codex control startup runs after confirmation on a background worker');
  assert.match(cdpBody, /PostLocalJson\("\/codex\/control-port"/, 'Codex control still calls the backend control-port endpoint');

  const openBody = launcherSource.slice(launcherSource.indexOf('openButton.Click'), launcherSource.indexOf('copyLocalButton.Click'));
  assert.match(openBody, /RunBackgroundUiAction/, 'open console action does not start the backend on the UI thread');
  const remoteCopyBody = launcherSource.slice(launcherSource.indexOf('copySakuraButton.Click'), launcherSource.indexOf('logsButton.Click'));
  assert.match(remoteCopyBody, /RunBackgroundUiAction/, 'remote-link copy does not run remote health checks on the UI thread');
});

test('installer stops stale backend that only exposes itself through the service port', () => {
  assert.match(setupSource, /internal const int ServicePort = 8988;/, 'installer should share the backend service port');

  const stopMatch = setupSource.match(/private static void StopInstalledCodex2FrpProcesses\(string installDir\)\s*\{([\s\S]*?)\n        \}/);
  assert.ok(stopMatch, 'installer process cleanup method should exist');
  assert.match(stopMatch[1], /StopCodex2FrpPortOwners\(Program\.ServicePort\)/, 'installer should clear stale port owners after path-based cleanup');
  assert.match(setupSource, /WaitForInstalledLauncherUnlock\(options\.InstallDir\)/, 'installer should wait for the installed launcher handle before replacing files');
  assert.match(setupSource, /FileShare\.None/, 'installer should verify exclusive access to the old launcher file');

  const portMatch = setupSource.match(/private static void StopCodex2FrpPortOwners\(int port\)\s*\{([\s\S]*?)\n        \}/);
  assert.ok(portMatch, 'installer should include port-owner cleanup');
  assert.match(portMatch[1], /GetTcpListeningProcessIds\(port\)/, 'installer should enumerate listening PIDs');
  assert.match(portMatch[1], /IsCodex2FrpProcess\(process\.ProcessName,\s*commandLine,\s*executable\)/, 'installer should still only stop Codex2Frp-like processes');
});

test('installer and launcher recognize the bootstrap node service as backend-owned', () => {
  assert.match(setupSource, /server-log-bootstrap\.js/, 'installer cleanup recognizes the installed bootstrap service process');
  assert.match(launcherSource, /server-log-bootstrap\.js/, 'launcher process cleanup recognizes the installed bootstrap service process');

  const setupProcessBody = bodyAfterIn(setupSource, 'private static bool IsCodex2FrpProcess(string processName, string commandLine, string executable)');
  assert.match(setupProcessBody, /IsCodex2FrpNodeCommand\(text\)/, 'installer treats node ownership through a shared command matcher');
  assert.match(bodyAfterIn(setupSource, 'private static bool IsCodex2FrpNodeCommand(string text)'), /server-log-bootstrap\.js/, 'installer treats bootstrap node as a Codex2Frp process');

  const launcherNodeBody = bodyAfter('private static bool IsKnownCodexNode(string commandLine, string executable, string fullInstallDir)');
  assert.match(launcherNodeBody, /IsCodex2FrpNodeCommand\(commandLine\)/, 'launcher treats node ownership through a shared command matcher');
  assert.match(bodyAfter('private static bool IsCodex2FrpNodeCommand(string commandLine)'), /server-log-bootstrap\.js/, 'launcher treats bootstrap node as a Codex2Frp node process');
});
