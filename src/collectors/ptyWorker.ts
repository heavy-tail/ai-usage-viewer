import {
  CollectorUnavailableError,
  PtyProcessError,
  PtyTimeoutError,
} from "./errors";
import { runPtyInProcess } from "./pty";
import {
  deserializePtyOptions,
  type PtyWorkerResponse,
  type SerializedPtyError,
  type SerializedPtyOptions,
} from "./ptyProtocol";

let accepted = false;
process.once("message", async (message: SerializedPtyOptions) => {
  if (accepted) return;
  accepted = true;
  let response: PtyWorkerResponse;
  try {
    const result = await runPtyInProcess(deserializePtyOptions(message));
    response = { ok: true, result };
  } catch (error) {
    response = { ok: false, error: serializeWorkerError(error) };
  }
  sendAndExit(response);
});

function serializeWorkerError(error: unknown): SerializedPtyError {
  if (error instanceof CollectorUnavailableError) {
    return {
      kind: "unavailable",
      message: error.message,
      rawText: error.rawText,
      cleanedText: error.cleanedText,
    };
  }
  if (error instanceof PtyTimeoutError) {
    return {
      kind: "timeout",
      message: error.message,
      rawText: error.rawText,
      cleanedText: error.cleanedText,
    };
  }
  if (error instanceof PtyProcessError) {
    return {
      kind: "process",
      message: error.message,
      rawText: error.rawText,
      cleanedText: error.cleanedText,
    };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function sendAndExit(response: PtyWorkerResponse): void {
  if (!process.send) process.exit(71);
  process.send(response, undefined, undefined, (error) => {
    if (process.connected) process.disconnect();
    process.exit(error ? 72 : 0);
  });
}
