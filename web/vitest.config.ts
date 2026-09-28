import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic in src/utils and src/api.ts, so a plain Node
// environment is enough — no DOM, no React plugin.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
