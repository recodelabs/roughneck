import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Coverage's picomatch-based include/exclude filter can't resolve "../"
// segments against absolute file paths, so glob patterns that reach outside
// the vitest root (this dir) must be absolute, computed relative to this
// config file rather than the process cwd.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "../coverage/app",
      // `allowExternal` lets the provider report on auth/lib/functions,
      // which live outside this vitest root (app/). Setting `include`
      // below is also what makes untested files in those dirs show up
      // as 0% ("all files" reach) rather than being omitted entirely —
      // Vitest 4 dropped the separate `coverage.all` toggle in favor of
      // this include-presence check.
      allowExternal: true,
      include: [
        "src/**/*.{ts,tsx}",
        `${repoRoot}auth/**/*.ts`,
        `${repoRoot}lib/**/*.ts`,
        `${repoRoot}functions/**/*.ts`,
      ],
      exclude: [
        "dist/**",
        "test/**",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/types.d.ts",
        `${repoRoot}auth/**/*.test.ts`,
        `${repoRoot}lib/**/*.test.ts`,
        `${repoRoot}functions/**/*.test.ts`,
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
      "../auth/**/*.test.ts",
      "../lib/**/*.test.ts",
    ],
  },
});
