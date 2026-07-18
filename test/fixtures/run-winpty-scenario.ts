import { execFileSync } from "node:child_process";
import { runPty } from "../../src/collectors/pty";
import { PtyTimeoutError } from "../../src/collectors/errors";

async function main(): Promise<void> {
  const scenario = process.argv[2];
  if (process.platform !== "win32") {
    throw new Error("WinPTY scenarios are Windows-only.");
  }

  if (scenario === "natural-exit") {
    const result = await runNaturalExit();
    console.log(JSON.stringify({
      scenario,
      capturedReady: result.cleanedOutput.includes("winpty-ready"),
    }));
    return;
  }

  if (scenario === "repeated-natural-exit") {
    // Warm native modules and worker infrastructure before taking the baseline.
    await runNaturalExit();
    await sleep(1_250);
    const before = processHandleCount();
    for (let index = 0; index < 3; index += 1) {
      await runNaturalExit();
    }
    await sleep(1_250);
    const after = processHandleCount();
    console.log(JSON.stringify({ scenario, handleDelta: after - before }));
    return;
  }

  if (scenario === "no-output-timeout") {
    try {
      await runPty({
        command: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 30_000)"],
        cwd: process.cwd(),
        windowsPtyBackend: "winpty",
        totalTimeoutMs: 1_000,
        steps: [{ waitFor: "never", timeoutMs: 100 }],
      });
    } catch (error) {
      console.log(JSON.stringify({
        scenario,
        timedOut: error instanceof PtyTimeoutError,
      }));
      return;
    }
    throw new Error("The no-output WinPTY scenario unexpectedly completed.");
  }

  throw new Error(`Unknown WinPTY scenario: ${scenario ?? "<missing>"}`);
}

void main();

function runNaturalExit() {
  return runPty({
    command: process.execPath,
    args: ["-e", "console.log('winpty-ready')"],
    cwd: process.cwd(),
    windowsPtyBackend: "winpty",
    totalTimeoutMs: 5_000,
    steps: [{ waitFor: "winpty-ready", timeoutMs: 2_000 }],
  });
}

function processHandleCount(): number {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).HandleCount`],
    { encoding: "utf8", windowsHide: true }
  );
  const count = Number.parseInt(output.trim(), 10);
  if (!Number.isFinite(count)) throw new Error("Could not read process handle count.");
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
