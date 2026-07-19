import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [, , modeOrMarker, maybeMarker] = process.argv;
if (modeOrMarker === "child") {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await writeFile(maybeMarker, "orphaned", "utf8");
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "child", modeOrMarker], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  // Keep a real event-loop handle alive. Node exits early (code 13) for an
  // unresolved top-level await that has no active handles, which would make
  // the timeout/Job Object regression test a false positive.
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
