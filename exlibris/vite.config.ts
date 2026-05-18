import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { $lib: path.resolve(__dirname, "src/lib") },
  },
  clearScreen: false,
  server: { port: 5174, strictPort: true },
});
