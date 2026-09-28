import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Keep IB/Flex log lines out of the test report.
    silent: true,
  },
});
