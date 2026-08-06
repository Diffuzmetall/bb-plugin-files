import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@bb/plugin-sdk/app": path.resolve(
        import.meta.dirname,
        "test/plugin-sdk-app-runtime.tsx",
      ),
      "@": path.resolve(import.meta.dirname),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
  },
});
