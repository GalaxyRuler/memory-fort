import { autoPushErrorsCheck } from "./autopush.js";
import { embeddingsIntegrityCheck } from "./embeddings-integrity.js";
import { orphanedTmpCheck } from "./orphaned-tmp.js";
import { syncStateDriftCheck } from "./sync-state-drift.js";
import { atomicWriteRetriesCheck } from "./atomic-write-retries.js";
import { backlogGrowthCheck } from "./backlog-growth.js";
import {
  antigravityCaptureCheck,
  antigravityConfigCheck,
  claudeCodeCaptureCheck,
  claudeCodeEnabledCheck,
  claudeCodeHookPathsCheck,
  claudeDesktopConfigCheck,
  codexCaptureCheck,
  codexConfigCheck,
  openCovenReadinessCheck,
  openCodeCaptureCheck,
  openCodeConfigCheck,
  openCodePluginCheck,
  snifferAntigravityPluginCheck,
  snifferClaudeCodeBackfillCheck,
  snifferClaudeDesktopCaptureCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferVscodeCaptureCheck,
  snifferVscodeExtensionCheck,
  vscodeConfigCheck,
} from "./clients.js";
import { chatgptBridgeRunningCheck, chatgptBridgeMcpCheck } from "./chatgpt.js";
import { compileRecentCheck } from "./compile.js";
import { compileExecuteHealthCheck } from "./compile-execute-health.js";
import { compileRawAppendOnlyCheck } from "./compile-raw-append-only.js";
import { compileFilterHealthCheck } from "./filter-health.js";
import { configValidCheck } from "./config.js";
import { buildVersionMatchCheck } from "./build.js";
import { curationContentLossCheck } from "./curation-content-loss.js";
import { dashboardStatusCheck } from "./dashboard.js";
import { episodicRelationsCoverageCheck } from "./episodic-relations.js";
import { freshnessStaleCheck } from "./freshness.js";
import {
  gitDurabilityConfigCheck,
  gitIntegrityCheck,
  gitRemoteCheck,
} from "./git.js";
import { graphCohesionCheck } from "./graph-cohesion.js";
import { embeddingHealthCheck } from "./embedding-health.js";
import { intentClassifierHealthCheck } from "./intent-classifier.js";
import { promptDriftCheck } from "./prompt-drift.js";
import { prospectiveOverdueCheck } from "./prospective-overdue.js";
import { searchPipelineCheck } from "./search.js";
import { sourceFieldCheck } from "./source-field.js";
import type { CheckDescriptor } from "./types.js";
import { uncommittedVaultCheck } from "./uncommitted-vault.js";
import { vaultReadWriteCheck } from "./vault.js";

export const ALL_CHECKS: CheckDescriptor[] = [
  vaultReadWriteCheck,
  configValidCheck,
  buildVersionMatchCheck,
  dashboardStatusCheck,
  searchPipelineCheck,
  episodicRelationsCoverageCheck,
  freshnessStaleCheck,
  prospectiveOverdueCheck,
  graphCohesionCheck,
  embeddingHealthCheck,
  intentClassifierHealthCheck,
  sourceFieldCheck,
  atomicWriteRetriesCheck,
  compileRecentCheck,
  compileExecuteHealthCheck,
  backlogGrowthCheck,
  compileFilterHealthCheck,
  compileRawAppendOnlyCheck,
  promptDriftCheck,
  curationContentLossCheck,
  autoPushErrorsCheck,
  uncommittedVaultCheck,
  gitRemoteCheck,
  gitIntegrityCheck,
  gitDurabilityConfigCheck,
  claudeCodeEnabledCheck,
  claudeCodeHookPathsCheck,
  claudeCodeCaptureCheck,
  snifferClaudeCodeBackfillCheck,
  codexConfigCheck,
  codexCaptureCheck,
  antigravityConfigCheck,
  snifferAntigravityPluginCheck,
  antigravityCaptureCheck,
  openCovenReadinessCheck,
  openCodeConfigCheck,
  openCodePluginCheck,
  openCodeCaptureCheck,
  vscodeConfigCheck,
  snifferVscodeExtensionCheck,
  snifferVscodeCaptureCheck,
  claudeDesktopConfigCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferClaudeDesktopCaptureCheck,
  chatgptBridgeRunningCheck,
  chatgptBridgeMcpCheck,
  orphanedTmpCheck,
  embeddingsIntegrityCheck,
  syncStateDriftCheck,
];
