param(
  [string]$OutputName = "Codex2Frp.exe"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Source = Join-Path $ProjectRoot "windows\launcher\Codex2FrpLauncher.cs"
$Output = Join-Path $ProjectRoot $OutputName
$Icon = Join-Path $ProjectRoot "windows\assets\codex2frp.ico"

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Launcher source was not found: $Source"
}
if (-not (Test-Path -LiteralPath $Icon -PathType Leaf)) {
  throw "Launcher icon was not found: $Icon"
}

$cscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) {
  throw "Windows C# compiler was not found. Expected csc.exe under Microsoft.NET Framework v4.0.30319."
}

& $csc `
  /nologo `
  /codepage:65001 `
  /target:winexe `
  /platform:anycpu `
  /optimize+ `
  /win32icon:$Icon `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /reference:System.Management.dll `
  /out:$Output `
  $Source

if ($LASTEXITCODE -ne 0) {
  throw "C# compiler failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) {
  throw "Launcher EXE was not created: $Output"
}

Write-Output "Built $Output"
