import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CollectorUnavailableError,
  PtyProcessError,
  PtyTimeoutError,
} from "./errors";
import {
  serializePtyOptions,
  type PtyWorkerResponse,
  type SerializedPtyError,
} from "./ptyProtocol";
import type { PtyRunner } from "./pty";

const execFileAsync = promisify(execFile);
const WORKER_PATH = fileURLToPath(new URL("./ptyWorker.ts", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKER_CLEANUP_GRACE_MS = 10_000;

export const runPtyIsolated: PtyRunner = (options) =>
  new Promise((resolve, reject) => {
    let worker: ChildProcess;
    try {
      worker = spawn(process.execPath, ["--import", "tsx", WORKER_PATH], {
        cwd: PACKAGE_ROOT,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      reject(
        new CollectorUnavailableError(
          `Unable to start hidden PTY worker: ${errorMessage(error)}`
        )
      );
      return;
    }

    let settled = false;
    let response: PtyWorkerResponse | undefined;
    const timer = setTimeout(() => {
      void abortWorker(
        new PtyProcessError("Hidden PTY worker did not exit in time.", "", "")
      );
    }, options.totalTimeoutMs + WORKER_CLEANUP_GRACE_MS);

    const abortWorker = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await terminateWorker(worker);
      } catch {
        reject(
          new PtyProcessError(
            "Hidden PTY worker cleanup could not be confirmed.",
            "",
            ""
          )
        );
        return;
      }
      reject(error);
    };

    worker.once("message", (message) => {
      response = message as PtyWorkerResponse;
    });
    worker.once("error", (error) => {
      void abortWorker(
        new CollectorUnavailableError(
          `Hidden PTY worker failed to start: ${errorMessage(error)}`
        )
      );
    });
    worker.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || !response) {
        const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
        reject(
          new PtyProcessError(
            `Hidden PTY worker exited without a result (${detail}).`,
            "",
            ""
          )
        );
        return;
      }
      if (response.ok) resolve(response.result);
      else reject(deserializeWorkerError(response.error));
    });

    try {
      worker.send(serializePtyOptions(options), (error) => {
        if (error) {
          void abortWorker(
            new PtyProcessError("Unable to initialize hidden PTY worker.", "", "")
          );
        }
      });
    } catch {
      void abortWorker(
        new PtyProcessError("Unable to initialize hidden PTY worker.", "", "")
      );
    }
  });

function deserializeWorkerError(error: SerializedPtyError): Error {
  if (error.kind === "unavailable") {
    return new CollectorUnavailableError(
      error.message,
      error.rawText,
      error.cleanedText
    );
  }
  if (error.kind === "timeout") {
    return new PtyTimeoutError(
      error.message,
      error.rawText ?? "",
      error.cleanedText ?? ""
    );
  }
  return new PtyProcessError(
    error.message,
    error.rawText ?? "",
    error.cleanedText ?? ""
  );
}

async function terminateWorker(worker: ChildProcess): Promise<void> {
  if (hasExited(worker)) return;
  if (process.platform === "win32" && worker.pid) {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/pid", String(worker.pid), "/T", "/F"],
        { timeout: 5_000, windowsHide: true }
      );
    } catch {
      // The worker may have exited between inspection and taskkill.
    }
    if (await waitForExit(worker, 5_000)) return;
  }
  if (!hasExited(worker)) worker.kill("SIGKILL");
  if (!(await waitForExit(worker, 5_000))) {
    throw new Error("PTY worker did not exit.");
  }
}

function hasExited(worker: ChildProcess): boolean {
  return worker.exitCode != null || worker.signalCode != null;
}

function waitForExit(worker: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(worker)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const done = () => {
      clearTimeout(timer);
      worker.off("exit", done);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      worker.off("exit", done);
      resolveExit(hasExited(worker));
    }, timeoutMs);
    worker.once("exit", done);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
