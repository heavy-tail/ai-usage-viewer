import { describe, expect, it } from "vitest";
import {
  trustedChildEnvironment,
  windowsBatchCommandSpec,
  windowsPtyCommandSpec,
  windowsSystem32Executable,
} from "../src/collectors/windowsSystem";

describe("trusted Windows system utilities", () => {
  it("resolves inbox executables beneath System32 without PATH lookup", () => {
    expect(windowsSystem32Executable("taskkill.exe", "C:\\Windows")).toBe(
      "C:\\Windows\\System32\\taskkill.exe"
    );
  });

  it("rejects relative system roots and executable path traversal", () => {
    expect(() => windowsSystem32Executable("taskkill.exe", "Windows")).toThrow(
      "SystemRoot must be an absolute Windows path."
    );
    expect(() =>
      windowsSystem32Executable("..\\taskkill.exe", "C:\\Windows")
    ).toThrow("plain .exe file name");
  });

  it("quotes safe PTY tokens and rejects cmd control operators", () => {
    expect(
      windowsPtyCommandSpec("C:\\Program Files\\nodejs\\node.exe", [
        "-e",
        "process.stdout.write('10%')",
      ])
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["-e", "process.stdout.write('10%')"],
    });
    expect(
      windowsPtyCommandSpec("C:\\Tools More\\provider.cmd", ["--safe"])
    ).toMatchObject({
      command: expect.stringMatching(/^C:\\Windows\\System32\\cmd\.exe$/i),
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '"C:\\Tools More\\provider.cmd" --safe',
      ],
    });
    expect(() =>
      windowsPtyCommandSpec("C:\\Tools & More\\provider.cmd", [])
    ).toThrow("unsupported shell characters");
    expect(() =>
      windowsBatchCommandSpec(
        "C:\\Tools\\provider.cmd",
        ["safe&echo injected"],
        "C:\\repo\\scripts\\invoke-windows-command.ps1"
      )
    ).toThrow("unsupported shell characters");
  });

  it("normalizes Windows child environments and removes code injection hooks", () => {
    const environment = trustedChildEnvironment(
      { Path: "C:\\Trusted", SAFE_VALUE: "kept" },
      {
        PATH: "C:\\Untrusted",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Untrusted\\cmd.exe",
        PATHEXT: ".JS",
        node_options: "--require C:\\Untrusted\\inject.js",
        NPM_CONFIG_SCRIPT_SHELL: "C:\\Untrusted\\shell.exe",
      },
      "win32"
    );

    expect(environment).toMatchObject({
      Path: "C:\\Trusted",
      SAFE_VALUE: "kept",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    expect(
      Object.keys(environment).some(
        (key) => key.toLowerCase() === "node_options"
      )
    ).toBe(false);
    expect(environment.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
  });
});
