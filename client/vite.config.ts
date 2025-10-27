import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/health": "http://localhost:3000",
      "/search-character": "http://localhost:3000",
      "/subscribe": "http://localhost:3000",
      "/subscribe-name": "http://localhost:3000",
      "/character/summary": "http://localhost:3000",
      "/events": {
        target: "http://localhost:3000",
        changeOrigin: true,
        proxyTimeout: 0,
        ws: false,
      },
    },
  },
});
