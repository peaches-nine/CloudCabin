import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api 与 /desktop 代理到本地后端（npm run dev 时用）
const BACKEND = process.env.BACKEND || 'http://localhost:8080';

export default defineConfig({
  plugins: [
    react(),
    // PWA 在开发阶段关闭 —— ServiceWorker 容易导致缓存刷新循环
    // 上线时加回来: VitePWA({ registerType: 'autoUpdate', ... })
  ],
  server: {
    proxy: {
      '/api': BACKEND,
      '/desktop': { target: BACKEND, ws: true },
    },
  },
  build: { outDir: 'dist' },
});
