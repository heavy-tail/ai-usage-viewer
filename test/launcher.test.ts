import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows desktop launcher trust boundary", () => {
  it("uses the Program Files Node binary directly and blocks inherited injection", async () => {
    const launcher = await readFile(
      join(process.cwd(), "scripts", "start-usage-viewer.ps1"),
      "utf8"
    );

    expect(launcher).toContain('Join-Path $env:ProgramFiles "nodejs\\node.exe"');
    expect(launcher).toContain("-FilePath $NodePath");
    expect(launcher).not.toContain('-FilePath "npm.cmd"');
    expect(launcher).not.toContain('-FilePath "node.exe"');
    expect(launcher).toContain('"NODE_OPTIONS"');
    expect(launcher).toContain('"NODE_PATH"');
    expect(launcher).toContain('"NPM_CONFIG_SCRIPT_SHELL"');
    expect(launcher).toContain("$listenerExecutable.Equals(");
    expect(launcher).toContain("$NodePath.TrimEnd");
    expect(launcher).toContain("-TimeoutSec 60");
    expect(launcher).toContain('"--pipe"');
    expect(launcher).toContain("[string]$ServerProcess.Id");
  });
});
