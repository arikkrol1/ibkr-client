import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Backend runs on :4010 (see server/src/config.ts). Proxy API + WS to it in dev
// so the browser only ever talks to the Vite origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4010", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4010", ws: true },
    },
  },
});
