import { spawn } from "node:child_process";

const marker = process.argv[2];
if (!marker) throw new Error("marker path is required");

const script = [
  "const { writeFileSync } = require('node:fs');",
  `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'orphaned'), 1000);`,
].join("");

const child = spawn(process.execPath, ["-e", script], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
child.unref();
process.stdout.write("parent-ready\n");
