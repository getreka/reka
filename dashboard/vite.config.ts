import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  preview: {
    port: 3001,
    host: "0.0.0.0",
    allowedHosts: ["demo.akeryuu.com"],
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
    },
  },
});
