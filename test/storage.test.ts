import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  purgeRawOutputs,
  readSnapshot,
  writeCompatibilityReport,
  writeSnapshot,
} from "../src/storage";
import type { CompatibilityReport } from "../src/compatibilityReport";
import type { UsageSnapshot } from "../src/types";

const sample: UsageSnapshot = {
  generatedAt: "2026-06-27T00:00:00.000Z",
  collectors: [
    {
      provider: "claude",
      ok: true,
      state: "ok",
      checkedAt: "2026-06-27T00:00:00.000Z",
      durationMs: 5,
    },
  ],
  limits: [
    {
      id: "claude:session",
      provider: "claude",
      providerLabel: "Claude Code",
      scope: "Current session",
      usedPercent: 10,
      remainingPercent: 90,
      status: "available",
      sourceCommand: "fixture",
      sourceText: "Current session 10% used",
      checkedAt: "2026-06-27T00:00:00.000Z",
    },
  ],
};

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "usage-viewer-storage-"));
}

describe("storage.writeSnapshot (atomic write)", () => {
  it("writes valid JSON that reads back, leaving no temp files behind", async () => {
    const rootDir = await workspace();

    await writeSnapshot(rootDir, sample);

    const restored = await readSnapshot(rootDir);
    expect(restored?.generatedAt).toBe(sample.generatedAt);
    expect(restored?.limits).toHaveLength(1);

    const files = await readdir(join(rootDir, "data"));
    expect(files.filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("atomically replaces an existing snapshot instead of corrupting it", async () => {
    const rootDir = await workspace();

    await writeSnapshot(rootDir, sample);
    await writeSnapshot(rootDir, {
      ...sample,
      generatedAt: "2026-06-27T01:00:00.000Z",
    });

    const restored = await readSnapshot(rootDir);
    expect(restored?.generatedAt).toBe("2026-06-27T01:00:00.000Z");

    const files = await readdir(join(rootDir, "data"));
    expect(files.filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("surfaces malformed JSON and leaves the stored evidence untouched", async () => {
    const rootDir = await workspace();
    await writeSnapshot(rootDir, sample);

    // Simulate a torn write landing on disk.
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      '{ "generatedAt": "2026',
      "utf8"
    );

    await expect(readSnapshot(rootDir)).rejects.toMatchObject({
      name: "SnapshotStorageError",
      kind: "malformed",
    });
    expect(
      await readFile(join(rootDir, "data", "usage-snapshot.json"), "utf8")
    ).toBe('{ "generatedAt": "2026');
  });

  it("distinguishes a schema-invalid snapshot", async () => {
    const rootDir = await workspace();
    await mkdir(join(rootDir, "data"), { recursive: true });
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      JSON.stringify({ generatedAt: "2026-07-18T00:00:00.000Z" }),
      "utf8"
    );

    await expect(readSnapshot(rootDir)).rejects.toMatchObject({
      name: "SnapshotStorageError",
      kind: "schema",
    });
  });

  it("distinguishes a read failure from a missing snapshot", async () => {
    const rootDir = await workspace();
    await mkdir(join(rootDir, "data", "usage-snapshot.json"), {
      recursive: true,
    });
    await expect(readSnapshot(rootDir)).rejects.toMatchObject({
      name: "SnapshotStorageError",
      kind: "read",
    });
  });
});

describe("storage.writeCompatibilityReport", () => {
  it("redacts identity values before serialization and keeps JSON parseable", async () => {
    const rootDir = await workspace();
    const report: CompatibilityReport & {
      diagnostics: { orgName: string; accountLabel: string };
    } = {
      schemaVersion: 1,
      generatedAt: "2026-06-27T00:00:00.000Z",
      passed: false,
      providers: [
        {
          provider: "claude",
          passed: false,
          state: "error",
          attemptState: "error",
          checkedAt: "2026-06-27T00:00:00.000Z",
          rowCount: 0,
          error: "Account: privateuser",
        },
      ],
      diagnostics: {
        orgName: "Private Claude Organization",
        accountLabel: "privateuser",
      },
    };

    await writeCompatibilityReport(rootDir, report);

    const text = await readFile(
      join(rootDir, "data", "compatibility-report.json"),
      "utf8"
    );
    const stored = JSON.parse(text) as typeof report;

    expect(stored.providers[0].error).toBe(
      "Account: <redacted-account-id>"
    );
    expect(stored.diagnostics.orgName).toBe("<redacted-org-id>");
    expect(stored.diagnostics.accountLabel).toBe("<redacted-account-id>");
    expect(text).not.toContain("privateuser");
    expect(text).not.toContain("Private Claude Organization");
  });
});

describe("storage.purgeRawOutputs", () => {
  it("removes transcripts left by older versions", async () => {
    const rootDir = await workspace();
    const rawDir = join(rootDir, "data", "raw");
    await mkdir(rawDir, { recursive: true });
    await writeFile(join(rawDir, "claude.txt"), "legacy transcript", "utf8");

    await purgeRawOutputs(rootDir);

    await expect(readFile(join(rawDir, "claude.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
