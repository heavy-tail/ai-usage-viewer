import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageProvider, UsageSnapshot } from "./types";
import type { CompatibilityReport } from "./compatibilityReport";
import {
  redactSensitiveText,
  redactSensitiveValue,
  redactSnapshot,
} from "./lib/redaction";
import { validateSnapshotShape } from "./snapshot";

const SNAPSHOT_FILE = join("data", "usage-snapshot.json");
const RAW_DIR = join("data", "raw");
const COMPATIBILITY_REPORT_FILE = join("data", "compatibility-report.json");

export async function readSnapshot(rootDir: string): Promise<UsageSnapshot | null> {
  try {
    const text = await readFile(join(rootDir, SNAPSHOT_FILE), "utf8");
    const parsed: unknown = JSON.parse(text);
    return validateSnapshotShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(
  rootDir: string,
  snapshot: UsageSnapshot
): Promise<UsageSnapshot> {
  const redacted = redactSnapshot(snapshot);
  await mkdir(join(rootDir, "data"), { recursive: true });
  const target = join(rootDir, SNAPSHOT_FILE);
  // Write to a per-process temp file then atomically rename it over the target.
  // An interrupted or concurrent write can therefore never leave truncated JSON
  // behind (the reader sees either the old file or the complete new one). The
  // per-process temp name avoids two writers clobbering the same scratch file;
  // the workspace named-pipe mutex serializes those writers before this point.
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return redacted;
}

export async function writeCompatibilityReport(
  rootDir: string,
  report: CompatibilityReport
): Promise<void> {
  await mkdir(join(rootDir, "data"), { recursive: true });
  const target = join(rootDir, COMPATIBILITY_REPORT_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  const redacted = redactSensitiveValue(report);
  await writeFile(tmp, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

export async function writeRawOutput(
  rootDir: string,
  fileName: string,
  output: string
): Promise<void> {
  await mkdir(join(rootDir, RAW_DIR), { recursive: true });
  await writeFile(
    join(rootDir, RAW_DIR, fileName),
    `${redactSensitiveText(output).trim()}\n`,
    "utf8"
  );
}

export async function readRawOutput(
  rootDir: string,
  provider: UsageProvider
): Promise<string | null> {
  const fileName = rawFileNameForProvider(provider);
  try {
    return await readFile(join(rootDir, RAW_DIR, fileName), "utf8");
  } catch {
    return null;
  }
}

export function rawFileNameForProvider(provider: UsageProvider): string {
  if (provider === "codex") return "codex-default.txt";
  return `${provider}.txt`;
}
