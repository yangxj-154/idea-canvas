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

// 会话持久化：主会话 messages + 每个节点的下钻对话 threads（nodeId -> 消息数组）
const CHAT_KEY = 'idea-canvas-chat'

export async function loadChat() {
  try {
    const c = await get(CHAT_KEY)
    if (!c) return { messages: [], threads: {} }
    return {
      messages: Array.isArray(c.messages) ? c.messages : [],
      threads: c.threads && typeof c.threads === 'object' ? c.threads : {},
    }
  } catch {
    return { messages: [], threads: {} }
  }
}

export async function saveChat(data) {
  try {
    await set(CHAT_KEY, data)
  } catch (e) {
    console.warn('保存会话失败', e)
  }
}
