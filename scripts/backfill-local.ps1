param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$MemoryRoot = (Join-Path $env:USERPROFILE ".memory"),
  [string]$Model = "qwen/qwen3.5-9b",
  [string]$BaseUrl = "http://127.0.0.1:1234/v1",
  [int]$ContextLength = 65536,
  [int]$TotalMaxBytes = 150000,
  [int]$MaxPasses = 4000
)

# Runs the raw-history backfill drain against a local LM Studio model, then
# restores the original config.yaml (cloud model) when the drain exits for
# any reason. Designed for multi-hour/multi-day unattended runs.
#
# TotalMaxBytes is sized for the model context: 150KB raw ~= 38k tokens, plus
# ~15k tokens of prompt overhead and 4k output, fits a 64k context window.

$ErrorActionPreference = "Stop"

$configPath = Join-Path $MemoryRoot "config.yaml"
$backupPath = Join-Path $MemoryRoot "config.yaml.backfill-backup"
$cli = Join-Path $RepoRoot "dist\cli.mjs"

if (-not (Test-Path -LiteralPath $cli)) {
  throw "dist\cli.mjs missing; run npm run build first"
}

# Preflight: ensure an instance of the model is loaded with enough context.
# A JIT-loaded instance defaults to 4096 ctx, which rejects compile prompts.
$loaded = (lms ps 2>$null | Out-String)
$hasAdequateInstance = $false
foreach ($line in ($loaded -split "`n")) {
  if ($line -match [regex]::Escape($Model) -and $line -match "\b(\d{4,})\b") {
    $ctx = [int]($line | Select-String -Pattern "\s(\d{4,7})\s" -AllMatches).Matches[0].Groups[1].Value
    if ($ctx -ge $ContextLength) { $hasAdequateInstance = $true }
  }
}
if (-not $hasAdequateInstance) {
  Write-Host "loading $Model with context $ContextLength..."
  lms load $Model --context-length $ContextLength --gpu max -y
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
  max_tokens: 4096
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
  & node $cli compile --execute --drain --backfill --max-passes $MaxPasses --total-max-bytes $TotalMaxBytes
  $exit = $LASTEXITCODE
} finally {
  Copy-Item $backupPath $configPath -Force
  Remove-Item $backupPath -ErrorAction SilentlyContinue
  Write-Host "config.yaml restored to original (cloud) llm settings"
}

exit $exit
