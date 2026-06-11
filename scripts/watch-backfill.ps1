param(
  [string]$LogPath = (Join-Path $env:USERPROFILE ".memory\logs\backfill-local.err.log"),
  [int]$PollSeconds = 10
)

# Live progress view for the backfill drain. Reads the drain's pass lines
# ("pass N: ... remaining X byte(s) in Y file(s)") and renders a progress bar
# with throughput and ETA. Safe to open/close at any time — read-only.

$host.UI.RawUI.WindowTitle = "Memory Fort — Backfill Progress"

function Get-PassStats {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $lines = Get-Content -LiteralPath $Path -Tail 200 -ErrorAction SilentlyContinue
  $passes = @()
  $quarantined = 0
  foreach ($line in $lines) {
    if ($line -match "pass (\d+): included (\d+) raw file\(s\), advanced (\d+) watermark\(s\), remaining (\d+) byte\(s\) in (\d+) file\(s\)") {
      $passes += [pscustomobject]@{
        Pass      = [int]$Matches[1]
        Included  = [int]$Matches[2]
        Advanced  = [int]$Matches[3]
        Remaining = [long]$Matches[4]
        Files     = [int]$Matches[5]
      }
    } elseif ($line -match "quarantined (\d+) file\(s\)") {
      $quarantined += [int]$Matches[1]
    }
  }
  if ($passes.Count -eq 0) { return $null }
  $recent = $passes | Select-Object -Last 10
  return [pscustomobject]@{
    Latest           = $passes[-1]
    RecentAdvanced   = ($recent | Measure-Object -Property Advanced -Sum).Sum
    RecentIncluded   = ($recent | Measure-Object -Property Included -Sum).Sum
    RecentPassCount  = $recent.Count
    QuarantinedTotal = $quarantined
  }
}

$baseline = $null
$baselineTime = $null
$lastPass = -1

Write-Host "Watching $LogPath (Ctrl+C to exit — does not affect the backfill)" -ForegroundColor DarkGray
Write-Host ""

while ($true) {
  $stats = Get-PassStats -Path $LogPath
  if ($null -eq $stats) {
    Write-Host ("`r{0:HH:mm:ss}  waiting for drain output..." -f (Get-Date)) -NoNewline
    Start-Sleep -Seconds $PollSeconds
    continue
  }
  $p = $stats.Latest

  if ($null -eq $baseline) {
    $baseline = $p.Remaining
    $baselineTime = Get-Date
  }

  $done = [Math]::Max(0, $baseline - $p.Remaining)
  $pct = if ($baseline -gt 0) { [Math]::Min(100, [Math]::Round(100 * $done / $baseline, 2)) } else { 0 }
  $elapsed = (Get-Date) - $baselineTime
  $rate = if ($elapsed.TotalHours -gt 0.02 -and $done -gt 0) { $done / $elapsed.TotalHours } else { 0 }
  $eta = if ($rate -gt 0) { [TimeSpan]::FromHours($p.Remaining / $rate) } else { $null }

  $health = if ($stats.RecentIncluded -gt 0) {
    [Math]::Round(100 * $stats.RecentAdvanced / $stats.RecentIncluded)
  } else { 0 }

  $status = "pass {0} | {1:N1} MB remaining in {2:N0} files | recent success {3}% ({4}/{5} files over last {6} passes) | {7:N1} MB/h | ETA {8}" -f `
    $p.Pass,
    ($p.Remaining / 1MB),
    $p.Files,
    $health,
    $stats.RecentAdvanced,
    $stats.RecentIncluded,
    $stats.RecentPassCount,
    ($rate / 1MB),
    $(if ($eta) { "{0}d {1}h" -f $eta.Days, $eta.Hours } else { "measuring..." })

  Write-Progress -Activity "Memory Fort backfill (session progress: $pct%)" -Status $status -PercentComplete ([Math]::Min(100, $pct))

  if ($p.Pass -ne $lastPass) {
    Write-Host ("`r{0:HH:mm:ss}  {1}    " -f (Get-Date), $status)
    $lastPass = $p.Pass
    if ($health -lt 40 -and $stats.RecentPassCount -ge 5) {
      Write-Host "          warning: under 40% of recent files advanced — local model struggling; occasional 0-advance passes are normal (retried, then quarantined for next run)" -ForegroundColor Yellow
    }
    if ($stats.QuarantinedTotal -gt 0) {
      Write-Host ("          note: {0} file(s) quarantined this run; they retry automatically on the next run" -f $stats.QuarantinedTotal) -ForegroundColor DarkGray
    }
  }

  Start-Sleep -Seconds $PollSeconds
}
