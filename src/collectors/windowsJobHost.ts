import { fileURLToPath } from "node:url";

// The helper was introduced for AGY but is intentionally generic: it joins an
// immediate KILL_ON_JOB_CLOSE Windows Job Object before launching any absolute
// command, so crashes and timeout kills cannot orphan descendants.
export const WINDOWS_JOB_HOST_PATH = fileURLToPath(
  new URL("../../.runtime/agy-job-host.exe", import.meta.url)
);
