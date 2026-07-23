import { describe, expect, it } from "vitest";
import {
  buildStaleStatusLabel,
  displayStatusLabel,
} from "../src/lib/staleLabel";

describe("stale row labels", () => {
  it("keeps staleness in stored diagnostics but hides it in the primary UI", () => {
    expect(buildStaleStatusLabel()).toBe("stale");
    expect(displayStatusLabel("stale")).toBeUndefined();
  });

  it("preserves meaningful provider detail without the technical stale prefix", () => {
    expect(displayStatusLabel("stale - Quota available")).toBe(
      "Quota available"
    );
  });

  it("continues to suppress legacy pay-as-you-go detail", () => {
    expect(displayStatusLabel("stale - pay-as-you-go disabled")).toBeUndefined();
  });
});
