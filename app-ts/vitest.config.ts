import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
  // Tests do not write log files (logger.ts reads at import time)
  env: { LOG__FILE_ENABLED: "false" },
});
