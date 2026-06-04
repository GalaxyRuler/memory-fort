param(
  [int]$Port = 4410,
  [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$statusUrl = "http://${HostName}:${Port}/memory/api/status"
$dashboardUrl = "http://${HostName}:${Port}/memory/"

# If already running, skip launch — just open browser
$alreadyUp = $false
try {
  $probe = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2 -ErrorAction Stop
  if ($probe -and $probe.vaultRoot) { $alreadyUp = $true }
} catch {
  $alreadyUp = $false
}

if (-not $alreadyUp) {
  $launcher = Join-Path $PSScriptRoot "start-memory-fort.ps1"
  if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Error "launcher missing: $launcher"
    exit 1
  }
  $result = & $launcher -Port $Port -HostName $HostName
  $result | ForEach-Object { Write-Output $_ }
  if ($LASTEXITCODE -ne 0) {
    Write-Error "launcher exited non-zero"
    exit $LASTEXITCODE
  }
}

Start-Process $dashboardUrl
