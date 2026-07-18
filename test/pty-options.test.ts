import type * as nodePty from "node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PtyTimeoutError } from "../src/collectors/errors";

const { spawnPty } = vi.hoisted(() => ({ spawnPty: vi.fn() }));

vi.mock("node-pty", () => ({ spawn: spawnPty }));

import { runPty, type RunPtyOptions } from "../src/collectors/pty";

describe("Windows PTY backend selection", () => {
  beforeEach(() => {
    spawnPty.mockReset();
    spawnPty.mockImplementation(() => completedTerminal());
  });

  it("uses WinPTY when requested", async () => {
    if (process.platform !== "win32") return;

    await run({ windowsPtyBackend: "winpty" });

    expect(spawnPty).toHaveBeenCalledWith(
      process.execPath,
      [],
      expect.objectContaining({ useConpty: false })
    );
  });

  it("keeps the system ConPTY host as the default", async () => {
    if (process.platform !== "win32") return;

    await run({});

    const spawnOptions = spawnPty.mock.calls[0]?.[2];
    expect(spawnOptions).toEqual(expect.objectContaining({ useConpty: true }));
    expect(spawnOptions).not.toHaveProperty("useConptyDll");
  });

  it("disposes WinPTY's output worker when a session times out", async () => {
    if (process.platform !== "win32") return;

    const agentKill = vi.fn();
    const dispose = vi.fn();
    const terminal = killableWinPtyTerminal(agentKill, dispose);
    spawnPty.mockReturnValue(terminal);

    await expect(
      run({
        windowsPtyBackend: "winpty",
        totalTimeoutMs: 20,
        steps: [{ waitFor: "never", timeoutMs: 5 }],
      })
    ).rejects.toBeInstanceOf(PtyTimeoutError);

    expect(agentKill).toHaveBeenCalledOnce();
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

async function run(overrides: Partial<RunPtyOptions>): Promise<void> {
  await runPty({
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    totalTimeoutMs: 1_000,
    steps: [],
    ...overrides,
  });
}

function completedTerminal(): nodePty.IPty {
  return {
    pid: 1234,
    cols: 160,
    rows: 40,
    process: "node",
    handleFlowControl: false,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener) => {
      queueMicrotask(() => listener({ exitCode: 0 }));
      return { dispose: () => undefined };
    },
    resize: () => undefined,
    clear: () => undefined,
    write: () => undefined,
    kill: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    _agent: {
      kill: () => undefined,
      _conoutSocketWorker: { dispose: () => undefined },
    },
  } as unknown as nodePty.IPty;
}

function killableWinPtyTerminal(
  agentKill: () => void,
  dispose: () => void
): nodePty.IPty {
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const terminal = {
    ...completedTerminal(),
    onExit: (listener: typeof exitListener) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    kill: vi.fn(() => {
      queueMicrotask(() => exitListener?.({ exitCode: 1 }));
    }),
    _agent: {
      kill: () => {
        agentKill();
        queueMicrotask(() => exitListener?.({ exitCode: 1 }));
      },
      _outSocket: {
        destroy: () => undefined,
        pending: false,
        readyState: "open",
        once: () => undefined,
        removeListener: () => undefined,
      },
      _inSocket: { destroy: () => undefined },
      _conoutSocketWorker: { dispose },
    },
  };
  return terminal as unknown as nodePty.IPty;
}
