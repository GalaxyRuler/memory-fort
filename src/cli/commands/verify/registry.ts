import { autoPushErrorsCheck } from "./autopush.js";
import { atomicWriteRetriesCheck } from "./atomic-write-retries.js";
import {
  antigravityCaptureCheck,
  antigravityConfigCheck,
  claudeCodeCaptureCheck,
  claudeCodeEnabledCheck,
  claudeDesktopConfigCheck,
  codexCaptureCheck,
  codexConfigCheck,
  snifferAntigravityPluginCheck,
  snifferClaudeCodeBackfillCheck,
  snifferClaudeDesktopCaptureCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferVscodeCaptureCheck,
  snifferVscodeExtensionCheck,
  vscodeConfigCheck,
} from "./clients.js";
import { compileRecentCheck } from "./compile.js";
import { compileExecuteHealthCheck } from "./compile-execute-health.js";
import { configValidCheck } from "./config.js";
import { dashboardStatusCheck } from "./dashboard.js";
import { episodicRelationsCoverageCheck } from "./episodic-relations.js";
import { freshnessStaleCheck } from "./freshness.js";
import { gitRemoteCheck } from "./git.js";
import { graphCohesionCheck } from "./graph-cohesion.js";
import { intentClassifierHealthCheck } from "./intent-classifier.js";
import { prospectiveOverdueCheck } from "./prospective-overdue.js";
import { searchPipelineCheck } from "./search.js";
import { sourceFieldCheck } from "./source-field.js";
import type { CheckDescriptor } from "./types.js";
import { uncommittedVaultCheck } from "./uncommitted-vault.js";
import { vaultReadWriteCheck } from "./vault.js";

export const ALL_CHECKS: CheckDescriptor[] = [
  vaultReadWriteCheck,
  configValidCheck,
  dashboardStatusCheck,
  searchPipelineCheck,
  episodicRelationsCoverageCheck,
  freshnessStaleCheck,
  prospectiveOverdueCheck,
  graphCohesionCheck,
  intentClassifierHealthCheck,
  sourceFieldCheck,
  atomicWriteRetriesCheck,
  compileRecentCheck,
  compileExecuteHealthCheck,
  autoPushErrorsCheck,
  uncommittedVaultCheck,
  gitRemoteCheck,
  claudeCodeEnabledCheck,
  claudeCodeCaptureCheck,
  snifferClaudeCodeBackfillCheck,
  codexConfigCheck,
  codexCaptureCheck,
  antigravityConfigCheck,
  snifferAntigravityPluginCheck,
  antigravityCaptureCheck,
  vscodeConfigCheck,
  snifferVscodeExtensionCheck,
  snifferVscodeCaptureCheck,
  claudeDesktopConfigCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferClaudeDesktopCaptureCheck,
];
