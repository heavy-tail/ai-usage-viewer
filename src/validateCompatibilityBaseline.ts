import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compatibilityBaselineIssues } from "./compatibilityBaseline";
import { loadConfig } from "./config";

const rootDir = resolve(process.cwd());
const config = await loadConfig(rootDir);
let value: unknown;
try {
  value = JSON.parse(
    await readFile(join(rootDir, "data", "usage-snapshot.json"), "utf8")
  ) as unknown;
} catch {
  throw new Error("Protected compatibility baseline is unreadable.");
}

const issues = compatibilityBaselineIssues(value, config);
if (issues.length > 0) {
  throw new Error(`Protected compatibility baseline is invalid: ${issues.join("; ")}.`);
}
console.log("Protected compatibility baseline is valid.");
