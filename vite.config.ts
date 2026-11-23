import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Tauri expects a fixed port, and the app must work offline: everything,
// including the face detector's WebAssembly and model, is bundled.
export default defineConfig({
  plugins: [preact()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "safari16", chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
});
