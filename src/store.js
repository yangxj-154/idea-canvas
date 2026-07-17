import { create } from 'zustand'
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import { get, set } from 'idb-keyval'
import { nanoid } from 'nanoid'
import { NODE_TYPES } from './nodeTypes'

export const STORAGE_KEY = 'idea-canvas-state'

export const useStore = create((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  detailNodeId: null,

  onNodesChange: (changes) =>
    set({ nodes: applyNodeChanges(changes, get().nodes) }),

  onEdgesChange: (changes) =>
    set({ edges: applyEdgeChanges(changes, get().edges) }),

  onConnect: (connection) =>
    set({ edges: addEdge({ ...connection }, get().edges) }),

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  setDetailNode: (id) => set({ detailNodeId: id }),

  deleteNode: (id) =>
    set((state) => ({
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
    set({ nodes: [...get().nodes, node] })
    return id
  },

  updateNodeData: (id, patch) =>
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    }),

  addNodesAndEdges: (newNodes, newEdges) =>
    set({
      nodes: [...get().nodes, ...newNodes],
      edges: [...get().edges, ...newEdges],
    }),

  clear: () =>
    set({ nodes: [], edges: [], selectedNodeId: null, detailNodeId: null }),

  load: async () => {
    const saved = await get(STORAGE_KEY)
    if (saved && saved.nodes) {
      set({ nodes: saved.nodes, edges: saved.edges || [] })
    }
  },
}))

// 自动持久化：变更后防抖写入 IndexedDB（本地、离线可用）
let saveTimer
useStore.subscribe((state) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    set(STORAGE_KEY, { nodes: state.nodes, edges: state.edges })
  }, 400)
})

export { NODE_TYPES }
