import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("rejects unknown providers instead of silently changing the requested list", async () => {
    const rootDir = await workspace();
    await writeConfig(rootDir, {
      enabledProviders: ["claude", "bogus", "grok"],
    });
    await expect(loadConfig(rootDir)).rejects.toThrow(/enabledProviders\[1\]/);
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

  it("rejects invalid timezones instead of silently ignoring them", async () => {
    const rootDir = await workspace();
    await writeConfig(rootDir, { timezone: "Mars/Olympus_Mons" });
    await expect(loadConfig(rootDir)).rejects.toThrow(/timezone.*invalid/i);
  });

  it("does not treat config read failures as a missing file", async () => {
    const rootDir = await workspace();
    await mkdir(join(rootDir, "config.json"));
    await expect(loadConfig(rootDir)).rejects.toThrow(/Unable to read/i);
  });

  it.each([
    [null, /JSON object/i],
    [[], /JSON object/i],
    ['"scalar"', /JSON object/i],
    [{ enabledProviders: null }, /enabledProviders/i],
    [{ enabledProviders: "claude" }, /enabledProviders/i],
    [{ codex: { collectDefault: "false" } }, /codex\.collectDefault/i],
    [{ codex: { additionalModelsForContext: "gpt" } }, /additionalModelsForContext/i],
    [{ agy: { pinnedGroups: ["valid", 7] } }, /pinnedGroups\[1\]/i],
    [{ grokCommand: 42 }, /grokCommand/i],
    [{ wsl: { cwd: null } }, /wsl\.cwd/i],
    [{ planLabelFallback: { claude: false } }, /planLabelFallback\.claude/i],
    [{ unknownSetting: true }, /unknownSetting/i],
  ])("rejects a wrongly typed or unknown present setting: %j", async (value, message) => {
    const rootDir = await workspace();
    await writeConfig(rootDir, value);
    await expect(loadConfig(rootDir)).rejects.toThrow(message);
  });
});
