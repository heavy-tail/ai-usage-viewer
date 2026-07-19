import { describe, expect, it } from "vitest";
import { displayHealthMessage } from "../src/components/ProviderCard";
import type { CollectorHealth } from "../src/types";

const base: CollectorHealth = {
  provider: "claude",
  enabled: true,
  ok: false,
  state: "error",
  checkedAt: "2026-07-18T12:00:00.000Z",
  durationMs: 1,
};

describe("ProviderCard health messages", () => {
  it("explains retained values without exposing collector diagnostics", () => {
    expect(displayHealthMessage({ ...base, state: "stale" }, true)).toBe(
      "Latest refresh failed; showing last verified values."
    );
  });

  it("keeps first-run failures visible with a simple user-facing result", () => {
    expect(displayHealthMessage({ ...base, state: "error" }, false)).toBe(
      "Usage is temporarily unavailable."
    );
    expect(displayHealthMessage({ ...base, state: "drift" }, false)).toBe(
      "Usage format changed; waiting for a verified update."
    );
  });
});
