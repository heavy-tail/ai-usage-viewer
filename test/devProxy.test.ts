import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_BACKEND_ORIGIN,
  DEVELOPMENT_DASHBOARD_ORIGIN,
  trustedForwardedDevelopmentOrigin,
} from "../src/server/devProxy";

describe("Vite development proxy Origin policy", () => {
  it("rewrites only the exact dashboard origin", () => {
    expect(trustedForwardedDevelopmentOrigin(DEVELOPMENT_DASHBOARD_ORIGIN)).toBe(
      DEVELOPMENT_BACKEND_ORIGIN
    );
    expect(trustedForwardedDevelopmentOrigin("https://attacker.example")).toBeUndefined();
    expect(trustedForwardedDevelopmentOrigin("null")).toBeUndefined();
    expect(trustedForwardedDevelopmentOrigin(undefined)).toBeUndefined();
  });
});
