import * as nodePty from "node-pty";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { cleanTerminalOutput } from "../lib/terminal";
import {
  CollectorUnavailableError,
  PtyProcessError,
  PtyTimeoutError,
  errorMessage,
} from "./errors";
import { runPtyIsolated } from "./ptyIsolated";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// NOTE (C5): `waitFor` is matched against the ENTIRE accumulated output buffer,
// not just newly-arrived bytes. If a step's pattern already appeared earlier in
// the session, that step resolves immediately. Keep per-step patterns specific
// enough to distinguish the output you actually want (see the codex collector's
// single-line footer regex for an example of working around this).
export type PtyStep = {
  send?: string;
  waitFor?: RegExp | string;
  timeoutMs?: number;
  delayMs?: number;
  optional?: boolean;
};

// NOTE (C4): a responder WITHOUT `once: true` re-fires on every data chunk for
// as long as its pattern remains anywhere in the accumulated buffer, writing its
// payload repeatedly. Set `once` for one-shot prompts (every current responder
// does) unless you genuinely want it to keep firing.
export type PtyResponder = {
  when: RegExp | string;
  send: string;
  once?: boolean;
};

export type RunPtyOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  steps: PtyStep[];
  totalTimeoutMs: number;
  maxOutputBytes?: number;
  responders?: PtyResponder[];
};

export type PtyRunResult = {
  rawOutput: string;
  cleanedOutput: string;
  exitCode?: number;
};

export type PtyRunner = (options: RunPtyOptions) => Promise<PtyRunResult>;

export const runPtyInProcess: PtyRunner = async (options) => {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new PtyProcessError(
      "PTY maxOutputBytes must be a positive integer.",
      "",
      ""
    );
  }
  let rawOutput = "";
  let outputLimitError: PtyProcessError | undefined;
  let exitCode: number | undefined;
  let exited = false;
  const commandSpec = resolvePtyCommand(options.command, options.args);
  const responders = options.responders?.map((responder) => ({
    ...responder,
    used: false,
  }));

  let terminal: nodePty.IPty;
  try {
    terminal = nodePty.spawn(commandSpec.command, commandSpec.args, {
      name: "xterm-256color",
      cols: options.cols ?? 160,
      rows: options.rows ?? 40,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      // Windows: use ConPTY (the modern pseudo-console) instead of winpty.
      // winpty spawns a `winpty-agent` helper that creates a classic console
      // window before hiding it, which can produce a one-frame flash. ConPTY
      // emits slightly different redraw/escape sequences, so
      // `cleanTerminalOutput` and the per-provider parsers are verified against
      // it.
      //
      // NOTE: we intentionally do NOT set `useConptyDll` — node-pty's bundled
      // conpty.dll conout path truncated Claude's `/usage` redraw enough to
      // break its parser. The default ConPTY path keeps Claude + Codex intact.
      ...(process.platform === "win32" ? { useConpty: true } : {}),
    });
  } catch (error) {
    throw new CollectorUnavailableError(errorMessage(error));
  }

  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };

  let rejectOutputLimit: (error: PtyProcessError) => void = () => undefined;
  const outputLimit = new Promise<never>((_resolve, reject) => {
    rejectOutputLimit = reject;
  });

  terminal.onData((chunk) => {
    if (outputLimitError) return;
    const combined = rawOutput + chunk;
    if (Buffer.byteLength(combined, "utf8") > maxOutputBytes) {
      rawOutput = truncateUtf8(combined, maxOutputBytes);
      outputLimitError = new PtyProcessError(
        `PTY output exceeded ${maxOutputBytes} bytes.`,
        rawOutput,
        cleanTerminalOutput(rawOutput)
      );
      rejectOutputLimit(outputLimitError);
      notify();
      return;
    }
    rawOutput = combined;
    if (responders) {
      for (const responder of responders) {
        if (responder.once && responder.used) continue;
        if (matches(rawOutput, responder.when)) {
          terminal.write(responder.send);
          responder.used = true;
        }
      }
    }
    notify();
  });

  terminal.onExit(({ exitCode: code }) => {
    exitCode = code;
    exited = true;
    notify();
  });

  // Teardown can be requested by both the normal completion path and the
  // timeout/error path. Keep it single-flight so those paths can never race two
  // taskkill/terminal.kill calls against the same ConPTY instance.
  let teardown: Promise<void> | undefined;
  const teardownOnce = (): Promise<void> => {
    teardown ??= terminatePty(terminal, () => exited, waiters);
    return teardown;
  };

  let totalTimeout: ReturnType<typeof setTimeout> | undefined;
  const totalTimer = new Promise<never>((_resolve, reject) => {
    totalTimeout = setTimeout(() => {
      reject(
        new PtyTimeoutError(
          `PTY timeout after ${options.totalTimeoutMs} ms.`,
          rawOutput,
          cleanTerminalOutput(rawOutput)
        )
      );
    }, options.totalTimeoutMs);
  });

  const conversation = (async () => {
    for (const step of options.steps) {
      if (step.waitFor) {
        try {
          await waitForPattern(
            () => rawOutput,
            () => exited,
            step.waitFor,
            step.timeoutMs ?? options.totalTimeoutMs,
            waiters
          );
        } catch (error) {
          if (!step.optional || !(error instanceof PtyTimeoutError)) throw error;
        }
      }
      if (step.send) terminal.write(step.send);
      if (step.delayMs) await sleep(step.delayMs);
    }
  })();

  try {
    // The total timeout governs only the terminal conversation. Once every
    // requested step has completed, cleanup gets its own bounded waits below;
    // a slow ConPTY close must not turn verified provider output into a false
    // collection timeout.
    await Promise.race([conversation, totalTimer, outputLimit]);
    if (totalTimeout) {
      clearTimeout(totalTimeout);
      totalTimeout = undefined;
    }

    await waitForExit(() => exited, waiters, 1_000);
    // A naturally exited Windows shell still leaves the native ConPTY handle
    // open until node-pty's kill path runs. Always finalize the terminal; the
    // non-Windows branch below remains a no-op after a natural exit.
    await teardownOnce();
    if (outputLimitError) throw outputLimitError;

    return {
      rawOutput,
      cleanedOutput: cleanTerminalOutput(rawOutput),
      exitCode,
    };
  } catch (error) {
    if (totalTimeout) {
      clearTimeout(totalTimeout);
      totalTimeout = undefined;
    }
    await teardownOnce();
    throw error;
  } finally {
    if (totalTimeout) clearTimeout(totalTimeout);
  }
};

// node-pty 1.1 removes its native ConPTY handle record as soon as the shell
// exits, before ClosePseudoConsole can run. A dedicated, hidden worker gives
// every Windows capture an OS-enforced cleanup boundary: when the worker exits,
// Windows closes any native handles even after provider crashes or natural
// exits. Other platforms keep the lower-overhead in-process path.
export const runPty: PtyRunner = (options) =>
  process.platform === "win32"
    ? runPtyIsolated(options)
    : runPtyInProcess(options);

async function terminatePty(
  terminal: nodePty.IPty,
  isExited: () => boolean,
  waiters: Set<() => void>
): Promise<void> {
  if (process.platform === "win32") {
    let taskkillSucceeded = false;
    if (!isExited()) {
      try {
        // node-pty 1.1 asks a helper process to AttachConsole while killing a
        // ConPTY tree. In windowless hosts that helper can throw even though the
        // process is ultimately killed, which made tests and production logs look
        // falsely healthy. taskkill performs the same bounded tree termination
        // without requiring the parent process to own a Windows console.
        await execFileAsync(
          "taskkill.exe",
          ["/pid", String(terminal.pid), "/T", "/F"],
          { timeout: 3_000, windowsHide: true }
        );
        taskkillSucceeded = true;
      } catch {
        // The process may already have exited between the check and taskkill.
      }
      // node-pty 1.1 defers its ConPTY exit event while it flushes output.
      await waitForExit(isExited, waiters, 2_500);
    }
    // A zero taskkill status or node-pty's own exit event verifies that the
    // process tree is gone. If neither happened, retain node-pty's normal
    // process-list cleanup instead of suppressing it speculatively.
    const treeTerminationVerified = taskkillSucceeded || isExited();
    // Its public kill path forks a console-list probe that can race the already
    // dead PID and print "AttachConsole failed". We already terminated the
    // process tree, so suppress only that redundant internal probe while still
    // calling kill to release native ConPTY pipes/handles. Without native
    // cleanup, a completed headless canary can keep Node's event loop alive.
    if (treeTerminationVerified) suppressNodePtyConsoleProbe(terminal);
    try {
      terminal.kill();
    } catch (error) {
      if (!treeTerminationVerified) throw error;
    }
    return;
  }

  if (isExited()) return;
  terminal.kill();
}

function suppressNodePtyConsoleProbe(terminal: nodePty.IPty): void {
  const internal = terminal as nodePty.IPty & {
    _agent?: {
      _getConsoleProcessList?: () => Promise<number[]>;
    };
  };
  if (internal._agent?._getConsoleProcessList) {
    internal._agent._getConsoleProcessList = async () => [];
  }
}

function resolvePtyCommand(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };
  if (isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return wrapWindowsScript(command, args);
  }

  const resolved = resolveWindowsCommand(command);
  if (!resolved) return { command, args };
  return wrapWindowsScript(resolved, args);
}

function resolveWindowsCommand(command: string): string | undefined {
  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
    return chooseWindowsCommandCandidate(candidates);
  } catch {
    return undefined;
  }
}

function chooseWindowsCommandCandidate(candidates: string[]): string | undefined {
  return (
    candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate)) ??
    candidates.find((candidate) => /\.exe$/i.test(candidate)) ??
    candidates[0]
  );
}

function wrapWindowsScript(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  const ext = extname(command).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ")],
    };
  }
  return { command, args };
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function waitForPattern(
  getOutput: () => string,
  isExited: () => boolean,
  pattern: RegExp | string,
  timeoutMs: number,
  waiters: Set<() => void>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!matches(getOutput(), pattern)) {
    if (isExited()) {
      const raw = getOutput();
      throw new PtyProcessError(
        `PTY exited before matching ${patternLabel(pattern)}.`,
        raw,
        cleanTerminalOutput(raw)
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const raw = getOutput();
      throw new PtyTimeoutError(
        `PTY timeout waiting for ${patternLabel(pattern)}.`,
        raw,
        cleanTerminalOutput(raw)
      );
    }
    await waitForData(waiters, Math.min(remaining, 250));
  }
}

async function waitForExit(
  isExited: () => boolean,
  waiters: Set<() => void>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isExited()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await waitForData(waiters, Math.min(remaining, 250));
  }
}

function waitForData(waiters: Set<() => void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    }
    waiters.add(done);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matches(text: string, pattern: RegExp | string): boolean {
  if (typeof pattern === "string") return text.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function patternLabel(pattern: RegExp | string): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : pattern.toString();
}

function truncateUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}
