import { resolve } from "node:path";
import { refreshService } from "./refresh";

const rootDir = resolve(process.cwd());
const snapshot = await refreshService.refresh({ rootDir });

const okCount = snapshot.collectors.filter((collector) => collector.ok).length;
console.log(
  `Generated data/usage-snapshot.json with ${snapshot.limits.length} rows; ${okCount}/${snapshot.collectors.length} collectors ok.`
);

for (const collector of snapshot.collectors) {
  const suffix = collector.error ? ` - ${collector.error}` : "";
  console.log(
    `${collector.provider}: ${collector.state} (${collector.durationMs} ms)${suffix}`
  );
}

process.exit(0);
