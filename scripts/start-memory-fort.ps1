param(
  [int]$Port = 4410,
  [string]$HostName = "127.0.0.1",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$MemoryRoot = (Join-Path $env:USERPROFILE ".memory"),
  [int]$TimeoutSeconds = 30
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

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$search = $null
do {
  Start-Sleep -Milliseconds 500
  try {
    $search = Invoke-RestMethod -Uri "http://$HostName`:$Port/memory/api/search?q=memory&k=1&noHyde=true" -TimeoutSec 2
  } catch {
    $search = $null
  }
} while ($null -eq $search -and (Get-Date) -lt $deadline)

if ($null -eq $search) {
  Write-JsonLine @{ ok = $false; phase = "smoke"; error = "dashboard did not answer before timeout"; pid = $process.Id; port = $Port }
  exit 1
}

$degraded = $false
if ($null -ne $search.degraded) {
  $degraded = [bool]$search.degraded
}

Write-JsonLine @{
  ok = $true
  phase = "smoke"
  pid = $process.Id
  port = $Port
  degraded = $degraded
  totalMs = $search.timings.totalMs
  rerankMs = $search.timings.rerankMs
}

# Degraded search (e.g. Voyage API hiccup or machine under load) is a warning,
# not a launch failure — the dashboard is up and usable.
