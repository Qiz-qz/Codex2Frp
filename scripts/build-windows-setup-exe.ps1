param(
  [string]$OutputName = "Codex2FrpSetup.exe"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DistDir = Join-Path $ProjectRoot "dist"
$StageDir = Join-Path $DistDir "windows-setup-stage"
$PayloadDir = Join-Path $StageDir "payload"
$PayloadZip = Join-Path $StageDir "payload.zip"
$Source = Join-Path $ProjectRoot "windows\installer\Codex2FrpSetup.cs"
$Manifest = Join-Path $ProjectRoot "windows\installer\Codex2FrpSetup.manifest"
$Output = Join-Path $DistDir $OutputName
$Icon = Join-Path $ProjectRoot "windows\assets\codex2frp.ico"
$BuildStamp = Get-Date

$PackageJson = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$Version = [string]$PackageJson.version
if (-not $Version) { throw "package.json does not declare a version" }

$cscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) {
  throw "Windows C# compiler was not found."
}
if (-not (Test-Path -LiteralPath $Icon -PathType Leaf)) {
  throw "Setup icon was not found: $Icon"
}
if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
  throw "Setup manifest was not found: $Manifest"
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
if (Test-Path -LiteralPath $StageDir) {
  Remove-Item -LiteralPath $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PayloadDir | Out-Null

& (Join-Path $ProjectRoot "scripts\build-windows-launcher.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Launcher build failed with exit code $LASTEXITCODE"
}

$items = @(
  ".runtime\\node-download",
  "lib",
  "public",
  "bin",
  "server.js",
  "package.json",
  "Codex2Frp.exe",
  "LICENSE",
  "NOTICE"
)

$scriptItems = @(
  "start-windows-local.ps1",
  "launch-main-codex-cdp.ps1",
  "server-log-bootstrap.js"
)

foreach ($item in $items) {
  $sourcePath = Join-Path $ProjectRoot $item
  if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
  $targetPath = Join-Path $PayloadDir $item
  if (Test-Path -LiteralPath $sourcePath -PathType Container) {
    New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
    foreach ($child in (Get-ChildItem -LiteralPath $sourcePath -Force)) {
      Copy-Item -LiteralPath $child.FullName -Destination $targetPath -Recurse -Force
    }
  } else {
    $parent = Split-Path -Parent $targetPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
  }
}

$payloadScripts = Join-Path $PayloadDir "scripts"
New-Item -ItemType Directory -Force -Path $payloadScripts | Out-Null
foreach ($scriptItem in $scriptItems) {
  $sourcePath = Join-Path (Join-Path $ProjectRoot "scripts") $scriptItem
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Required Windows runtime script is missing: $sourcePath" }
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $payloadScripts $scriptItem) -Force
}

Get-ChildItem -LiteralPath $PayloadDir -Recurse -Force -File |
  Where-Object { $_.Extension -match '^\.(md|markdown)$' } |
  Remove-Item -Force

# Package only the extracted Node runtime; the zip cache duplicates about 37 MB.
$payloadNodeDownload = Join-Path $PayloadDir ".runtime\node-download"
if (Test-Path -LiteralPath $payloadNodeDownload -PathType Container) {
  Get-ChildItem -LiteralPath $payloadNodeDownload -Force -File -Filter "*.zip" |
    Remove-Item -Force
}

$runtimeDir = Join-Path $PayloadDir ".runtime"
if (Test-Path -LiteralPath $runtimeDir -PathType Container) {
  Get-ChildItem -LiteralPath $runtimeDir -Recurse -Force -File |
    Where-Object { $_.Name -in @(
      "mobile-token.txt",
      "server.pid",
      "server.out.log",
      "server.err.log",
      "cdp.out.log",
      "cdp.err.log",
      "launcher-self-test.out.log",
      "launcher-self-test.err.log"
    ) } |
    Remove-Item -Force
}

$payloadItems = Get-ChildItem -LiteralPath $PayloadDir -Force
if (-not $payloadItems) {
  throw "Payload directory is empty: $PayloadDir"
}
$payloadItems | Compress-Archive -DestinationPath $PayloadZip -Force

$VersionSource = Join-Path $StageDir "SetupVersion.cs"
Set-Content -LiteralPath $VersionSource -Encoding UTF8 -Value @"
namespace Codex2FrpSetup
{
    internal static class SetupVersion
    {
        public const string Value = "$Version";
    }
}
"@

$resourceArg = "/resource:$PayloadZip,Codex2FrpSetup.Payload.zip"

if (Test-Path -LiteralPath $Output) {
  Remove-Item -LiteralPath $Output -Force
}

& $csc `
  /nologo `
  /codepage:65001 `
  /target:winexe `
  /platform:anycpu `
  /optimize+ `
  /win32icon:$Icon `
  /win32manifest:$Manifest `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /reference:System.Management.dll `
  /reference:System.IO.Compression.dll `
  /reference:System.IO.Compression.FileSystem.dll `
  $resourceArg `
  /out:$Output `
  $Source `
  $VersionSource

if ($LASTEXITCODE -ne 0) {
  throw "C# compiler failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) {
  throw "Setup EXE was not created: $Output"
}

$outputItem = Get-Item -LiteralPath $Output
if ($outputItem.LastWriteTime -lt $BuildStamp.AddSeconds(-2)) {
  throw "Setup EXE timestamp did not update; build output may be stale: $Output"
}

$VersionedOutput = Join-Path $DistDir ("Codex2FrpSetup-v$Version.exe")
Copy-Item -LiteralPath $Output -Destination $VersionedOutput -Force

Write-Output "Built $Output"
Write-Output "Built $VersionedOutput"
