import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // 백엔드(Express: 3000)로 프록시
      "/health": "http://localhost:3000",
      "/events": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // SSE를 위한 설정
        proxyTimeout: 0,
        ws: false,
      },
      "/subscribe": "http://localhost:3000",
      "/api": "http://localhost:3000",
    },
  },
});
