import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：/api 与 /ws 代理到 tmon server（默认 8456，与 docs/03-design.md §6 单例 server 对齐）
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // Windows 上 ::1 绑定可能被拒
    port: 5190, // 5173 在 Windows 排除端口范围（5088-5187，Hyper-V 保留）内
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8456',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8456',
        ws: true,
      },
    },
  },
});
