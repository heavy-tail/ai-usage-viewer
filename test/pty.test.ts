import { describe, expect, it } from "vitest";
import { runPty } from "../src/collectors/pty";
import { PtyTimeoutError } from "../src/collectors/errors";

// Drives the real PTY engine against a short-lived `node -e` child. This is the
// highest-risk module (terminal conversation + timeout/exit handling) and was
// previously untested. Uses process.execPath so it does not depend on PATH.
describe("runPty", () => {
  it("waits for a pattern and returns cleaned output", async () => {
    const result = await runPty({
      command: process.execPath,
      args: ["-e", "process.stdout.write('Credits used: 10%\\n')"],
      cwd: process.cwd(),
      totalTimeoutMs: 10_000,
      steps: [{ waitFor: /Credits used:/i, timeoutMs: 8_000 }],
    });

    expect(result.cleanedOutput).toMatch(/Credits used: 10%/);
  }, 15_000);

  it("rejects with PtyTimeoutError when the pattern never appears", async () => {
    await expect(
      runPty({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1200)"],
        cwd: process.cwd(),
        totalTimeoutMs: 1_500,
        steps: [{ waitFor: /this-never-appears/i, timeoutMs: 1_000 }],
      })
    ).rejects.toBeInstanceOf(PtyTimeoutError);
  }, 15_000);

  it("does not apply the conversation deadline to teardown", async () => {
    const result = await runPty({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      cwd: process.cwd(),
      totalTimeoutMs: 100,
      steps: [],
    });

    expect(result).toEqual(
      expect.objectContaining({ rawOutput: expect.any(String) })
    );
  }, 15_000);
});
