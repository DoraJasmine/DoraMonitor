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
  optimizeDeps: {
    include: ["@tauri-apps/api/core"],
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    commonjsOptions: {
      include: [/node_modules/],
    },
    // Split the big vendor deps so app code changes don't bust the whole
    // bundle cache; hashed chunks stay immutable-cacheable on the server.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "scheduler"],
          icons: ["lucide-react"],
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-scroll-area",
          ],
        },
      },
    },
    chunkSizeWarningLimit: 600,
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
