import { create } from 'zustand'
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import { get as idbGet, set as idbSet } from 'idb-keyval'
import { nanoid } from 'nanoid'
import { NODE_TYPES } from './nodeTypes'

export const STORAGE_KEY = 'idea-canvas-state'

// 历史栈上限，避免内存无限增长
const HISTORY_LIMIT = 50
const VALID_HANDLE = new Set(['left', 'right'])

// 只存稳定字段，避免 React Flow 瞬态字段（selected/dragging/measured…）污染持久层
function pickNodes(nodes) {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
  }))
}
function pickEdges(edges) {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    label: e.label ?? '',
    type: e.type ?? 'default',
    data: e.data ?? null,
  }))
}
function normalizeEdge(e) {
  return {
    ...e,
    sourceHandle: VALID_HANDLE.has(e.sourceHandle) ? e.sourceHandle : null,
    targetHandle: VALID_HANDLE.has(e.targetHandle) ? e.targetHandle : null,
  }
}

let saveTimer
// 真正落盘：把多画布结构写入 IndexedDB
function doPersist(state) {
  const data = {
    canvases: state.canvases.map((c) => ({
      id: c.id,
      name: c.name,
      nodes: pickNodes(c.nodes),
      edges: pickEdges(c.edges),
    })),
    currentId: state.currentId,
    crossEdges: state.crossEdges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceCanvas: e.sourceCanvas,
      target: e.target,
      targetCanvas: e.targetCanvas,
      label: e.label || '',
      reason: e.reason || '',
    })),
  }
  idbSet(STORAGE_KEY, data)
    .then(() => useStore.setState({ saveStatus: 'saved' }))
    .catch(() => useStore.setState({ saveStatus: 'saved' }))
}

export const useStore = create((set, get) => {
  // 在「当前画布」上执行变更，并同步顶层 nodes/edges/past/future 投影（供 App/Inspector 直接消费）
  const mutateCurrent = (fn, shouldFlush = false) => {
    const s = get()
    const cid = s.currentId
    let top = {}
    const canvases = s.canvases.map((c) => {
      if (c.id !== cid) return c
      const res = fn(c) // 返回 { nodes?, edges?, past?, future? }
      top = {
        nodes: res.nodes !== undefined ? res.nodes : c.nodes,
        edges: res.edges !== undefined ? res.edges : c.edges,
        past: res.past !== undefined ? res.past : c.past,
        future: res.future !== undefined ? res.future : c.future,
      }
      return { ...c, ...res }
    })
    set({ canvases, ...top })
    if (shouldFlush) get().flushSave()
  }

  // 拍快照（变更前保存当前画布状态），并清空重做栈
  const snap = (c) => [...c.past, { nodes: c.nodes, edges: c.edges }].slice(-HISTORY_LIMIT)

  return {
    // —— 多画布结构 ——
    canvases: [{ id: 'c1', name: '画布 1', nodes: [], edges: [], past: [], future: [] }],
    currentId: 'c1',
    // 顶层投影：始终等于「当前画布」的节点/边/历史，供 App 与 Inspector 直接读取
    nodes: [],
    edges: [],
    past: [],
    future: [],

    // 跨画布关联：端点分属不同画布的边，存于顶层（与画布解耦，切换画布不丢失）
    crossEdges: [],

    selectedNodeId: null,
    detailNodeId: null,
    collapsed: false,

    // 画布交互模式：'pan' = 左键拖拽平移；'select' = 左键拖拽框选
    selectionMode: 'pan',
    // 框选/多选得到的上下文卡片集合（id 列表）
    selectedNodeIds: [],

    // 自动保存状态：'saved' | 'saving'
    saveStatus: 'saved',
    // 是否已从持久层加载完成；加载完成前不写回，防止 load/reset 阶段覆盖真实数据
    hydrated: false,

    // ===== 画布管理 =====
    addCanvas: (name) => {
      const id = 'c' + nanoid(6)
      const c = {
        id,
        name: name || `画布 ${get().canvases.length + 1}`,
        nodes: [],
        edges: [],
        past: [],
        future: [],
      }
      set((s) => ({
        canvases: [...s.canvases, c],
        currentId: id,
        nodes: [],
        edges: [],
        past: [],
        future: [],
        selectedNodeId: null,
        detailNodeId: null,
        selectedNodeIds: [],
      }))
      get().flushSave()
      return id
    },
    switchCanvas: (id) => {
      const s = get()
      if (id === s.currentId) return
      const c = s.canvases.find((x) => x.id === id)
      if (!c) return
      set({
        currentId: id,
        nodes: c.nodes,
        edges: c.edges,
        past: c.past,
        future: c.future,
        selectedNodeId: null,
        detailNodeId: null,
        selectedNodeIds: [],
      })
      get().flushSave()
    },
    renameCanvas: (id, name) => {
      set((s) => ({ canvases: s.canvases.map((c) => (c.id === id ? { ...c, name } : c)) }))
      get().flushSave()
    },
    deleteCanvas: (id) => {
      const s = get()
      if (s.canvases.length <= 1) return
      const idx = s.canvases.findIndex((c) => c.id === id)
      const canvases = s.canvases.filter((c) => c.id !== id)
      const newCur = canvases[Math.max(0, idx - 1)]
      set({
        canvases,
        currentId: newCur.id,
        nodes: newCur.nodes,
        edges: newCur.edges,
        past: newCur.past,
        future: newCur.future,
        // 同时清理指向/来自该画布的跨画布关联
        crossEdges: s.crossEdges.filter((e) => e.sourceCanvas !== id && e.targetCanvas !== id),
        selectedNodeId: null,
        detailNodeId: null,
        selectedNodeIds: [],
      })
      get().flushSave()
    },

    // 新增跨画布关联：source/target 为节点 id，sourceCanvas/targetCanvas 为各自画布 id
    addCrossEdge: ({ source, sourceCanvas, target, targetCanvas, label, reason }) => {
      const s = get()
      // 去重：同一对节点跨画布不重复连
      const dup = s.crossEdges.some(
        (e) =>
          (e.source === source && e.target === target) || (e.source === target && e.target === source),
      )
      if (dup) return null
      const id = 'x' + nanoid(6)
      set((st) => ({
        crossEdges: [
          ...st.crossEdges,
          { id, source, sourceCanvas, target, targetCanvas, label: label || '关联', reason: reason || '' },
        ],
      }))
      get().flushSave()
      return id
    },
    deleteCrossEdge: (id) => {
      set((s) => ({ crossEdges: s.crossEdges.filter((e) => e.id !== id) }))
      get().flushSave()
    },

    // ===== 当前画布的节点 / 边操作 =====
    onNodesChange: (changes) =>
      mutateCurrent((c) => {
        const shouldSnap = changes.some(
          (ch) =>
            (ch.type === 'position' && ch.dragging === false) ||
            ch.type === 'add' ||
            ch.type === 'remove' ||
            ch.type === 'replace',
        )
        return {
          nodes: applyNodeChanges(changes, c.nodes),
          past: shouldSnap ? snap(c) : c.past,
          future: shouldSnap ? [] : c.future,
        }
      }),

    onEdgesChange: (changes) =>
      mutateCurrent((c) => {
        const shouldSnap = changes.some(
          (ch) => ch.type === 'add' || ch.type === 'remove' || ch.type === 'replace',
        )
        return {
          edges: applyEdgeChanges(changes, c.edges),
          past: shouldSnap ? snap(c) : c.past,
          future: shouldSnap ? [] : c.future,
        }
      }),

    onConnect: (connection) =>
      mutateCurrent(
        (c) => ({
          edges: addEdge({ ...connection }, c.edges),
          past: snap(c),
          future: [],
        }),
        true,
      ),

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
    deselectNodes: (ids) => {
      mutateCurrent((c) => ({
        nodes: c.nodes.map((n) => (ids.includes(n.id) ? { ...n, selected: false } : n)),
      }))
      set((s) => ({ selectedNodeIds: s.selectedNodeIds.filter((id) => !ids.includes(id)) }))
    },

    // 清空全部选择
    clearSelection: () => {
      mutateCurrent((c) => ({ nodes: c.nodes.map((n) => ({ ...n, selected: false })) }))
      set({ selectedNodeIds: [] })
    },

    deleteNode: (id) => {
      mutateCurrent(
        (c) => ({
          nodes: c.nodes.filter((n) => n.id !== id),
          edges: c.edges.filter((e) => e.source !== id && e.target !== id),
          past: snap(c),
          future: [],
        }),
        true,
      )
      set((s) => ({
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        detailNodeId: s.detailNodeId === id ? null : s.detailNodeId,
      }))
    },

    addNode: (type, position, data = {}) => {
      const id = nanoid(6)
      const node = {
        id,
        type: 'custom',
        position,
        data: { type, content: '', read: false, ...data },
      }
      mutateCurrent(
        (c) => ({ nodes: [...c.nodes, node], past: snap(c), future: [] }),
        true,
      )
      return id
    },

    updateNodeData: (id, patch) =>
      mutateCurrent(
        (c) => ({
          nodes: c.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
          past: snap(c),
          future: [],
        }),
        true,
      ),

    // 批量更新节点（用于「优化画布」重新排版：传入 (nodes)=>nodes 或新数组）
    setNodes: (updater) =>
      mutateCurrent(
        (c) => ({
          nodes: typeof updater === 'function' ? updater(c.nodes) : updater,
          past: snap(c),
          future: [],
        }),
        true,
      ),

    // 批量更新连线（用于「备份/恢复」替换或合并边）
    setEdges: (updater) =>
      mutateCurrent(
        (c) => ({
          edges: typeof updater === 'function' ? updater(c.edges) : updater,
          past: snap(c),
          future: [],
        }),
        true,
      ),

    addNodesAndEdges: (newNodes, newEdges) =>
      mutateCurrent(
        (c) => ({
          nodes: [...c.nodes, ...newNodes],
          edges: [...c.edges, ...newEdges],
          past: snap(c),
          future: [],
        }),
        true,
      ),

    clear: () => {
      mutateCurrent(
        (c) => ({
          nodes: [],
          edges: [],
          past: snap(c),
          future: [],
        }),
        true,
      )
      set({ selectedNodeId: null, detailNodeId: null, selectedNodeIds: [] })
    },

    // 恢复初始界面：清空当前画布所有用户节点/连线（不再自动清空持久层，需用户主动点「清空画布」）
    resetToInitial: () => {
      mutateCurrent(
        (c) => ({
          nodes: [],
          edges: [],
          past: snap(c),
          future: [],
        }),
        true,
      )
      set({ selectedNodeId: null, detailNodeId: null, selectedNodeIds: [] })
    },

    // 撤销：弹出最近快照，当前状态压入重做栈（仅作用于当前画布）
    undo: () => {
      const s = get()
      const c = s.canvases.find((x) => x.id === s.currentId)
      if (!c.past.length) return
      const prev = c.past[c.past.length - 1]
      const canvases = s.canvases.map((x) =>
        x.id === s.currentId
          ? {
              ...x,
              past: x.past.slice(0, -1),
              future: [{ nodes: x.nodes, edges: x.edges }, ...x.future].slice(0, HISTORY_LIMIT),
              nodes: prev.nodes,
              edges: prev.edges,
            }
          : x,
      )
      const cur = canvases.find((x) => x.id === s.currentId)
      set({ canvases, nodes: cur.nodes, edges: cur.edges, past: cur.past, future: cur.future })
      get().flushSave()
    },

    // 重做：恢复最近一次撤销
    redo: () => {
      const s = get()
      const c = s.canvases.find((x) => x.id === s.currentId)
      if (!c.future.length) return
      const next = c.future[0]
      const canvases = s.canvases.map((x) =>
        x.id === s.currentId
          ? {
              ...x,
              future: x.future.slice(1),
              past: [...x.past, { nodes: x.nodes, edges: x.edges }].slice(-HISTORY_LIMIT),
              nodes: next.nodes,
              edges: next.edges,
            }
          : x,
      )
      const cur = canvases.find((x) => x.id === s.currentId)
      set({ canvases, nodes: cur.nodes, edges: cur.edges, past: cur.past, future: cur.future })
      get().flushSave()
    },

    // 立即落盘（关键操作/页面卸载前调用），绕过防抖定时器
    flushSave: () => {
      const s = get()
      if (!s.hydrated) return
      clearTimeout(saveTimer)
      doPersist(s)
    },

    // 启动加载：兼容旧单画布数据（{nodes,edges}）与新多画布结构（{canvases,currentId}）
    load: async () => {
      const saved = await idbGet(STORAGE_KEY)
      let canvases
      if (saved && Array.isArray(saved.canvases) && saved.canvases.length) {
        canvases = saved.canvases.map((c) => ({
          id: c.id || 'c' + nanoid(6),
          name: c.name || '画布',
          nodes: Array.isArray(c.nodes) ? c.nodes : [],
          edges: Array.isArray(c.edges) ? c.edges.map(normalizeEdge) : [],
          past: [],
          future: [],
        }))
      } else if (saved && (Array.isArray(saved.nodes) || Array.isArray(saved.edges))) {
        // 旧版单画布数据迁移为「画布 1」
        canvases = [
          {
            id: 'c1',
            name: '画布 1',
            nodes: saved.nodes || [],
            edges: (saved.edges || []).map(normalizeEdge),
            past: [],
            future: [],
          },
        ]
      } else {
        canvases = [{ id: 'c1', name: '画布 1', nodes: [], edges: [], past: [], future: [] }]
      }
      const currentId =
        saved && saved.currentId && canvases.some((c) => c.id === saved.currentId)
          ? saved.currentId
          : canvases[0].id
      const cur = canvases.find((c) => c.id === currentId)
      const crossEdges = Array.isArray(saved?.crossEdges)
        ? saved.crossEdges.map((e) => ({
            id: e.id || 'x' + nanoid(6),
            source: e.source,
            sourceCanvas: e.sourceCanvas,
            target: e.target,
            targetCanvas: e.targetCanvas,
            label: e.label || '关联',
            reason: e.reason || '',
          }))
        : []
      set({
        canvases,
        currentId,
        nodes: cur.nodes,
        edges: cur.edges,
        past: cur.past,
        future: cur.future,
        crossEdges,
        hydrated: true,
      })
    },
  }
})

// 自动持久化：变更后防抖写入 IndexedDB（本地、离线可用）
// 只有 hydrated 之后、且 canvases 实际变化才触发，避免 load/reset 阶段误写覆盖真实数据
useStore.subscribe((state, prev) => {
  if (!state.hydrated) return
  if (state.canvases === prev.canvases) return
  useStore.setState({ saveStatus: 'saving' })
  clearTimeout(saveTimer)
  // 防抖 150ms：兼顾写入及时性与高频操作（拖动）的合并
  saveTimer = setTimeout(() => doPersist(state), 150)
})

export { NODE_TYPES }
