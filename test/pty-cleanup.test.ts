import type * as nodePty from "node-pty";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node-pty", () => ({ spawn: mocked.spawn }));

import { runPtyInProcess } from "../src/collectors/pty";

describe("Windows ConPTY cleanup", () => {
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
        command: "fixture.exe",
        args: [],
        cwd: process.cwd(),
        totalTimeoutMs: 1_000,
        steps: [{ waitFor: /ready/, timeoutMs: 500 }],
      });

      expect(kill).toHaveBeenCalledOnce();
    }
  );
});
