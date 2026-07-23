import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config";
import {
  compatibilityBaselineIssues,
  redactedCompatibilityBaseline,
} from "./compatibilityBaseline";
import { PROVIDER_ORDER } from "./lib/usage";
import { readSnapshot } from "./storage";

const rootDir = process.cwd();
const config = await loadConfig(rootDir);
if (!sameProviders(config.enabledProviders, PROVIDER_ORDER)) {
  throw new Error(
    "The protected canary must enable exactly Claude, Codex, AGY, and Grok."
  );
}

const snapshot = await readSnapshot(rootDir);
if (!snapshot) {
  throw new Error("Compatibility check did not produce a snapshot.");
}
const issues = compatibilityBaselineIssues(snapshot, config);
if (issues.length > 0) {
  throw new Error(`Compatibility baseline rejected: ${issues.join("; ")}`);
}

const artifactDir = join(rootDir, "canary-artifacts");
await mkdir(artifactDir, { recursive: true });
await writeFile(
  join(artifactDir, "candidate-baseline.json"),
  `${JSON.stringify(redactedCompatibilityBaseline(snapshot), null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 }
);

function sameProviders(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
