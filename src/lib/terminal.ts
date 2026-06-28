import stripAnsi from "strip-ansi";

const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export function cleanTerminalOutput(raw: string): string {
  const stripped = stripAnsi(raw)
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "");

  return collapseDuplicateLines(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function collapseDuplicateLines(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const normalized = line.trim();
    const previous = out[out.length - 1]?.trim();
    if (normalized && normalized === previous) continue;
    out.push(line);
  }
  return out.join("\n");
}
