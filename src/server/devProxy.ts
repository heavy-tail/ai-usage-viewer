export const DEVELOPMENT_DASHBOARD_ORIGIN = "http://127.0.0.1:5173";
export const DEVELOPMENT_BACKEND_ORIGIN = "http://127.0.0.1:4317";

/**
 * Only the exact local Vite origin may be translated to the backend origin.
 * Every other value must remain untouched so the backend's Origin guard can
 * reject it; returning undefined means "do not rewrite this header".
 */
export function trustedForwardedDevelopmentOrigin(
  origin: string | string[] | number | undefined
): string | undefined {
  return origin === DEVELOPMENT_DASHBOARD_ORIGIN
    ? DEVELOPMENT_BACKEND_ORIGIN
    : undefined;
}
