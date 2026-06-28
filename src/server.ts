import { resolve } from "node:path";
import { createUsageServer } from "./server/app";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4317);

const server = createUsageServer({ rootDir: resolve(process.cwd()) });
server.listen(PORT, HOST, () => {
  console.log(`AI Usage API listening on http://${HOST}:${PORT}`);
});
