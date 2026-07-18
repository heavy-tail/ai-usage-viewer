import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const QUOTA_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && value !== undefined) values.set(key, value);
}

const scenario = values.get("--scenario") ?? "stdout";
const markerPath = values.get("--marker");
const logPath = values.get("--log-file");
const secret = values.get("--secret") ?? "fixture-secret-should-not-leak";
if (!markerPath || !logPath) process.exit(64);

let requestCount = 0;
let request = null;
let server;
let trapServer;
let worker;
const marker = () => {
  writeFileSync(
    markerPath,
    JSON.stringify({
      pid: process.pid,
      workerPid: worker?.pid,
      stdinClosed: process.stdin.readableEnded,
      logPath,
      requestCount,
      request,
    })
  );
};

// The test process remains bounded even if the runner under test regresses.
const watchdog = setTimeout(() => {
  worker?.kill("SIGKILL");
  server?.close();
  trapServer?.close();
  process.exit(98);
}, 10_000);

process.stdin.resume();
if (!process.stdin.readableEnded) {
  await new Promise((resolve) => process.stdin.once("end", resolve));
}

if (scenario === "exit") {
  process.stderr.write(`startup failed bearer=${secret}\n`);
  appendFileSync(logPath, `private startup failure ${secret}\n`);
  marker();
  clearTimeout(watchdog);
  process.exit(2);
}

worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
marker();

if (scenario === "parent-exit-worker") {
  // The provider root exits while a descendant deliberately stays alive. The
  // Windows Job Object host must kill that orphan when its sole handle closes.
  clearTimeout(watchdog);
  process.exit(3);
}

if (scenario === "secret-timeout") {
  process.stdout.write(`not a trusted address; token=${secret}\n`);
  process.stderr.write(`authorization=${secret}\n`);
  appendFileSync(logPath, `private log secret=${secret}\n`);
  await new Promise(() => undefined);
}

server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk.toString("utf8");
  requestCount += 1;
  request = {
    method: req.method,
    url: req.url,
    body,
    accept: req.headers.accept,
    connectProtocolVersion: req.headers["connect-protocol-version"],
    contentType: req.headers["content-type"],
  };
  marker();

  if (req.method !== "POST" || req.url !== QUOTA_PATH) {
    res.writeHead(404).end();
    return;
  }
  if (scenario === "transient" && requestCount < 3) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end(`temporarily unavailable ${secret}`);
    return;
  }
  if (scenario === "nontransient") {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end(`unauthorized ${secret}`);
    return;
  }
  if (scenario === "cleanup-fail") {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end(`unauthorized ${secret}`);
    return;
  }
  if (scenario === "slow-body") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"partial":');
    return;
  }
  if (scenario === "oversize") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ padding: "x".repeat(8_192) }));
    return;
  }
  if (scenario === "wrong-content-type") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(JSON.stringify({ secret }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      planLabel: "Fixture Pro",
      buckets: [{ modelId: "fixture-model", remainingFraction: 0.75 }],
    })
  );
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") process.exit(70);
const endpoint = `http://127.0.0.1:${address.port}`;

if (scenario === "cleanup-fail") {
  // An unexpected directory at the private-file path makes non-recursive
  // deletion fail without relying on platform-specific file permissions.
  rmSync(logPath, { force: true });
  mkdirSync(logPath);
} else if (scenario === "oversize-log") {
  appendFileSync(logPath, "x".repeat(8_192));
} else {
  appendFileSync(logPath, `private fixture log token=${secret}\n`);
}
if (scenario === "stderr") {
  process.stderr.write(
    `Language server listening on random port at ${address.port} for HTTP\n`
  );
} else if (scenario === "log") {
  trapServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ planLabel: "Wrong HTTPS endpoint" }));
  });
  await new Promise((resolve, reject) => {
    trapServer.once("error", reject);
    trapServer.listen(0, "127.0.0.1", resolve);
  });
  const trapAddress = trapServer.address();
  if (!trapAddress || typeof trapAddress === "string") process.exit(71);
  setTimeout(() => {
    appendFileSync(
      logPath,
      `I0718 22:06:47.758933 ${process.pid} server.go:538] Language server listening on random port at ${trapAddress.port} for HTTPS (gRPC)\n` +
        `I0718 22:06:47.759933 ${process.pid} server.go:546] Language server listening on random port at ${address.port} for HTTP\n`
    );
  }, 30);
} else if (scenario === "invalid-loopback") {
  process.stdout.write(
    `Language server listening at http://192.0.2.10:${address.port}; token=${secret}\n` +
      `Chrome debug server at ${endpoint}\n`
  );
} else if (scenario === "oversize-log") {
  // The runner must inspect the oversized private log before it can discover
  // an endpoint from another source.
} else {
  process.stdout.write(
    `Language server listening on random port at ${address.port} for HTTP\n`
  );
}
marker();

await new Promise(() => undefined);
