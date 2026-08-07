import { get, set } from 'idb-keyval'

const KEY = 'idea-canvas-settings'

export async function loadSettings() {
  try {
    return (await get(KEY)) || null
  } catch {
    return null
  }
}

export async function saveSettings(s) {
  try {
    await set(KEY, s)
  } catch (e) {
    console.warn('保存模型设置失败', e)
  }
}

// 会话持久化：按画布隔离的 map —— { [canvasId]: { messages, threads } }
// 每个画布拥有独立的主会话与节点下钻对话，切换画布互不干扰
const CHAT_KEY = 'idea-canvas-chat'

export async function loadChat() {
  try {
    const c = await get(CHAT_KEY)
    if (!c) return {}
    // 兼容旧版全局结构 { messages, threads }（迁移为画布 c1）
    if (Array.isArray(c.messages)) {
      return {
        c1: {
          messages: c.messages,
          threads: c.threads && typeof c.threads === 'object' ? c.threads : {},
        },
      }
    }
    // 新版：已是按画布隔离的 map
    const map = {}
    for (const [id, v] of Object.entries(c)) {
      if (!v || typeof v !== 'object') continue
      map[id] = {
        messages: Array.isArray(v.messages) ? v.messages : [],
        threads: v.threads && typeof v.threads === 'object' ? v.threads : {},
      }
    }
    return map
  } catch {
    return {}
  }
}

export async function saveChat(map) {
  try {
    await set(CHAT_KEY, map)
  } catch (e) {
    console.warn('保存会话失败', e)
  }
}
