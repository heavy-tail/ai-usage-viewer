import type { PtyRunResult, PtyStep, PtyResponder, RunPtyOptions } from "./pty";

type SerializedPattern =
  | { kind: "text"; value: string }
  | { kind: "regex"; source: string; flags: string };

type SerializedStep = Omit<PtyStep, "waitFor"> & {
  waitFor?: SerializedPattern;
};

type SerializedResponder = Omit<PtyResponder, "when"> & {
  when: SerializedPattern;
};

export type SerializedPtyOptions = Omit<
  RunPtyOptions,
  "steps" | "responders"
> & {
  steps: SerializedStep[];
  responders?: SerializedResponder[];
};

export type SerializedPtyError = {
  kind: "unavailable" | "timeout" | "process" | "unknown";
  message: string;
  rawText?: string;
  cleanedText?: string;
};

export type PtyWorkerResponse =
  | { ok: true; result: PtyRunResult }
  | { ok: false; error: SerializedPtyError };

export function serializePtyOptions(options: RunPtyOptions): SerializedPtyOptions {
  return {
    ...options,
    steps: options.steps.map((step) => ({
      ...step,
      waitFor: step.waitFor ? serializePattern(step.waitFor) : undefined,
    })),
    responders: options.responders?.map((responder) => ({
      ...responder,
      when: serializePattern(responder.when),
    })),
  };
}

export function deserializePtyOptions(
  options: SerializedPtyOptions
): RunPtyOptions {
  return {
    ...options,
    steps: options.steps.map((step) => ({
      ...step,
      waitFor: step.waitFor ? deserializePattern(step.waitFor) : undefined,
    })),
    responders: options.responders?.map((responder) => ({
      ...responder,
      when: deserializePattern(responder.when),
    })),
  };
}

function serializePattern(pattern: RegExp | string): SerializedPattern {
  return typeof pattern === "string"
    ? { kind: "text", value: pattern }
    : { kind: "regex", source: pattern.source, flags: pattern.flags };
}

function deserializePattern(pattern: SerializedPattern): RegExp | string {
  return pattern.kind === "text"
    ? pattern.value
    : new RegExp(pattern.source, pattern.flags);
}
