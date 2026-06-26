param(
  [string]$CodexExe = "",
  [int]$CdpPort = 39252,
  [string]$CdpAddress = "localhost",
  [string]$UserDataDir = "",
  [int]$ReadyTimeoutSeconds = 35,
  [switch]$OpenAfterPrepare,
  [switch]$AllowIsolatedProfile,
  [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

function Test-CodexCdpReady {
  param([int]$Port)
  $hosts = @("127.0.0.1", "localhost", "[::1]")
  foreach ($hostName in $hosts) {
    try {
      $targets = Invoke-RestMethod -Uri "http://$hostName`:$Port/json/list" -TimeoutSec 3
      foreach ($target in @($targets)) {
        if ($target.type -eq "page" -and $target.webSocketDebuggerUrl -and [string]$target.url -like "app://-/index.html*") {
          return $true
        }
      }
    } catch {
    }
  }
  return $false
}

function Find-CodexExe {
  param([string]$Explicit)
  $candidates = @()
  if ($Explicit) { $candidates += $Explicit }
  if ($env:CODEX_DESKTOP_EXECUTABLE_PATH) { $candidates += $env:CODEX_DESKTOP_EXECUTABLE_PATH }

  try {
    $runningDesktop = Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" |
      Where-Object {
        $exe = [string]$_.ExecutablePath
        $exe -and (($exe -replace '/', '\') -match '\\app\\Codex\.exe$')
      } |
      Select-Object -First 1 -ExpandProperty ExecutablePath
    if ($runningDesktop) { $candidates += $runningDesktop }
  } catch {
  }

  try {
    $packages = @(Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue)
    foreach ($package in $packages) {
      if ($package.InstallLocation) {
        $candidates += Join-Path $package.InstallLocation "app\Codex.exe"
      }
    }
  } catch {
  }

  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Codex\Codex.exe"
    $candidates += Join-Path $env:LOCALAPPDATA "Codex\Codex.exe"
  }
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles "Codex\Codex.exe" }
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} "Codex\Codex.exe" }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return ""
}

function Get-CodexAumid {
  try {
    $package = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($package -and $package.PackageFamilyName) {
      return "$($package.PackageFamilyName)!App"
    }
  } catch {
  }
  return ""
}

function Start-CodexPackagedApp {
  param(
    [string]$Aumid,
    [string[]]$Arguments
  )

  if (-not $Aumid) { throw "Codex Appx AUMID was not found." }

  if (-not ("Codex2Frp.ApplicationActivationManager" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace Codex2Frp {
  [Flags]
  public enum ActivateOptions {
    None = 0,
    DesignMode = 1,
    NoErrorUI = 2,
    NoSplashScreen = 4
  }

  [ComImport]
  [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IApplicationActivationManager {
    int ActivateApplication(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments,
      ActivateOptions options,
      out uint processId
    );

    int ActivateForFile(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      IntPtr itemArray,
      [MarshalAs(UnmanagedType.LPWStr)] string verb,
      out uint processId
    );

    int ActivateForProtocol(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      IntPtr itemArray,
      out uint processId
    );
  }

  [ComImport]
  [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  public class ApplicationActivationManager {
  }

  public static class PackagedApp {
    public static int Activate(string appUserModelId, string arguments, out uint processId) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      return manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
    }
  }
}
"@
  }

  $argumentString = ($Arguments | ForEach-Object { [string]$_ }) -join " "
  $activatedProcessId = [uint32]0
  $hr = [Codex2Frp.PackagedApp]::Activate($Aumid, $argumentString, [ref]$activatedProcessId)
  if ($hr -ne 0) {
    throw ("ActivateApplication failed for {0}, HRESULT 0x{1:X8}" -f $Aumid, ($hr -band 0xffffffff))
  }
  Write-Host "Activated packaged Codex app: $Aumid pid=$activatedProcessId"
}

function Start-CodexDesktop {
  param(
    [string]$ExecutablePath,
    [string[]]$Arguments
  )

  $normalized = ([string]$ExecutablePath) -replace '/', '\'
  if ($normalized -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\Codex\.exe$') {
    $aumid = Get-CodexAumid
    Start-CodexPackagedApp -Aumid $aumid -Arguments $Arguments
    return
  }

  Start-Process -FilePath $ExecutablePath -ArgumentList $Arguments -WindowStyle Normal
}

function Get-CodexProcessCommandLines {
  try {
    return @(Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" |
      Where-Object {
        $exe = [string]$_.ExecutablePath
        $cmd = [string]$_.CommandLine
        $exe -and (($exe -replace '/', '\') -match '\\app\\Codex\.exe$') -and
          $cmd -and ($cmd -notmatch '\s--type=')
      } |
      Select-Object -ExpandProperty CommandLine |
      Where-Object { $_ })
  } catch {
    return @()
  }
}

function Get-CodexCdpProcessPorts {
  try {
    $ports = @(Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" |
      Where-Object {
        $exe = [string]$_.ExecutablePath
        $cmd = [string]$_.CommandLine
        $exe -and (($exe -replace '/', '\') -match '\\app\\Codex\.exe$') -and
          $cmd -and ($cmd -notmatch '\s--type=') -and
          ($cmd -match '--remote-debugging-port=(\d+)')
      } |
      ForEach-Object {
        $cmd = [string]$_.CommandLine
        if ($cmd -match '--remote-debugging-port=(\d+)') { [int]$Matches[1] }
      } |
      Sort-Object -Unique)
    return $ports
  } catch {
    return @()
  }
}

function Stop-StaleCodexCdpProcesses {
  param(
    [int]$Port,
    [string]$ProfileDir
  )

  $normalizedProfile = ([string]$ProfileDir) -replace '/', '\'
  try {
    $targets = @(Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" |
      Where-Object {
        $command = [string]$_.CommandLine
        if (-not $command) { return $false }
        if ($command -match "--remote-debugging-port=$Port") { return $true }
        if ($normalizedProfile -and (($command -replace '/', '\').Contains($normalizedProfile))) { return $true }
        return $false
      })
    $mainTargets = @($targets | Where-Object {
      $command = [string]$_.CommandLine
      $command -and $command -notmatch '\s--type='
    })
    if ($mainTargets.Count -eq 0) { $mainTargets = $targets }
    foreach ($target in $mainTargets) {
      & taskkill.exe /PID $target.ProcessId /T /F > $null 2> $null
      if ($LASTEXITCODE -ne 0) {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
    if ($targets.Count -gt 0) {
      Write-Host "Stopped stale Codex CDP processes: $($targets.Count)"
      Start-Sleep -Milliseconds 1500
    }
  } catch {
  }
}

function Stop-CodexDesktopProcesses {
  try {
    $targets = @(Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" |
      Where-Object {
        $exe = [string]$_.ExecutablePath
        $exe -and (($exe -replace '/', '\') -match '\\app\\Codex\.exe$')
      })
    $mainTargets = @($targets | Where-Object {
      $command = [string]$_.CommandLine
      $command -and $command -notmatch '\s--type='
    })
    if ($mainTargets.Count -eq 0) { $mainTargets = $targets }
    foreach ($target in $mainTargets) {
      & taskkill.exe /PID $target.ProcessId /T /F > $null 2> $null
      if ($LASTEXITCODE -ne 0) {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
    if ($targets.Count -gt 0) {
      Write-Host "Closed existing Codex windows before starting controlled Codex: $($targets.Count)"
      Start-Sleep -Milliseconds 1800
    }
  } catch {
  }
}

$codexPath = Find-CodexExe -Explicit $CodexExe
Write-Host "CDP: http://127.0.0.1:$CdpPort/json/list"

if (-not $OpenAfterPrepare) {
  if ($codexPath) {
    Write-Host "Prepared Windows Codex CDP launcher"
    Write-Host "Executable: $codexPath"
    $aumid = Get-CodexAumid
    if ($aumid) { Write-Host "Appx AUMID: $aumid" }
  } else {
    Write-Host "Prepared Windows Codex CDP launcher, but Codex.exe was not found"
    Write-Host "Pass -CodexExe or set CODEX_DESKTOP_EXECUTABLE_PATH before opening"
  }
  exit 0
}

if ((-not $ForceRestart) -and (Test-CodexCdpReady -Port $CdpPort)) {
  Write-Host "Codex CDP target already ready"
  exit 0
}

$existingCdpPorts = Get-CodexCdpProcessPorts
if ($existingCdpPorts.Count -gt 0 -and -not $ForceRestart) {
  foreach ($existingCdpPort in $existingCdpPorts) {
    if (Test-CodexCdpReady -Port $existingCdpPort) {
      Write-Host "Codex CDP target already ready on port $existingCdpPort"
      exit 0
    }
  }
  [Console]::Error.WriteLine("Codex CDP is already running on port(s) $($existingCdpPorts -join ', '), but is not ready; refusing to open another controlled Codex client.")
  exit 4
}

if ($ForceRestart) {
  Stop-CodexDesktopProcesses
}

$runningCommands = Get-CodexProcessCommandLines
$launchUserDataDir = [string]$UserDataDir
if ($runningCommands.Count -gt 0) {
  $hasNonCdpDesktop = $runningCommands | Where-Object { $_ -notmatch "--remote-debugging-port=$CdpPort" }
  if ($hasNonCdpDesktop) {
    if ($ForceRestart) {
      Stop-CodexDesktopProcesses
      $runningCommands = @()
      $hasNonCdpDesktop = @()
    }
  }
}

if ($runningCommands.Count -gt 0) {
  $hasNonCdpDesktop = $runningCommands | Where-Object { $_ -notmatch "--remote-debugging-port=$CdpPort" }
  if ($hasNonCdpDesktop) {
    if (-not $AllowIsolatedProfile) {
      [Console]::Error.WriteLine("Codex is already running without CDP. Quit Codex completely, then rerun this script.")
      exit 3
    }
    if (-not $launchUserDataDir) {
      $launchUserDataDir = if ($env:CODEX2FRP_WINDOWS_CDP_PROFILE_DIR) {
        $env:CODEX2FRP_WINDOWS_CDP_PROFILE_DIR
      } else {
        Join-Path $ProjectRoot ".runtime\codex-cdp-profile"
      }
    }
    New-Item -ItemType Directory -Force -Path $launchUserDataDir | Out-Null
    Write-Host "Codex is already running without CDP; opening an isolated CDP profile."
    Write-Host "CDP profile: $launchUserDataDir"
  }
}

if (-not $codexPath) {
  [Console]::Error.WriteLine("Codex.exe was not found. Pass -CodexExe or set CODEX_DESKTOP_EXECUTABLE_PATH.")
  exit 1
}

$arguments = @(
  "--remote-debugging-address=$CdpAddress",
  "--remote-debugging-port=$CdpPort",
  "--remote-allow-origins=http://$CdpAddress`:$CdpPort",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  "--window-size=980,650"
)

if ($launchUserDataDir) {
  Stop-StaleCodexCdpProcesses -Port $CdpPort -ProfileDir $launchUserDataDir
  $arguments = @("--user-data-dir=`"$launchUserDataDir`"") + $arguments
}

Start-CodexDesktop -ExecutablePath $codexPath -Arguments $arguments

$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 750
  if (Test-CodexCdpReady -Port $CdpPort) {
    Write-Host "Opened Codex with CDP and verified target ready"
    exit 0
  }
}

[Console]::Error.WriteLine("Codex was launched, but CDP did not become ready within $ReadyTimeoutSeconds seconds")
exit 2
