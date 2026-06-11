param(
  [int]$Port = 4410,
  [string]$HostName = "127.0.0.1",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$MemoryRoot = (Join-Path $env:USERPROFILE ".memory"),
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"

function Write-JsonLine {
  param([hashtable]$Data)
  $Data.ts = (Get-Date).ToUniversalTime().ToString("o")
  $Data | ConvertTo-Json -Compress
}

$userVoyageKey = [System.Environment]::GetEnvironmentVariable("VOYAGE_API_KEY", "User")
if ([string]::IsNullOrWhiteSpace($userVoyageKey)) {
  Write-JsonLine @{ ok = $false; phase = "preflight"; error = "VOYAGE_API_KEY missing from Windows User environment" }
  exit 1
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = Join-Path $RepoRoot "dist\cli.mjs"
if (-not (Test-Path -LiteralPath $cli)) {
  Write-JsonLine @{ ok = $false; phase = "preflight"; error = "dist\cli.mjs missing; run npm run build first"; repoRoot = $RepoRoot }
  exit 1
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  if ($listener.OwningProcess -gt 0) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = if ($null -ne $owner.CommandLine) { [string]$owner.CommandLine } else { "" }
    $isMemoryDashboard =
      $commandLine.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf("dashboard", [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $isMemoryDashboard) {
      Write-JsonLine @{ ok = $false; phase = "preflight"; error = "port is already used by a non-Memory-Fort process"; port = $Port; ownerPid = $listener.OwningProcess }
      exit 1
    }
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

# Wait for the killed listener to actually release the port — starting the new
# dashboard immediately races the OS socket teardown and fails the bind.
$portFreeDeadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $portFreeDeadline) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}

$logDir = Join-Path $MemoryRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$arguments = @($cli, "dashboard", "--no-open", "--port", [string]$Port, "--host", $HostName, "--root", $MemoryRoot)
$previousVoyageKey = $env:VOYAGE_API_KEY
$previousMemoryRoot = $env:MEMORY_ROOT
try {
  $env:VOYAGE_API_KEY = $userVoyageKey
  $env:MEMORY_ROOT = $MemoryRoot
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
} finally {
  if ($null -eq $previousVoyageKey) {
    Remove-Item Env:\VOYAGE_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:VOYAGE_API_KEY = $previousVoyageKey
  }

  if ($null -eq $previousMemoryRoot) {
    Remove-Item Env:\MEMORY_ROOT -ErrorAction SilentlyContinue
  } else {
    $env:MEMORY_ROOT = $previousMemoryRoot
  }
}

# Readiness: poll the cheap status endpoint. The search endpoint does a full
# retrieval (corpus build + Voyage + rerank) and can exceed any short timeout
# on a cold start with a large vault — wrong probe for "is the server up".
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$status = $null
do {
  Start-Sleep -Milliseconds 500
  try {
    $status = Invoke-RestMethod -Uri "http://$HostName`:$Port/memory/api/status" -TimeoutSec 3
  } catch {
    $status = $null
  }
} while ($null -eq $status -and (Get-Date) -lt $deadline)

if ($null -eq $status) {
  Write-JsonLine @{ ok = $false; phase = "smoke"; error = "dashboard did not answer before timeout"; pid = $process.Id; port = $Port }
  exit 1
}

# Quality probe: one search call, generous timeout, warn-only. Degraded or slow
# search must not block opening — the dashboard is up and usable.
$degraded = $false
$searchTimings = $null
try {
  $search = Invoke-RestMethod -Uri "http://$HostName`:$Port/memory/api/search?q=memory&k=1&noHyde=true" -TimeoutSec 60
  if ($null -ne $search.degraded) { $degraded = [bool]$search.degraded }
  $searchTimings = $search.timings
} catch {
  $degraded = $true
}

Write-JsonLine @{
  ok = $true
  phase = "smoke"
  pid = $process.Id
  port = $Port
  degraded = $degraded
  totalMs = $searchTimings.totalMs
  rerankMs = $searchTimings.rerankMs
}
