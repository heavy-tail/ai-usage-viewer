// POSIX single-quote escaping for values interpolated into `sh -lc` strings.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
