import { win32 } from "node:path";

/**
 * Resolve a Windows inbox executable without consulting the repository working
 * directory or PATH. Provider commands intentionally use PATH; operating-system
 * utilities used for discovery and process cleanup must not.
 */
export function windowsSystem32Executable(
  fileName: string,
  systemRoot = process.env.SystemRoot
): string {
  if (
    !/^[A-Za-z0-9._-]+\.exe$/i.test(fileName) ||
    win32.basename(fileName) !== fileName
  ) {
    throw new Error("Windows system executable must be a plain .exe file name.");
  }
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot must be an absolute Windows path.");
  }
  return win32.join(win32.resolve(systemRoot), "System32", fileName);
}

export function windowsPowerShellExecutable(
  systemRoot = process.env.SystemRoot
): string {
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot must be an absolute Windows path.");
  }
  return win32.join(
    win32.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

export function firstRunnableWindowsCommand(
  candidates: string[]
): string | undefined {
  // `where.exe` can emit extensionless Unix shims before the adjacent Windows
  // .cmd shim. Ignore files CreateProcess/cmd cannot execute, while otherwise
  // preserving the directory and PATHEXT order reported by Windows.
  return candidates.find((candidate) =>
    /\.(?:com|exe|cmd|bat)$/i.test(win32.extname(candidate))
  );
}

export function windowsBatchCommandSpec(
  command: string,
  args: string[],
  wrapperPath: string
): { command: string; args: string[] } {
  for (const value of [command, ...args]) assertSafeWindowsBatchToken(value);
  const payload = Buffer.from(JSON.stringify({ command, args }), "utf8").toString(
    "base64"
  );
  return {
    command: windowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wrapperPath,
      payload,
    ],
  };
}

export function windowsPtyCommandSpec(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  // Native executables already accept an argv array and must not be routed
  // through cmd.exe: doing so would both broaden the shell boundary and reject
  // legitimate literal arguments such as JavaScript snippets containing `%`.
  if (!/\.(?:cmd|bat)$/i.test(win32.extname(command))) {
    return { command, args };
  }
  return {
    command: windowsSystem32Executable("cmd.exe"),
    args: [
      "/d",
      "/s",
      "/v:off",
      "/c",
      [command, ...args].map(quoteWindowsPtyToken).join(" "),
    ],
  };
}

export function trustedChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const entries = new Map<string, { key: string; value: string | undefined }>();
  for (const [key, value] of [
    ...Object.entries(base),
    ...Object.entries(overrides),
  ]) {
    entries.set(platform === "win32" ? key.toLowerCase() : key, { key, value });
  }

  if (platform !== "win32") {
    return Object.fromEntries(
      [...entries.values()]
        .filter((entry) => entry.value !== undefined)
        .map((entry) => [entry.key, entry.value as string])
    );
  }

  const unsafe = new Set([
    "node_options",
    "node_path",
    "node_tls_reject_unauthorized",
    "npm_config_node_options",
    "npm_config_script_shell",
  ]);
  const systemRoot = entries.get("systemroot")?.value;
  const path = entries.get("path")?.value;
  const result: NodeJS.ProcessEnv = {};

  for (const [normalized, entry] of entries) {
    if (
      entry.value === undefined ||
      unsafe.has(normalized) ||
      normalized === "path" ||
      normalized === "pathext" ||
      normalized === "comspec"
    ) {
      continue;
    }
    result[entry.key] = entry.value;
  }
  if (path !== undefined) result.Path = path;
  result.ComSpec = windowsSystem32Executable("cmd.exe", systemRoot);
  result.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  return result;
}

function quoteWindowsPtyToken(value: string): string {
  // Interactive .cmd shims require cmd.exe. Keep its command line deliberately
  // narrow: provider paths/flags never need expansion or control operators.
  assertSafeWindowsBatchToken(value);
  return /[ \t()]/.test(value) ? `"${value}"` : value;
}

function assertSafeWindowsBatchToken(value: string): void {
  // PowerShell ultimately delegates .cmd/.bat execution to cmd.exe, which can
  // interpret these characters even when the original process launch used an
  // argument array. Provider commands only require ordinary paths and flags.
  if (/[\0\r\n"%!&|<>^]/.test(value)) {
    throw new Error("Windows command contains unsupported shell characters.");
  }
}
