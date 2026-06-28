// Single source of truth for the email matcher. Exposed as a source string so
// each caller can build a RegExp with the flags it needs (global for redaction,
// single-match for parsers) and keep its own `lastIndex` state.
export const EMAIL_PATTERN = "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b";
