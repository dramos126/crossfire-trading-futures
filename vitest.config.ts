import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts", "research/**/*.test.ts"],
    // research/scout has its own package.json and vitest config; its deps (playwright, unpdf) are not in the root install.
    exclude: ["**/node_modules/**", "research/scout/**"],
    testTimeout: 20_000,
    pool: "forks",
    // Console output goes straight to stdout instead of over the worker RPC.
    // Intercepted, a log from a file's last test can still be in flight when
    // the worker closes, and vitest fails the whole run on that
    // ("Closing rpc while onUserConsoleLog was pending") with every test green
    // — it blocked prod deploy #280 (bugs.md A100).
    disableConsoleIntercept: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
