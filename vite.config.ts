import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 纯静态前端：无后端、无外部请求。CSP 在 index.html 中声明。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5188,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: 5189,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
} as never)
