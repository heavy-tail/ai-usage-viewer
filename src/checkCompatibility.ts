import { join, resolve } from "node:path";
import { buildCompatibilityReport } from "./compatibilityReport";
import { loadConfig } from "./config";
import { refreshService } from "./refresh";
import { writeCompatibilityReport } from "./storage";

const rootDir = resolve(process.cwd());
const config = await loadConfig(rootDir);
const snapshot = await refreshService.refresh({ rootDir });
const report = buildCompatibilityReport(snapshot, config.enabledProviders);
const reportFile = join(rootDir, "data", "compatibility-report.json");
await writeCompatibilityReport(rootDir, report);

console.log(
  report.passed
    ? `Compatibility check passed for ${report.providers.length} provider(s).`
    : `Compatibility check failed; see ${reportFile}.`
);
for (const provider of report.providers) {
  console.log(
    `${provider.provider}: ${provider.state}; ${provider.rowCount} row(s); adapter ${provider.adapterVersion ?? "unknown"}`
  );
}

process.exitCode = report.passed ? 0 : 1;
