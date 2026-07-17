// 纠错学习：记录用户对 AI 生成节点的删改，汇总成约束注入后续拆解。
// 数据仅存本机 IndexedDB（key idea-canvas-corrections），不上传。
import { get, set } from 'idb-keyval'
import { NODE_TYPES } from './nodeTypes'

const KEY = 'idea-canvas-corrections'

export async function loadCorrections() {
  try {
    return (await get(KEY)) || []
  } catch {
    return []
  }
}

export async function recordCorrection(entry) {
  const list = await loadCorrections()
  list.push({ ...entry, at: Date.now() })
  await set(KEY, list.slice(-200))
  return list
}

// 汇总成一句话约束，注入拆解系统提示
export async function buildLearningSummary() {
  const list = await loadCorrections()
  if (!list.length) return ''
  const byType = {}
  for (const e of list) {
    byType[e.type] = byType[e.type] || { delete: 0, edit: 0 }
    byType[e.type][e.action] = (byType[e.type][e.action] || 0) + 1
  }
  const parts = []
  for (const [type, c] of Object.entries(byType)) {
    const label = NODE_TYPES[type]?.label || type
    if (c.delete >= 2) {
      parts.push(`用户多次删除「${label}」类节点，请尽量少生成该类型，或仅在确实必要时生成`)
    }
    if (c.edit >= 3) {
      parts.push(`用户常手动修改「${label}」类节点文字，生成时请更贴近用户可能的表述，减少冗余`)
    }
  }
  if (!parts.length) return ''
  return `\n用户偏好（来自历史纠错，请遵循）：\n- ${parts.join('\n- ')}`
}
