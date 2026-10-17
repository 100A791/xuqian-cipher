import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 构建时生成 Service Worker（见 scripts/sw-template.js）。
 *
 * 注入两样东西：
 * - `__PRECACHE__`：本次构建的全部产物（hashed 文件名），install 时原子写入缓存；
 * - `__BUILD__`：产物列表的哈希，用作缓存名，同时充当"这份 SW 对应哪次构建"的标识。
 *
 * 只在 build 阶段生效；dev 下不产出 sw.js，也不注册（避免 HMR 与缓存互相干扰）。
 */
function offlineServiceWorker(): Plugin {
  return {
    name: 'xq-offline-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((file) => !file.endsWith('.map'))
      const precache = [...new Set(['./', './index.html', ...files.map((file) => `./${file}`)])]
      const buildId = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)
      const template = readFileSync(new URL('./scripts/sw-template.js', import.meta.url), 'utf8')
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('__BUILD__', buildId).replace('__PRECACHE__', JSON.stringify(precache, null, 2)),
      })
    },
  }
}

// 纯静态前端：无后端、无外部请求。CSP 在 index.html 中声明。
export default defineConfig({
  base: './',
  plugins: [react(), offlineServiceWorker()],
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
