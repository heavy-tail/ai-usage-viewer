import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGY_QUOTA_RPC_PATH,
  AgyRpcError,
  readAgyQuotaRpc,
  type AgyRpcOptions,
} from "../src/collectors/agyRpc";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-agy-rpc.mjs", import.meta.url)
);
const testDirectories: string[] = [];

afterEach(async () => {
  for (const directory of testDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true, maxRetries: 3 });
  }
});

describe("AGY local quota RPC", () => {
  it("closes stdin, calls the Connect endpoint, and removes the private log", async () => {
    const fixture = await createFixture("stdout");
    const result = await readAgyQuotaRpc(fixture.options);
    const marker = await readMarker(fixture.markerPath);

    expect(result.payload).toEqual({
      planLabel: "Fixture Pro",
      buckets: [{ modelId: "fixture-model", remainingFraction: 0.75 }],
    });
    expect(marker.stdinClosed).toBe(true);
    expect(marker.request).toEqual({
      method: "POST",
      url: AGY_QUOTA_RPC_PATH,
      body: "{}",
      accept: "application/json",
      connectProtocolVersion: "1",
      contentType: "application/json",
    });
    expect(marker.logPath.startsWith(fixture.tempDirectory)).toBe(true);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it.each(["stderr", "log"])(
    "discovers a strict loopback port from %s",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = await readAgyQuotaRpc(fixture.options);
      const marker = await readMarker(fixture.markerPath);

      // The log fixture uses AGY's real glog-prefixed production messages and
      // announces a live HTTPS trap first. Success proves only the `for HTTP`
      // line won.
      expect(result.payload).toMatchObject({ planLabel: "Fixture Pro" });
      expect(marker.requestCount).toBe(1);
      expect(existsSync(marker.logPath)).toBe(false);
      await expectProcessTreeDead(marker);
    }
  );

  it("retries transient HTTP failures until the service is ready", async () => {
    const fixture = await createFixture("transient");
    const result = await readAgyQuotaRpc(fixture.options);
    const marker = await readMarker(fixture.markerPath);

    expect(result.payload).toMatchObject({ planLabel: "Fixture Pro" });
    expect(marker.requestCount).toBe(3);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it("caps the decoded response and still tears down the process tree", async () => {
    const fixture = await createFixture("oversize", {
      maxResponseBytes: 256,
    });

    await expect(readAgyQuotaRpc(fixture.options)).rejects.toMatchObject<
      Partial<AgyRpcError>
    >({
      name: "AgyRpcError",
      code: "response",
      message: "AGY quota RPC response exceeded 256 bytes.",
    });
    const marker = await readMarker(fixture.markerPath);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it("caps the provider-written private log", async () => {
    const fixture = await createFixture("oversize-log", {
      maxLogBytes: 256,
    });

    await expect(readAgyQuotaRpc(fixture.options)).rejects.toMatchObject<
      Partial<AgyRpcError>
    >({
      name: "AgyRpcError",
      code: "response",
      message: "AGY private log exceeded 256 bytes.",
    });
    const marker = await readMarker(fixture.markerPath);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it("rejects a successful HTTP response unless its media type is JSON", async () => {
    const secret = "non-json-body-secret";
    const fixture = await createFixture("wrong-content-type", { secret });

    let error: unknown;
    try {
      await readAgyQuotaRpc(fixture.options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject<Partial<AgyRpcError>>({
      name: "AgyRpcError",
      code: "response",
      message: "AGY quota RPC returned a non-JSON response.",
    });
    expect(String(error)).not.toContain(secret);

    const marker = await readMarker(fixture.markerPath);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it("keeps the request deadline active while the response body is streaming", async () => {
    const fixture = await createFixture("slow-body", {
      timeoutMs: 5_000,
      requestTimeoutMs: 100,
    });
    const startedAt = Date.now();

    await expect(readAgyQuotaRpc(fixture.options)).rejects.toMatchObject<
      Partial<AgyRpcError>
    >({
      name: "AgyRpcError",
      code: "timeout",
      message: "AGY quota RPC timed out after 5000ms.",
    });
    // Includes the separately bounded Windows process-tree teardown.
    expect(Date.now() - startedAt).toBeLessThan(9_000);

    const marker = await readMarker(fixture.markerPath);
    // The fixture never ends this body. At least one accepted request plus a
    // bounded return proves the AbortController remained active past headers.
    expect(marker.requestCount).toBeGreaterThanOrEqual(1);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  }, 12_000);

  it("reports cleanup failure ahead of the RPC operation failure", async () => {
    const fixture = await createFixture("cleanup-fail");

    await expect(readAgyQuotaRpc(fixture.options)).rejects.toMatchObject<
      Partial<AgyRpcError>
    >({
      name: "AgyRpcError",
      code: "cleanup",
      message: "Unable to fully clean up AGY quota service.",
    });

    const marker = await readMarker(fixture.markerPath);
    // The fixture deliberately substituted a directory for the private file;
    // production cleanup refuses to recursively delete an unexpected object.
    expect(existsSync(marker.logPath)).toBe(true);
    await expectProcessTreeDead(marker);
  });

  it("ignores generic endpoint URLs and never leaks child output", async () => {
    const secret = "super-secret-access-token";
    const fixture = await createFixture("invalid-loopback", {
      // Leave enough room for the Windows Job Object host to start the fake
      // provider before exercising endpoint-discovery timeout behavior.
      timeoutMs: 4_000,
      secret,
    });

    let error: unknown;
    try {
      await readAgyQuotaRpc(fixture.options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject<Partial<AgyRpcError>>({
      name: "AgyRpcError",
      code: "timeout",
    });
    expect(String(error)).not.toContain(secret);

    const marker = await readMarker(fixture.markerPath);
    expect(marker.requestCount).toBe(0);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  }, 10_000);

  it("does not retry permanent HTTP rejection or expose its response body", async () => {
    const secret = "private-authorization-detail";
    const fixture = await createFixture("nontransient", {
      secret,
    });

    let error: unknown;
    try {
      await readAgyQuotaRpc(fixture.options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject<Partial<AgyRpcError>>({
      name: "AgyRpcError",
      code: "response",
      message: "AGY quota RPC rejected the request (HTTP 401).",
    });
    expect(String(error)).not.toContain(secret);

    const marker = await readMarker(fixture.markerPath);
    expect(marker.requestCount).toBe(1);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it("redacts streams and logs when AGY exits during startup", async () => {
    const secret = "private-startup-token";
    const fixture = await createFixture("exit", { secret });

    let error: unknown;
    try {
      await readAgyQuotaRpc(fixture.options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject<Partial<AgyRpcError>>({
      name: "AgyRpcError",
      code: "process",
      message: "AGY exited before its quota service became available.",
    });
    expect(String(error)).not.toContain(secret);

    const marker = await readMarker(fixture.markerPath);
    expect(existsSync(marker.logPath)).toBe(false);
    await expectProcessTreeDead(marker);
  });

  it("kills descendants when the provider root exits first", async () => {
    const fixture = await createFixture("parent-exit-worker");

    await expect(readAgyQuotaRpc(fixture.options)).rejects.toMatchObject<
      Partial<AgyRpcError>
    >({
      name: "AgyRpcError",
      code: "process",
    });

    const marker = await readMarker(fixture.markerPath);
    expect(marker.workerPid).toBeTypeOf("number");
    await expectProcessTreeDead(marker);
  });

  it("uses a unique private log for concurrent readers", async () => {
    const first = await createFixture("stdout");
    const second = await createFixture("stdout");

    await Promise.all([
      readAgyQuotaRpc(first.options),
      readAgyQuotaRpc(second.options),
    ]);
    const firstMarker = await readMarker(first.markerPath);
    const secondMarker = await readMarker(second.markerPath);

    expect(firstMarker.logPath).not.toBe(secondMarker.logPath);
    expect(existsSync(firstMarker.logPath)).toBe(false);
    expect(existsSync(secondMarker.logPath)).toBe(false);
    await expectProcessTreeDead(firstMarker);
    await expectProcessTreeDead(secondMarker);

    const remaining = await readdir(first.tempDirectory);
    expect(remaining.some((name) => name.startsWith("usage-viewer-agy-"))).toBe(
      false
    );
  });
});

type FixtureMarker = {
  pid: number;
  workerPid?: number;
  stdinClosed: boolean;
  logPath: string;
  requestCount: number;
  request?: {
    method: string;
    url: string;
    body: string;
    accept: string;
    connectProtocolVersion: string;
    contentType: string;
  };
};

async function createFixture(
  scenario: string,
  overrides: Partial<AgyRpcOptions> & { secret?: string } = {}
): Promise<{
  markerPath: string;
  tempDirectory: string;
  options: AgyRpcOptions;
}> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "usage-viewer-agy-rpc-"));
  testDirectories.push(tempDirectory);
  const markerPath = join(tempDirectory, "marker.json");
  const args = [
    fixturePath,
    "--scenario",
    scenario,
    "--marker",
    markerPath,
  ];
  if (overrides.secret) args.push("--secret", overrides.secret);

  return {
    markerPath,
    tempDirectory,
    options: {
      command: process.execPath,
      args,
      cwd: process.cwd(),
      timeoutMs: overrides.timeoutMs ?? 8_000,
      requestTimeoutMs: overrides.requestTimeoutMs ?? 500,
      pollIntervalMs: overrides.pollIntervalMs ?? 15,
      shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 1_500,
      maxResponseBytes: overrides.maxResponseBytes ?? 64 * 1024,
      maxLogBytes: overrides.maxLogBytes ?? 64 * 1024,
      tempDir: tempDirectory,
    },
  };
}

async function readMarker(path: string): Promise<FixtureMarker> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as FixtureMarker;
}

async function expectProcessTreeDead(marker: FixtureMarker): Promise<void> {
  await waitUntil(() => !isProcessAlive(marker.pid), 1_000);
  expect(isProcessAlive(marker.pid)).toBe(false);
  if (marker.workerPid !== undefined) {
    await waitUntil(() => !isProcessAlive(marker.workerPid as number), 1_000);
    expect(isProcessAlive(marker.workerPid)).toBe(false);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
