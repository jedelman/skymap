import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and serves dist/ in release builds.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2021", sourcemap: false },
  test: { environment: "node", globals: true },
});
