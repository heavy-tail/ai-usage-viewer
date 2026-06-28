export class CollectorUnavailableError extends Error {
  readonly rawText?: string;
  readonly cleanedText?: string;

  constructor(message: string, rawText?: string, cleanedText?: string) {
    super(message);
    this.name = "CollectorUnavailableError";
    this.rawText = rawText;
    this.cleanedText = cleanedText;
  }
}

export class PtyTimeoutError extends Error {
  readonly rawText: string;
  readonly cleanedText: string;

  constructor(message: string, rawText: string, cleanedText: string) {
    super(message);
    this.name = "PtyTimeoutError";
    this.rawText = rawText;
    this.cleanedText = cleanedText;
  }
}

export class PtyProcessError extends Error {
  readonly rawText: string;
  readonly cleanedText: string;

  constructor(message: string, rawText: string, cleanedText: string) {
    super(message);
    this.name = "PtyProcessError";
    this.rawText = rawText;
    this.cleanedText = cleanedText;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
