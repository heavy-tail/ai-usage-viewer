import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "usage-viewer-config-"));
}

async function writeConfig(rootDir: string, value: unknown): Promise<void> {
  await writeFile(
    join(rootDir, "config.json"),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8"
  );
}

describe("loadConfig", () => {
  it("falls back to defaults when config.json is missing", async () => {
    const rootDir = await workspace();
    const config = await loadConfig(rootDir);
    expect(config.enabledProviders).toEqual(DEFAULT_CONFIG.enabledProviders);
  });

  it("filters out unknown providers from enabledProviders", async () => {
    const rootDir = await workspace();
    await writeConfig(rootDir, {
      enabledProviders: ["claude", "bogus", "grok"],
    });
    const config = await loadConfig(rootDir);
    expect(config.enabledProviders).toEqual(["claude", "grok"]);
  });

  it("deep-merges nested provider config with defaults", async () => {
    const rootDir = await workspace();
    await writeConfig(rootDir, { codex: { collectDefault: false } });
    const config = await loadConfig(rootDir);
    expect(config.codex.collectDefault).toBe(false);
    expect(config.codex.additionalModelsForContext).toEqual([]);
    expect(config.planLabelFallback.claude).toBe(
      DEFAULT_CONFIG.planLabelFallback.claude
    );
  });

  it("throws a clear error on malformed JSON instead of enabling all providers", async () => {
    const rootDir = await workspace();
    await writeConfig(rootDir, '{ "enabledProviders": ["claude" ');
    await expect(loadConfig(rootDir)).rejects.toThrow(/valid JSON/i);
  });
});
