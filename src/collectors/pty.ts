import * as nodePty from "node-pty";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { cleanTerminalOutput } from "../lib/terminal";
import {
  CollectorUnavailableError,
  PtyProcessError,
  PtyTimeoutError,
  errorMessage,
} from "./errors";

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
  responders?: PtyResponder[];
};

export type PtyRunResult = {
  rawOutput: string;
  cleanedOutput: string;
  exitCode?: number;
};

export type PtyRunner = (options: RunPtyOptions) => Promise<PtyRunResult>;

export const runPty: PtyRunner = async (options) => {
  let rawOutput = "";
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
      // winpty spawns a `winpty-agent` helper that flashes a console window on
      // every CLI launch; ConPTY is windowless. ConPTY emits slightly different
      // redraw/escape sequences, so `cleanTerminalOutput` (CSI/OSC stripping)
      // and the per-provider parsers were re-verified against it.
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

  terminal.onData((chunk) => {
    rawOutput += chunk;
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
        await waitForPattern(
          () => rawOutput,
          () => exited,
          step.waitFor,
          step.timeoutMs ?? options.totalTimeoutMs,
          waiters
        );
      }
      if (step.send) terminal.write(step.send);
      if (step.delayMs) await sleep(step.delayMs);
    }

    await Promise.race([waitForExit(() => exited, waiters, 1_000), sleep(1_000)]);
    if (!exited) terminal.kill();
    return {
      rawOutput,
      cleanedOutput: cleanTerminalOutput(rawOutput),
      exitCode,
    };
  })();

  try {
    return await Promise.race([conversation, totalTimer]);
  } catch (error) {
    if (!exited) terminal.kill();
    throw error;
  } finally {
    if (totalTimeout) clearTimeout(totalTimeout);
  }
};

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
