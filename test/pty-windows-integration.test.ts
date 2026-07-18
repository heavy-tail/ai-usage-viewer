import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const fixture = resolve("test/fixtures/run-winpty-scenario.ts");

describeWindows("real WinPTY lifecycle", () => {
  it("releases its worker after a natural process exit", async () => {
    const result = await runScenario("natural-exit");

    expect(result).toEqual({
      scenario: "natural-exit",
      capturedReady: true,
    });
  });

  it(
    "does not accumulate native handles across normal exits",
    async () => {
      const result = await runScenario("repeated-natural-exit");

      expect(result.scenario).toBe("repeated-natural-exit");
      expect(result.handleDelta).toEqual(expect.any(Number));
      expect(result.handleDelta as number).toBeLessThanOrEqual(1);
    },
    15_000
  );

  it("kills a process that times out before producing output", async () => {
    const result = await runScenario("no-output-timeout");

    expect(result).toEqual({
      scenario: "no-output-timeout",
      timedOut: true,
    });
  });
});

function runScenario(scenario: string): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, scenario],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      if (child.pid) {
        try {
          // The still-live parent PID is retained by ChildProcess, so taskkill
          // can safely clean its test-only descendants before the test fails.
          execFileSync(
            "taskkill.exe",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" }
          );
        } catch {
          // It may have exited between the timeout and cleanup attempt.
        }
      }
      reject(new Error(`WinPTY scenario ${scenario} did not exit within 10s.`));
    }, 10_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `WinPTY scenario ${scenario} exited ${code}: ${stderr || stdout}`
          )
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}
