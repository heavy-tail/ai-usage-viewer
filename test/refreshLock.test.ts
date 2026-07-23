import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRefreshLockHeld,
  tryAcquireRefreshLock,
} from "../src/refreshLock";

describe("refresh lock", () => {
  it("does not let stale diagnostic text claim mutex ownership", async () => {
    const rootDir = await lockWorkspace();
    const lockPath = join(rootDir, "data", "refresh.lock");
    await writeFile(lockPath, '{"pid":', "utf8");

    await expect(isRefreshLockHeld(rootDir)).resolves.toBe(false);
    const release = await tryAcquireRefreshLock(rootDir);

    expect(release).toBeTypeOf("function");
    await expect(isRefreshLockHeld(rootDir)).resolves.toBe(true);
    await release?.();
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a valid lock owned by this live process as held", async () => {
    const rootDir = await lockWorkspace();
    const release = await tryAcquireRefreshLock(rootDir);

    expect(release).toBeTypeOf("function");
    await expect(isRefreshLockHeld(rootDir)).resolves.toBe(true);
    await expect(tryAcquireRefreshLock(rootDir)).resolves.toBeUndefined();

    await release?.();
    await expect(isRefreshLockHeld(rootDir)).resolves.toBe(false);
  });

  it("allows exactly one winner when acquisition races", async () => {
    const rootDir = await lockWorkspace();
    const attempts = await Promise.all([
      tryAcquireRefreshLock(rootDir),
      tryAcquireRefreshLock(rootDir),
      tryAcquireRefreshLock(rootDir),
    ]);
    const winners = attempts.filter(
      (release): release is NonNullable<typeof release> => release !== undefined
    );

    expect(winners).toHaveLength(1);
    await winners[0]();
  });

  it("treats a junction alias as the same workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "usage-viewer-lock-alias-"));
    const rootDir = join(parent, "workspace");
    const alias = join(parent, "workspace-alias");
    await mkdir(join(rootDir, "data"), { recursive: true });
    await symlink(rootDir, alias, "junction");

    const release = await tryAcquireRefreshLock(rootDir);
    expect(release).toBeTypeOf("function");
    await expect(tryAcquireRefreshLock(alias)).resolves.toBeUndefined();
    await release?.();
  });
});

async function lockWorkspace(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "usage-viewer-lock-"));
  await mkdir(join(rootDir, "data"), { recursive: true });
  return rootDir;
}
