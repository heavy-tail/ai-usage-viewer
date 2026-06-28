export class ParserDriftError extends Error {
  readonly sourceText: string;

  constructor(message: string, sourceText: string) {
    super(message);
    this.name = "ParserDriftError";
    this.sourceText = sourceText;
  }
}

export function isParserDriftError(error: unknown): error is ParserDriftError {
  return error instanceof ParserDriftError;
}
