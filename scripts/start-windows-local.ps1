param(
  [int]$Port = 8988,
  [string]$Token = "",
  [string]$CodexExe = "",
  [switch]$OpenCodexCdp
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$NodeDir = Join-Path $RuntimeDir "node"
$NodeDownloadDir = Join-Path $RuntimeDir "node-download"

function Test-NodeExe {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $version = & $Path --version 2>$null
    return ([string]$version -match "^v(18|20|22|24|26)\.")
  } catch {
    return $false
  }
}

function Get-ProjectNodeExe {
  foreach ($candidate in @(
    (Join-Path $NodeDir "node.exe"),
    (Join-Path $ProjectRoot "bin\node\node.exe")
  )) {
    if (Test-NodeExe $candidate) { return $candidate }
  }

  foreach ($root in @($NodeDir, $NodeDownloadDir)) {
    if (Test-Path -LiteralPath $root -PathType Container) {
      $node = Get-ChildItem -LiteralPath $root -Recurse -Filter node.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($node -and (Test-NodeExe $node.FullName)) { return $node.FullName }
    }
  }

  $pathNode = Get-Command node -ErrorAction SilentlyContinue
  if ($pathNode -and $pathNode.Source -and $pathNode.Source -notlike "*\WindowsApps\*" -and (Test-NodeExe $pathNode.Source)) {
    return $pathNode.Source
  }
  throw "Could not find a usable Node runtime."
}

function New-MobileToken {
  $bytes = New-Object byte[] 18
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$tokenPath = Join-Path $RuntimeDir "mobile-token.txt"
if (-not $Token) {
  if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
    $Token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  }
  if (-not $Token) {
    $Token = New-MobileToken
    Set-Content -LiteralPath $tokenPath -Encoding ASCII -Value $Token
  }
} else {
  Set-Content -LiteralPath $tokenPath -Encoding ASCII -Value $Token
}

if ($CodexExe) { $env:CODEX_DESKTOP_EXECUTABLE_PATH = $CodexExe }
if ($OpenCodexCdp) {
  & (Join-Path $ProjectRoot "scripts\launch-main-codex-cdp.ps1") -CodexExe $env:CODEX_DESKTOP_EXECUTABLE_PATH -OpenAfterPrepare
}

$env:PORT = [string]$Port
$env:HOST = "0.0.0.0"
$env:MOBILE_TYPER_TOKEN = $Token
$env:CODEX2FRP_LOCAL_ONLY = "0"
$env:CODEX2FRP_APP_NAME = "Codex2Frp"
$env:CODEX2FRP_DISABLE_IMESSAGE_NOTIFY = "1"
$env:CODEX2FRP_CDP_PORT = "39252"

Set-Location -LiteralPath $ProjectRoot
& (Get-ProjectNodeExe) server.js
