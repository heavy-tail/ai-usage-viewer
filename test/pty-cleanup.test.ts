import type * as nodePty from "node-pty";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node-pty", () => ({ spawn: mocked.spawn }));

import {
  chooseWindowsCommandCandidate,
  runPtyInProcess,
} from "../src/collectors/pty";

describe("Windows ConPTY cleanup", () => {
  it("preserves the command search order reported by Windows", () => {
    expect(
      chooseWindowsCommandCandidate([
        "C:\\FirstOnPath\\provider.exe",
        "C:\\LaterOnPath\\provider.cmd",
      ])
    ).toBe("C:\\FirstOnPath\\provider.exe");
  });

  it("skips an extensionless Unix shim beside a runnable Windows shim", () => {
    expect(
      chooseWindowsCommandCandidate([
        "C:\\Tools\\provider",
        "C:\\Tools\\provider.cmd",
        "C:\\Later\\provider.exe",
      ])
    ).toBe("C:\\Tools\\provider.cmd");
  });

  it.skipIf(process.platform !== "win32")(
    "releases the native terminal after the shell exits naturally",
    async () => {
      const kill = vi.fn();
      const terminal = {
        pid: 4242,
        kill,
        write: vi.fn(),
        onData(listener: (data: string) => void) {
          setTimeout(() => listener("ready\n"), 0);
          return { dispose: vi.fn() };
        },
        onExit(
          listener: (event: { exitCode: number; signal?: number }) => void
        ) {
          setTimeout(() => listener({ exitCode: 0 }), 10);
          return { dispose: vi.fn() };
        },
      } as unknown as nodePty.IPty;
      mocked.spawn.mockReturnValueOnce(terminal);

      await runPtyInProcess({
        command: process.execPath,
        args: [],
        cwd: process.cwd(),
        totalTimeoutMs: 1_000,
        steps: [{ waitFor: /ready/, timeoutMs: 500 }],
      });

      expect(kill).toHaveBeenCalledOnce();
    }
  );
});
