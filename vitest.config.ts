import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run the auth env/DB bootstrap before importing any test module so the
    // shared PrismaClient connects to the throwaway test database.
    setupFiles: ["src/auth/__tests__/setup-env.ts"],
  },
});
