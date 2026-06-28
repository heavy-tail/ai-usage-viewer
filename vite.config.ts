import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local-only dashboard. Bind to 127.0.0.1 per the spec's security section.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
});
