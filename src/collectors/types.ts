import type { AppConfig, CollectorState, UsageLimit, UsageProvider } from "../types";
import type { PtyRunner } from "./pty";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<CommandResult>;

export type CollectorContext = {
  rootDir: string;
  config: AppConfig;
  ptyRunner: PtyRunner;
  commandRunner: CommandRunner;
};

export type ProviderCollectorResult = {
  provider: UsageProvider;
  ok: boolean;
  state: Exclude<CollectorState, "ok" | "stale"> | "ok";
  checkedAt: string;
  durationMs: number;
  limits: UsageLimit[];
  rawText: string;
  cleanedText: string;
  rawFileName: string;
  error?: string;
};

export type ProviderCollector = (
  context: CollectorContext
) => Promise<ProviderCollectorResult>;
