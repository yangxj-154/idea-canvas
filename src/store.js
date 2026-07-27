import { create } from 'zustand'
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import { get, set } from 'idb-keyval'
import { nanoid } from 'nanoid'
import { NODE_TYPES } from './nodeTypes'

export const STORAGE_KEY = 'idea-canvas-state'

// 历史栈上限，避免内存无限增长
const HISTORY_LIMIT = 50

export const useStore = create((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  detailNodeId: null,
  collapsed: false,

  // 画布交互模式：'pan' = 左键拖拽平移；'select' = 左键拖拽框选
  selectionMode: 'pan',
  // 框选/多选得到的上下文卡片集合（id 列表）
  selectedNodeIds: [],

  // 撤销/重做栈：每项保存 { nodes, edges } 快照
  past: [],
  future: [],

  // 自动保存状态：'saved' | 'saving'
  saveStatus: 'saved',

  // 拍快照（在变更前保存当前图状态），并清空重做栈
  _snapshot: () =>
    set((s) => ({
      past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT),
      future: [],
    })),

  onNodesChange: (changes) =>
    set((s) => {
      // 拖动结束（dragging=false）或结构性变更（add/remove/replace）才入栈，避免拖动过程爆炸
      const shouldSnap = changes.some(
        (c) =>
          (c.type === 'position' && c.dragging === false) ||
          c.type === 'add' ||
          c.type === 'remove' ||
          c.type === 'replace',
      )
      return {
        nodes: applyNodeChanges(changes, s.nodes),
        past: shouldSnap ? [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT) : s.past,
        future: shouldSnap ? [] : s.future,
      }
    }),

  onEdgesChange: (changes) =>
    set((s) => {
      const shouldSnap = changes.some(
        (c) => c.type === 'add' || c.type === 'remove' || c.type === 'replace',
      )
      return {
        edges: applyEdgeChanges(changes, s.edges),
        past: shouldSnap ? [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT) : s.past,
        future: shouldSnap ? [] : s.future,
      }
    }),

  onConnect: (connection) =>
    set((s) => ({
      past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT),
      future: [],
      edges: addEdge({ ...connection }, s.edges),
    })),

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  setDetailNode: (id) => set({ detailNodeId: id }),

  // 聊天面板收起态（提升到 store，确保父组件分割线/展开条随状态联动）
  setCollapsed: (v) => set({ collapsed: typeof v === 'function' ? v(get().collapsed) : v }),

  // 画布交互模式切换
  setSelectionMode: (m) => set({ selectionMode: m }),

  // 框选结果（由 React Flow onSelectionChange 写入；相同内容不触发更新，防止重复 setState 循环）
  setSelectedNodeIds: (ids) =>
    set((s) => {
      const cur = s.selectedNodeIds
      if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return s
      return { selectedNodeIds: ids }
    }),

  // 取消选中指定节点（同步清除 React Flow 的 selected 标记）
  deselectNodes: (ids) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (ids.includes(n.id) ? { ...n, selected: false } : n)),
      selectedNodeIds: s.selectedNodeIds.filter((id) => !ids.includes(id)),
    })),

  // 清空全部选择
  clearSelection: () =>
    set((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: false })),
      selectedNodeIds: [],
    })),

  deleteNode: (id) =>
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    })),

  addNode: (type, position, data = {}) => {
    const id = nanoid(6)
    const node = {
      id,
      type: 'custom',
      position,
      data: { type, content: '', read: false, ...data },
    }
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, node],
    }))
    return id
  },

  updateNodeData: (id, patch) =>
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    })),

  // 批量更新节点（用于「优化画布」重新排版：传入 (nodes)=>nodes 或新数组）
  setNodes: (updater) =>
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: typeof updater === 'function' ? updater(state.nodes) : updater,
    })),

  addNodesAndEdges: (newNodes, newEdges) =>
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, ...newNodes],
      edges: [...state.edges, ...newEdges],
    })),

  clear: () =>
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [],
      edges: [],
      selectedNodeId: null,
      detailNodeId: null,
      selectedNodeIds: [],
    })),

  // 恢复初始界面：清空所有用户节点/连线，展示 LAPOP 空状态（不再注入示例动图卡片）
  resetToInitial: () =>
    set((state) => ({
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [],
      edges: [],
      selectedNodeId: null,
      detailNodeId: null,
      selectedNodeIds: [],
    })),

  // 撤销：弹出最近快照，当前状态压入重做栈
  undo: () =>
    set((s) => {
      if (!s.past.length) return s
      const prev = s.past[s.past.length - 1]
      return {
        past: s.past.slice(0, -1),
        future: [{ nodes: s.nodes, edges: s.edges }, ...s.future].slice(0, HISTORY_LIMIT),
        nodes: prev.nodes,
        edges: prev.edges,
      }
    }),

  // 重做：恢复最近一次撤销
  redo: () =>
    set((s) => {
      if (!s.future.length) return s
      const next = s.future[0]
      return {
        past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        nodes: next.nodes,
        edges: next.edges,
      }
    }),

  load: async () => {
    const saved = await get(STORAGE_KEY)
    const nodes = saved && saved.nodes ? saved.nodes : []
    const edges = saved && saved.edges ? saved.edges : []
    set({ nodes, edges })
  },
}))

// 自动持久化：变更后防抖写入 IndexedDB（本地、离线可用）
// 只存稳定字段（id/type/position/data），不存 React Flow 的瞬态字段
// （selected / dragging / measured / positionAbsolute / width / height），
// 否则重载后会出现"幽灵选中"和过时布局。
// 写入前标记 saving，写入成功标记 saved，供顶栏状态指示。
let saveTimer
useStore.subscribe((state, prev) => {
  // 只有 nodes / edges 实际变化才触发保存，避免 past/future/saveStatus 变化引发循环
  if (state.nodes === prev.nodes && state.edges === prev.edges) return
  useStore.setState({ saveStatus: 'saving' })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const nodes = state.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    }))
    const edges = state.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      label: e.label ?? '',
      type: e.type ?? 'default',
      data: e.data ?? null,
    }))
    set(STORAGE_KEY, { nodes, edges })
      .then(() => useStore.setState({ saveStatus: 'saved' }))
      .catch(() => useStore.setState({ saveStatus: 'saved' }))
  }, 400)
})

export { NODE_TYPES }
