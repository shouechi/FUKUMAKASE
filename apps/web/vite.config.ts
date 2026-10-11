import { defineConfig } from "vite";
import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vinext(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    watch: { usePolling: true },
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
});
