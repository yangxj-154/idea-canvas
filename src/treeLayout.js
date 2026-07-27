import { nanoid } from 'nanoid'

const X_GAP = 220
const Y_GAP = 120

// 把 AI 返回的节点树转成带层级坐标的 nodes / edges。
// 两种模式：
//  - idea 模式：tree = { root, children }，从 origin 生成完整树，横向（左→右）布局。
//  - drill 模式：opts.anchor 存在，把 tree.children 作为 anchor 的下一级子节点
//    挂到该卡片右侧，不再另起浮空簇。
export function treeToGraph(tree, opts = {}) {
  const { origin = { x: 0, y: 0 }, anchor } = opts
  const nodes = []
  const edges = []
  const idMap = new Map()
  let leaf = 0

  function assign(node, depth, parentId, rel) {
    const id = nanoid(6)
    const entry = { id, node, depth, parentId, rel: rel || 'relates', children: [] }
    idMap.set(id, entry)
    const kids = node.children || []
    if (kids.length === 0) {
      entry.y = leaf * Y_GAP
      leaf += 1
    } else {
      entry.children = kids.map((k) => assign(k, depth + 1, id, k.rel))
      entry.y =
        (entry.children[0].y + entry.children[entry.children.length - 1].y) / 2
    }
    entry.x = depth * X_GAP
    return entry
  }

  if (anchor) {
    // 下钻：anchor 已是画布上的节点，子节点挂在它右侧
    const top = (tree.children || []).map((k) => assign(k, 1, anchor.id, k.rel))
    if (top.length) {
      const ys = top.map((e) => e.y)
      const mid = (Math.min(...ys) + Math.max(...ys)) / 2
      for (const e of idMap.values()) e.y -= mid
    }
  } else {
    if (tree.root) {
      assign({ ...tree.root, children: tree.children }, 0, null, null)
    } else {
      // 顶层没有 root（模型省略 root 时）：把 children 当作平行根节点直接布局，
      // 避免在原位生成一个 content 为空的"幽灵节点"并连上子节点。
      ;(tree.children || []).forEach((k) => assign(k, 0, null, k.rel))
    }
  }

  const baseX = anchor ? anchor.position.x : origin.x
  const baseY = anchor ? anchor.position.y : origin.y

  for (const e of idMap.values()) {
    const node = e.node
    const content = [node.title, node.body].filter(Boolean).join('\n')
    nodes.push({
      id: e.id,
      type: 'custom',
      position: { x: baseX + e.x, y: baseY + e.y },
      data: { type: node.type || 'idea', content, ai: true, read: false },
    })
    if (e.parentId) {
      edges.push({
        id: `e-${e.parentId}-${e.id}`,
        source: e.parentId,
        target: e.id,
      })
    }
  }
  return { nodes, edges }
}
