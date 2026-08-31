import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 本地 npm run dev 时将 API 请求转发到本地后端（默认 3000 端口）
    proxy: {
      "^/(accounts|grab-tasks)(/|$)": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
