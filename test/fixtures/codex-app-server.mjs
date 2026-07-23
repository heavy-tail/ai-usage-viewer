import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const marker = process.env.USAGE_VIEWER_TEST_CODEX_ORPHAN_MARKER;
if (marker) {
  const script = [
    "const { writeFileSync } = require('node:fs');",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'orphaned'), 1000);`,
  ].join("");
  const descendant = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  descendant.unref();
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  } else if (message.method === "account/rateLimits/read") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { fixture: true } })}\n`
    );
  }
});
