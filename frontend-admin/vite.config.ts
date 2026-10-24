import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev 3001；/api 代理到 app-admin 后端。把 Origin 改写为上游自身，
// 让开发代理仍按同源请求处理，不必为本地开发放宽后端 CORS 白名单。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8016",
        changeOrigin: true,
        headers: { Origin: "http://127.0.0.1:8016" },
      },
    },
  },
});
