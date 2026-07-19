import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { shQuote } from "./shell";
import type { CommandRunner } from "./types";
import {
  firstRunnableWindowsCommand,
  windowsBatchCommandSpec,
  windowsSystem32Executable,
  trustedChildEnvironment,
} from "./windowsSystem";
import { WINDOWS_JOB_HOST_PATH } from "./windowsJobHost";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_COMMAND_WRAPPER = fileURLToPath(
  new URL("../../scripts/invoke-windows-command.ps1", import.meta.url)
);

export const runCommand: CommandRunner = async (command, args, options) => {
  try {
    const directLaunch = commandLaunchSpec(command, args);
    const launch =
      process.platform === "win32"
        ? {
            command: WINDOWS_JOB_HOST_PATH,
            args: [directLaunch.command, options.cwd, ...directLaunch.args],
          }
        : directLaunch;
    const result = await execFileAsync(launch.command, launch.args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      env: trustedChildEnvironment(),
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

export function commandLaunchSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
    ? windowsBatchCommandSpec(command, args, WINDOWS_COMMAND_WRAPPER)
    : { command, args };
}

export async function isCommandAvailable(
  command: string,
  cwd: string,
  runner: CommandRunner
): Promise<boolean> {
  return (await resolveCommandPath(command, cwd, runner)) !== undefined;
}

/** Resolve a command once so a later spawn cannot select a different PATH entry. */
export async function resolveCommandPath(
  command: string,
  cwd: string,
  runner: CommandRunner
): Promise<string | undefined> {
  const result =
    process.platform === "win32"
      ? await runner(windowsSystem32Executable("where.exe"), [command], {
          cwd,
          timeoutMs: 3_000,
        })
      : await runner("sh", ["-lc", `command -v ${shQuote(command)}`], {
          cwd,
          timeoutMs: 3_000,
        });
  if (result.exitCode !== 0) return undefined;
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return process.platform === "win32"
    ? firstRunnableWindowsCommand(candidates)
    : candidates[0];
}
