import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname),
  base: "./",
  worker: { format: "es" },
  build: { outDir: path.resolve(import.meta.dirname, "..", "dist", "v2"), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
