import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: "web",
  publicDir: "public-assets",
  // Relative asset URLs so Tauri custom-protocol / file loads work (not only http://127.0.0.1).
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "web/src"),
    },
  },
  // @lobehub/icons ships ESM that needs pre-bundling under Vite
  optimizeDeps: {
    include: ["@lobehub/icons/es/Kimi", "@tauri-apps/api/core"],
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3847",
        changeOrigin: true,
      },
    },
  },
});
