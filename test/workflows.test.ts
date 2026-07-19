import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("privileged compatibility workflows", () => {
  it("keeps manual branch selection off the credentialed self-hosted runner", async () => {
    const canary = await workflow("compatibility-canary.yml");
    const request = await workflow("compatibility-baseline-request.yml");

    expect(canary).toContain("workflow_run:");
    expect(canary).toContain(
      'workflows: ["Request compatibility baseline acceptance"]'
    );
    expect(canary).toContain("branches: [main]");
    expect(canary).not.toContain("  workflow_dispatch:");
    expect(canary).toContain(
      "github.event.workflow_run.head_branch == github.event.repository.default_branch"
    );
    expect(canary).toContain(
      "github.event.workflow_run.head_sha || github.sha"
    );

    expect(request).toContain("  workflow_dispatch:");
    expect(request).toContain("permissions: {}");
    expect(request).toContain("runs-on: ubuntu-latest");
    expect(request).not.toMatch(/runs-on:.*self-hosted/);
  });

  it("writes the protected baseline only after a manual approval run", async () => {
    const canary = await workflow("compatibility-canary.yml");
    const persist = between(
      canary,
      "- name: Persist successful protected baseline",
      "- name: Create redacted compatibility artifact"
    );
    const sanitize = between(
      canary,
      "- name: Create redacted compatibility artifact",
      "- name: Upload redacted compatibility report only"
    );

    expect(persist).toContain("github.event_name == 'workflow_run'");
    expect(sanitize).toContain('$env:BASELINE_OUTCOME -eq "skipped"');
    expect(sanitize).toContain('$env:BASELINE_OUTCOME -eq "success"');
    expect(canary).toContain("npm run compatibility:baseline:validate");
    expect(sanitize).toContain("$baselineValidationPassed");
  });

  it("monitors the provider runner from an independent GitHub-hosted workflow", async () => {
    const watchdog = await workflow("compatibility-watchdog.yml");

    expect(watchdog).toContain("runs-on: ubuntu-latest");
    expect(watchdog).toContain("workflow_run:");
    expect(watchdog).not.toContain("workflow_dispatch:");
    expect(watchdog).toContain("compatibility-canary.yml/runs?per_page=30");
    expect(watchdog).toContain("age_seconds -gt 2700");
    expect(watchdog).toContain("success_age -gt 36000");
    expect(watchdog).toContain("issues: write");
  });

  it("binds each published archive and exact asset inventory to the tested commit", async () => {
    const ci = await workflow("ci.yml");
    const release = await workflow("release.yml");

    expect(ci).toContain("BUILD-PROVENANCE.json");
    expect(ci).toContain("sourceCommit = $env:GITHUB_SHA.ToLowerInvariant()");
    expect(ci).toContain("packageVersion = $packageVersion");
    expect(release).toContain("zipfile.ZipFile");
    expect(release).toContain('"sourceCommit": tested_sha');
    expect(release).toContain("Unexpected CI artifact inventory");
    expect(release).toContain("Unexpected published release assets");
    expect(release).toContain("cmp -s \"$archive_file\"");
    expect(release.match(/git fetch --no-tags origin main/g)).toHaveLength(2);
    expect(release).toContain("Main advanced during artifact verification");
  });
});

async function workflow(name: string): Promise<string> {
  return readFile(join(process.cwd(), ".github", "workflows", name), "utf8");
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Could not locate workflow section ${start} -> ${end}`);
  }
  return text.slice(startIndex, endIndex);
}
