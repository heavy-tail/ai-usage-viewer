import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local-only dashboard. Bind to 127.0.0.1 per the spec's security section.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // .gitignore keeps these out of Git, but the dev server would still serve
    // them over HTTP from the project root. Deny private config, runtime data,
    // and VCS metadata explicitly. Setting `deny` replaces Vite's defaults, so
    // the built-ins (.env, certs, .git) are re-included here.
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "config.json",
        "**/data/**",
        "*.local",
        "DEPLOY_PLAN.md",
      ],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
        configure(proxy) {
          // Production accepts only its exact browser origin. In development,
          // Vite is the trusted same-machine reverse proxy, so normalize the
          // forwarded Origin to the backend origin instead of weakening the
          // production server's check to accept arbitrary loopback ports.
          proxy.on("proxyReq", (request) => {
            if (request.getHeader("origin")) {
              request.setHeader("origin", "http://127.0.0.1:4317");
            }
          });
        },
      },
    },
  },
});
