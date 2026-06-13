param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$MemoryRoot = (Join-Path $env:USERPROFILE ".memory"),
  [string]$Model = "google/gemma-4-e4b",
  [string]$BaseUrl = "http://127.0.0.1:1234/v1",
  [int]$ContextLength = 32768,
  [int]$TotalMaxBytes = 20000,
  [int]$ExistingPagesMaxBytes = 6000,
  [int]$MaxFilesPerPass = 5,
  [int]$MaxOutputTokens = 6000,
  [int]$MaxPasses = 30000
)

# Runs the raw-history backfill drain against a local LM Studio model, then
# restores the original config.yaml (cloud model) when the drain exits for
# any reason. Designed for multi-hour/multi-day unattended runs.
#
# Defaults are sized for gemma-4-e4b on the 8GB WhiteKnight GPU (LM Link):
# 24k context = 7.4GB; prompt = ~6k tokens template+schema, ~3k existing
# pages (trimmed via ExistingPagesMaxBytes), ~10k raw, 4k output headroom.
# For a 16GB card use: -Model qwen/qwen3.5-9b -ContextLength 65536
# -TotalMaxBytes 150000 -ExistingPagesMaxBytes 40000 -MaxPasses 4000.

$ErrorActionPreference = "Stop"

# Single-instance guard: the startup-folder resume shortcut runs this at every
# logon; if a drain is already active, exit quietly instead of racing it.
$script:mutex = New-Object System.Threading.Mutex($false, "Local\MemoryFortBackfill")
if (-not $script:mutex.WaitOne(0)) {
  Write-Host "another backfill instance is already running; exiting"
  exit 0
}

$configPath = Join-Path $MemoryRoot "config.yaml"
$backupPath = Join-Path $MemoryRoot "config.yaml.backfill-backup"
$cli = Join-Path $RepoRoot "dist\cli.mjs"

if (-not (Test-Path -LiteralPath $cli)) {
  throw "dist\cli.mjs missing; run npm run build first"
}

# Preflight: ensure an instance of the model is loaded with enough context.
# A JIT-loaded instance defaults to 4096 ctx, which rejects compile prompts.
# A 4096-ctx duplicate instance also steals requests, so unload undersized
# instances of the same model before checking.
$instances = @()
try {
  $instances = @(lms ps --json 2>$null | ConvertFrom-Json)
} catch {
  $instances = @()
}
$hasAdequateInstance = $false
foreach ($inst in $instances) {
  if ($inst.modelKey -ne $Model -and $inst.path -ne $Model) { continue }
  if ([int]$inst.contextLength -ge $ContextLength) {
    $hasAdequateInstance = $true
    Write-Host "found loaded instance '$($inst.identifier)' ctx=$($inst.contextLength) device=$($inst.deviceIdentifier)"
  } else {
    Write-Host "unloading undersized instance '$($inst.identifier)' (ctx=$($inst.contextLength) < $ContextLength)"
    lms unload $inst.identifier
  }
}
if (-not $hasAdequateInstance) {
  Write-Host "loading $Model with context $ContextLength..."
  lms load $Model --context-length $ContextLength --parallel 1 --gpu max --identifier $Model -y
  if ($LASTEXITCODE -ne 0) { throw "lms load failed" }
}

# Swap the llm: block to the local model, keeping a backup of the whole file.
# If a previous run left a backup behind (crash), restore it first so we never
# back up an already-swapped config.
if (Test-Path -LiteralPath $backupPath) {
  Copy-Item $backupPath $configPath -Force
}
Copy-Item $configPath $backupPath -Force

$config = Get-Content $configPath -Raw
$llmBlock = @"
llm:
  provider: openai-compat
  model: $Model
  max_tokens: $MaxOutputTokens
  temperature: 0.2
  allow_internal_hosts: true
  options:
    baseURL: $BaseUrl
"@
$newConfig = [regex]::Replace($config, "(?ms)^llm:.*?(?=^\S|\z)", $llmBlock + "`n")
Set-Content -LiteralPath $configPath -Value $newConfig -Encoding utf8

Write-Host "config.yaml switched to local model '$Model' via $BaseUrl"
Write-Host "starting backfill drain (max $MaxPasses passes, $TotalMaxBytes bytes/pass)..."

try {
  # Outer retry: the drain retries transient failures internally with backoff
  # (~15 min ladder); if it still exits non-zero (e.g. LM Link down for an
  # hour), relaunch every 5 minutes for up to 2 hours before giving up.
  $attempt = 0
  do {
    & node $cli compile --execute --drain --backfill --max-passes $MaxPasses --total-max-bytes $TotalMaxBytes --existing-pages-max-bytes $ExistingPagesMaxBytes --max-files-per-pass $MaxFilesPerPass
    $exit = $LASTEXITCODE
    if ($exit -eq 0) { break }
    $attempt++
    if ($attempt -ge 24) { break }
    Write-Host "drain exited $exit; relaunch $attempt/24 in 300s"
    Start-Sleep -Seconds 300
  } while ($true)
} finally {
  Copy-Item $backupPath $configPath -Force
  Remove-Item $backupPath -ErrorAction SilentlyContinue
  Write-Host "config.yaml restored to original (cloud) llm settings"
}

exit $exit
