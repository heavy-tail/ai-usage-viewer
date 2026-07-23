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

  it("separates provider collection from approved baseline promotion", async () => {
    const canary = await workflow("compatibility-canary.yml");
    const reader = between(
      canary,
      "  compatibility:",
      "  promote-baseline:"
    );
    const writer = canary.slice(canary.indexOf("  promote-baseline:"));
    const candidate = between(
      canary,
      "- name: Create a privacy-safe baseline candidate",
      "- name: Create the allow-list redacted compatibility report"
    );

    expect(reader).toContain(
      "runs-on: [self-hosted, Windows, X64, usage-viewer-canary]"
    );
    expect(reader).toContain("environment: compatibility-canary-readonly");
    expect(reader).toContain(
      "Prove the provider runner cannot write the protected baseline"
    );
    expect(reader).toContain("npm ci --ignore-scripts");
    expect(reader).toContain(
      "'^(?i)(ACTIONS_|GITHUB_|RUNNER_|USAGE_VIEWER_CANARY_)'"
    );
    expect(reader).not.toContain("issues: write");
    expect(reader).not.toContain("[IO.File]::Replace");
    expect(candidate).toContain("compatibility:baseline:create");
    expect(candidate).toContain("candidateSha256");
    expect(canary).toContain(
      "path: canary-artifacts/compatibility-report.json"
    );
    expect(canary).toContain(
      "canary-artifacts/candidate-baseline.json"
    );
    expect(canary).not.toContain(".canary-artifacts");

    expect(writer).toContain(
      "runs-on: [self-hosted, Windows, X64, usage-viewer-canary-writer]"
    );
    expect(writer).toContain("environment: compatibility-canary");
    expect(writer).not.toContain("actions/checkout@");
    expect(writer).not.toContain("npm ");
    expect(writer).toContain(
      "Baseline promotion must use a different runner and Windows account."
    );
    expect(writer).toContain(
      "The default branch advanced after the candidate was tested."
    );
    expect(writer.match(/Assert-MainUnchanged/g)).toHaveLength(3);
    expect(writer).toContain("[IO.File]::Replace");
    expect(canary).not.toContain("Open, update, or close the compatibility issue");
    expect(canary).not.toContain("issues: write");
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

    expect(ci).toContain('$releaseDir = Join-Path $PWD "release-artifacts"');
    expect(ci).toContain(
      'Get-ChildItem -LiteralPath "release-artifacts" -Filter "*.zip"'
    );
    expect(ci).toContain("release-artifacts/*.zip");
    expect(ci).toContain("release-artifacts/*.sha256");
    expect(ci).not.toContain('Join-Path $PWD ".release"');
    expect(ci).not.toContain(".release/*.zip");
    expect(ci).toContain("BUILD-PROVENANCE.json");
    expect(ci).toContain("sourceCommit = $env:GITHUB_SHA.ToLowerInvariant()");
    expect(ci).toContain("packageVersion = $packageVersion");
    expect(ci).toContain("$expectedPackageVersion =");
    expect(ci).toContain(
      "bundleProvenance.packageVersion -ne $expectedPackageVersion"
    );
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
