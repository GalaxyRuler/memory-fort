import { atomicWriteRetryStats } from "../../../storage/atomic-write.js";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckResult } from "./types.js";

export const atomicWriteRetriesCheck: CheckDescriptor = {
  id: "storage.atomic-write-retries",
  label: "storage atomic-write retries",
  roles: ["operator", "server"],
  async run() {
    return checkAtomicWriteRetries();
  },
};

export async function checkAtomicWriteRetries(): Promise<VerifyCheckResult> {
  const retried = atomicWriteRetryStats.success + atomicWriteRetryStats.exhausted;
  const writes = atomicWriteRetryStats.writes;
  const rate = writes === 0 ? 0 : retried / writes;
  const detail = `${retried}/${writes} writes retried (${(rate * 100).toFixed(2)}%); ${atomicWriteRetryStats.exhausted} exhausted`;

  if (rate >= 0.1) {
    return fail(
      "storage.atomic-write-retries",
      "storage atomic-write retries",
      "inspect Windows file handles, antivirus software, or a cloud-sync tool",
      detail,
    );
  }
  if (rate >= 0.01) {
    return warn(
      "storage.atomic-write-retries",
      "storage atomic-write retries",
      detail,
      "inspect Windows file handles if this persists",
    );
  }
  return pass("storage.atomic-write-retries", "storage atomic-write retries", detail);
}
