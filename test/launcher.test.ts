import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("Windows desktop launcher trust boundary", () => {
  it("uses the Program Files Node binary directly and blocks inherited injection", async () => {
    const launcher = await readFile(
      join(process.cwd(), "scripts", "start-usage-viewer.ps1"),
      "utf8"
    );

    expect(launcher).toContain('Join-Path $env:ProgramFiles "nodejs\\node.exe"');
    expect(launcher).toContain("-FilePath $NodePath");
    expect(launcher).not.toContain('-FilePath "npm.cmd"');
    expect(launcher).not.toContain('-FilePath "node.exe"');
    expect(launcher).toContain('"NODE_OPTIONS"');
    expect(launcher).toContain('"NODE_PATH"');
    expect(launcher).toContain('"NPM_CONFIG_SCRIPT_SHELL"');
    expect(launcher).toContain("$listenerExecutable.Equals(");
    expect(launcher).toContain("$NodePath.TrimEnd");
    expect(launcher).toContain("-TimeoutSec 10");
    expect(launcher).toContain("AddMinutes(5)");
    expect(launcher).toContain('"--pipe"');
    expect(launcher).toContain("[string]$ServerProcess.Id");
    expect(launcher).toContain("$taskkillExitCode = $LASTEXITCODE");
    expect(launcher).toContain("$rootStillRunning");
    expect(launcher).not.toContain('Get-Command "msedge.exe"');
    expect(launcher).not.toContain('Get-Command "chrome.exe"');
    expect(launcher).toContain(
      'Join-Path $env:ProgramFiles "Google/Chrome/Application/chrome.exe"'
    );
  });

  it("accepts only the launcher's exact Node argument vector", () => {
    const root = process.cwd();
    const node = join(process.env.ProgramFiles!, "nodejs", "node.exe");
    const preflight = join(root, "node_modules", "tsx", "dist", "preflight.cjs");
    const loader = pathToFileURL(
      join(root, "node_modules", "tsx", "dist", "loader.mjs")
    ).href;
    const server = join(root, "src", "server.ts");
    const canonical = commandLine([
      node,
      "--require",
      preflight,
      "--import",
      loader,
      server,
    ]);

    expect(verifierExitCode(canonical)).toBe(0);
    expect(
      verifierExitCode(
        commandLine([
          node,
          "--require",
          join(root, "untrusted-preload.cjs"),
          "--require",
          preflight,
          "--import",
          loader,
          server,
        ])
      )
    ).not.toBe(0);
    expect(verifierExitCode(`${canonical} --inspect`)).not.toBe(0);
    expect(
      verifierExitCode(
        commandLine([
          node,
          "--require",
          preflight,
          "--import",
          join(root, "untrusted-loader.mjs"),
          server,
        ])
      )
    ).not.toBe(0);
  }, 15_000);
});

function verifierExitCode(command: string): number | null {
  const result = spawnSync(
    join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(process.cwd(), "scripts", "start-usage-viewer.ps1"),
      "-VerifyServerCommandLine",
      command,
    ],
    { encoding: "utf8" }
  );
  if (result.error) throw result.error;
  return result.status;
}

function commandLine(arguments_: string[]): string {
  return arguments_
    .map((argument) =>
      /[\s"]/.test(argument)
        ? `"${argument.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`
        : argument
    )
    .join(" ");
}
