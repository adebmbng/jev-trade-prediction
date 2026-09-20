import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 360, height: 800 },
  },
  webServer: {
    command: "VITE_SHOW_JEV=true pnpm dev:web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
