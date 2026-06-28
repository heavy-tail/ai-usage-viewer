import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shQuote } from "./shell";
import type { CommandRunner } from "./types";

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: 0,
    };
  } catch (error) {
    const commandError = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: commandError.stdout ?? "",
      stderr: commandError.stderr ?? "",
      exitCode:
        typeof commandError.code === "number" ? commandError.code : Number.NaN,
    };
  }
};

export async function isCommandAvailable(
  command: string,
  cwd: string,
  runner: CommandRunner
): Promise<boolean> {
  if (process.platform === "win32") {
    const result = await runner("where.exe", [command], { cwd, timeoutMs: 3_000 });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  const result = await runner("sh", ["-lc", `command -v ${shQuote(command)}`], {
    cwd,
    timeoutMs: 3_000,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}
