import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: workspaceRoot,
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
