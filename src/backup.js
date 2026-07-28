import { get } from 'idb-keyval'
import { STORAGE_KEY } from './store'
import { loadSettings, loadChat, saveSettings, saveChat } from './settings'

// 收集整个应用状态（画布 + 设置 + 会话），用于完整备份
export async function collectAppState() {
  const canvas = (await get(STORAGE_KEY)) || { nodes: [], edges: [] }
  const settings = await loadSettings()
  const chat = await loadChat()
  return {
    app: 'LAPOP',
    kind: 'full',
    version: 1,
    exportedAt: new Date().toISOString(),
    canvas: { nodes: canvas.nodes || [], edges: canvas.edges || [] },
    settings: settings || null,
    chat: chat || { messages: [], threads: {} },
  }
}

// 触发浏览器下载
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// AES-GCM 加密（浏览器内置 crypto.subtle，零依赖）
export async function encryptJSON(data, passphrase) {
  const enc = new TextEncoder()
  const raw = enc.encode(JSON.stringify(data))
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  )
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw))
  return {
    app: 'LAPOP',
    encrypted: true,
    kind: 'full',
    version: 1,
    exportedAt: new Date().toISOString(),
    salt: Array.from(salt),
    iv: Array.from(iv),
    data: Array.from(cipher),
  }
}

export async function decryptJSON(payload, passphrase) {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  )
  const salt = new Uint8Array(payload.salt)
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  )
  const iv = new Uint8Array(payload.iv)
  const cipher = new Uint8Array(payload.data)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
  return JSON.parse(new TextDecoder().decode(plain))
}

// 应用恢复：mode = 'replace' | 'merge'
export async function applyAppState(parsed, mode, store) {
  const canvas = parsed.canvas || (parsed.nodes ? parsed : null)
  const incomingNodes = (canvas && canvas.nodes) || []
  const incomingEdges = (canvas && canvas.edges) || []
  if (mode === 'replace') {
    store.setNodes(() => incomingNodes)
    if (store.setEdges) store.setEdges(() => incomingEdges)
    if (parsed.settings) await saveSettings(parsed.settings)
    if (parsed.chat) await saveChat(parsed.chat)
  } else {
    store.setNodes((ns) => {
      const have = new Set(ns.map((n) => n.id))
      return [...ns, ...incomingNodes.filter((n) => !have.has(n.id))]
    })
    if (store.setEdges) {
      store.setEdges((es) => {
        const have = new Set(es.map((e) => e.id))
        return [...es, ...incomingEdges.filter((e) => e.id && !have.has(e.id))]
      })
    }
  }
}
