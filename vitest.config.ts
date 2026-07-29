import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // client/src is included for the design-token test, which parses the real
    // index.css. It needs no DOM, so the default node environment is fine.
    include: [
      "server/**/*.test.ts", "server/**/*.spec.ts",
      "client/src/**/*.test.ts",
    ],
  },
});
