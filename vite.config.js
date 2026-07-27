import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const APP_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

export default defineConfig({
  // GitHub Pages 项目站点部署在子路径 /lapop/ 下，必须设置 base，
  // 否则打包后的 JS/CSS/图标资源全部 404、页面白屏。
  base: '/lapop/',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
  },
  build: {
    // 调试阶段开启 sourcemap，便于把 minified React 错误还原到源码行
    sourcemap: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 改为手动注册：本地预览（localhost）不启用 SW，避免缓存旧产物导致刷新黑屏；
      // 仅在生产域名（GitHub Pages）启用 PWA 离线缓存。
      injectRegister: null,
      // 加速接管：新 SW 安装后立即 claim 所有页面并跳过等待，
      // 让浏览器尽快把「残留的旧 SW」更新为「会清理旧缓存的新 SW」，打破缓存死锁。
      clientsClaim: true,
      skipWaiting: true,
      manifest: {
        name: 'LAPOP',
        short_name: 'LAPOP',
        description: '个人想法图谱：拆解、关联、沉淀。数据存你本地，AI 用你自己的 Key。',
        lang: 'zh-CN',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
})
