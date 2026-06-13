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

function Show-LaunchError {
  param([string]$Message)
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    "Memory Fort",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
}

if (-not $alreadyUp) {
  $launcher = Join-Path $PSScriptRoot "start-memory-fort.ps1"
  if (-not (Test-Path -LiteralPath $launcher)) {
    Show-LaunchError "Launcher script missing:`n$launcher"
    exit 1
  }
  $result = & $launcher -Port $Port -HostName $HostName
  $result | ForEach-Object { Write-Output $_ }
  # $LASTEXITCODE is $null when the invoked script never ran a native command
  # or exit — and `$null -ne 0` is true, so an unguarded check shows the
  # failure dialog on success. Only treat a real non-zero integer as failure.
  if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
    # The shortcut runs hidden — a silent exit looks like "nothing happened".
    # Surface the failure visibly, and still try the browser in case the
    # dashboard came up despite a failed smoke check.
    $detail = ($result | Out-String).Trim()
    Show-LaunchError "Memory Fort dashboard failed to start.`n`n$detail"
  }
}

Start-Process $dashboardUrl
