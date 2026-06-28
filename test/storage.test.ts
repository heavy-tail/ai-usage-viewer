import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readSnapshot, writeSnapshot } from "../src/storage";
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

  it("returns null when a stored snapshot is truncated/invalid JSON", async () => {
    const rootDir = await workspace();
    await writeSnapshot(rootDir, sample);

    // Simulate a torn write landing on disk; readSnapshot must not throw.
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      '{ "generatedAt": "2026',
      "utf8"
    );

    expect(await readSnapshot(rootDir)).toBeNull();
  });
});
