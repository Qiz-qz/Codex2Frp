param(
  [string]$InstallDir = "E:\Codex2Frp",
  [string]$BaseUrl = "http://127.0.0.1:8988",
  [switch]$RequireThread
)

$ErrorActionPreference = "Stop"
$tokenFile = Join-Path $InstallDir ".runtime\mobile-token.txt"
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  throw "Installed backend token file is unavailable."
}
$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if (-not $token) { throw "Installed backend token is empty." }
$headers = @{ Authorization = "Bearer $token" }
$base = $BaseUrl.TrimEnd('/')

function Invoke-BackendGet([string]$Path) {
  Invoke-RestMethod -Headers $headers -Uri ($base + $Path) -TimeoutSec 15
}

$health = Invoke-BackendGet "/codex/health"
$meta = Invoke-BackendGet "/codex/v3/meta"
$diagnostics = Invoke-BackendGet "/codex/v3/diagnostics"
$config = Invoke-BackendGet "/codex/config"
$status = Invoke-BackendGet "/codex/status"
$models = Invoke-BackendGet "/codex/v3/catalogs/models"
$collaboration = Invoke-BackendGet "/codex/v3/catalogs/collaboration-modes"

$serialized = @($health, $meta, $diagnostics, $config, $status, $models, $collaboration) |
  ConvertTo-Json -Depth 30 -Compress
if ($serialized.Contains($token)) { throw "A read-only response echoed the access token." }

$threadId = [string]$status.threadId
if (-not $threadId -and $status.currentThread) { $threadId = [string]$status.currentThread.id }
if ($RequireThread -and -not $threadId) { throw "No current thread is available for read-only verification." }

$threadStatus = $null
$cursor = $null
$snapshot = $null
$queue = $null
$protection = $null
if ($threadId) {
  $escaped = [Uri]::EscapeDataString($threadId)
  $threadStatus = Invoke-BackendGet "/codex/v3/threads/$escaped/status"
  $cursor = Invoke-BackendGet "/codex/v3/threads/$escaped/events/cursor"
  $snapshot = Invoke-BackendGet "/codex/v3/threads/$escaped/events/snapshot"
  $queue = Invoke-BackendGet "/codex/v3/threads/$escaped/queue"
  $protection = Invoke-BackendGet "/codex/v3/threads/$escaped/protection"
  $threadSerialized = @($threadStatus, $cursor, $snapshot, $queue, $protection) |
    ConvertTo-Json -Depth 30 -Compress
  if ($threadSerialized.Contains($token)) { throw "A thread response echoed the access token." }
}

$capabilities = @()
if ($meta.capabilities -is [System.Collections.IDictionary]) {
  $capabilities = @($meta.capabilities.Keys)
} elseif ($meta.capabilities) {
  $capabilities = @($meta.capabilities.PSObject.Properties.Name)
}
$modelRows = if ($models.data) { @($models.data) } elseif ($models.models) { @($models.models) } else { @() }
$collaborationRows = if ($collaboration.data) { @($collaboration.data) } elseif ($collaboration.modes) { @($collaboration.modes) } else { @() }
$queueRows = if ($queue -and $queue.data) { @($queue.data) } elseif ($queue -and $queue.items) { @($queue.items) } else { @() }

[ordered]@{
  ok = [bool]$health.ok
  backendVersion = [string]$meta.versions.backend
  apiVersion = [int]$meta.apiVersion
  appServerState = [string]$meta.appServer.state
  capabilityCount = $capabilities.Count
  threadAvailable = [bool]$threadId
  eventCursor = if ($cursor) { [long]$cursor.cursor } else { $null }
  snapshotVersion = if ($snapshot) { [long]$snapshot.snapshotVersion } else { $null }
  queueCount = $queueRows.Count
  protected = if ($protection) { [bool]$protection.protected } else { $null }
  modelOptionCount = $modelRows.Count
  collaborationModeCount = $collaborationRows.Count
  syncStale = if ($diagnostics.sync) { [bool]$diagnostics.sync.stale } else { $null }
} | ConvertTo-Json -Compress
