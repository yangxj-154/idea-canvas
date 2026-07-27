import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import '@xyflow/react/dist/style.css'
import { registerSW } from 'virtual:pwa-register'

const isLocal =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname.startsWith('192.168.') ||
  location.hostname.startsWith('10.')

const CLEARED = 'lapop-pwa-cleared'

// 彻底清理历史遗留的 Service Worker 与 Cache Storage。
// 旧版自动注册的 SW 会缓存已被重新构建删除的旧 JS（404），
// 导致 React 挂载失败、整页变白；且该清理逻辑若在被旧 SW 拦截的
// 页面里就永远跑不到，形成死锁。返回 true 表示将要 reload，调用方
// 不应再渲染 React。
async function clearLegacyPWA() {
  if (sessionStorage.getItem(CLEARED)) return false

  const tasks = []
  let regsCount = 0
  let cachesCount = 0

  if ('serviceWorker' in navigator) {
    tasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => {
          regsCount = regs.length
          return Promise.all(regs.map((r) => r.unregister().catch(() => {})))
        })
        .catch(() => {}),
    )
  }

  if ('caches' in window) {
    tasks.push(
      caches
        .keys()
        .then((names) => {
          cachesCount = names.length
          return Promise.all(names.map((name) => caches.delete(name).catch(() => {})))
        })
        .catch(() => {}),
    )
  }

  await Promise.all(tasks)
  const changed = regsCount > 0 || cachesCount > 0
  if (changed) {
    sessionStorage.setItem(CLEARED, '1')
    location.reload()
  }
  return changed
}

async function start() {
  if (isLocal) {
    const willReload = await clearLegacyPWA()
    if (willReload) return
  } else {
    registerSW({ immediate: true })
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

start()
