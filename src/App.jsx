import { useEffect, useMemo, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from '@xyflow/react'
import { useStore } from './store'
import { NODE_TYPES, NODE_TYPE_KEYS } from './nodeTypes'
import CustomNode from './CustomNode'
import AIPanel from './AIPanel'
import Inspector from './Inspector'

const nodeTypes = { custom: CustomNode }

// 计算想法根：从连线做无向连通分量，每个分量选一个"想法根"（类型 idea 优先，否则无入边者）
function computeRoots(nodes, edges) {
  const adj = new Map()
  nodes.forEach((n) => adj.set(n.id, []))
  edges.forEach((e) => {
    if (adj.has(e.source)) adj.get(e.source).push(e.target)
    if (adj.has(e.target)) adj.get(e.target).push(e.source)
  })
  const rootOf = new Map()
  const membersOf = new Map()
  const roots = []
  for (const n of nodes) {
    if (rootOf.has(n.id)) continue
    const queue = [n.id]
    const members = []
    while (queue.length) {
      const cur = queue.shift()
      if (rootOf.has(cur)) continue
      rootOf.set(cur, null)
      members.push(cur)
      for (const nb of adj.get(cur) || []) if (!rootOf.has(nb)) queue.push(nb)
    }
    let rootId = members.find(
      (id) => nodes.find((x) => x.id === id)?.data.type === 'idea',
    )
    if (!rootId) {
      const incoming = new Set(edges.map((e) => e.target))
      rootId = members.find((id) => !incoming.has(id)) || members[0]
    }
    members.forEach((id) => rootOf.set(id, rootId))
    membersOf.set(rootId, members)
    roots.push(rootId)
  }
  return { rootOf, roots, membersOf }
}

function Canvas() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    clear,
    load,
    setSelectedNode,
    detailNodeId,
    setDetailNode,
    updateNodeData,
  } = useStore()
  const { screenToFlowPosition, fitView } = useReactFlow()
  const [inspector, setInspector] = useState(null) // null | 'rel' | 'data'
  const [filterType, setFilterType] = useState(null)
  const [editId, setEditId] = useState(null) // 全屏编辑弹窗
  const [confirmClear, setConfirmClear] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const linkFileRef = useRef(null)

  useEffect(() => {
    load()
  }, [load])

  const { rootOf, roots, membersOf } = useMemo(
    () => computeRoots(nodes, edges),
    [nodes, edges],
  )

  // 派生节点：筛选隐藏
  const dispNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        hidden: !!filterType && n.data.type !== filterType,
      })),
    [nodes, filterType],
  )

  // 派生边：跨想法高亮 + 筛选隐藏
  const dispEdges = useMemo(() => {
    const typeOf = (id) => nodes.find((n) => n.id === id)?.data.type
    return edges.map((e) => {
      const cross = rootOf[e.source] !== rootOf[e.target]
      const hidden =
        !!filterType &&
        (typeOf(e.source) !== filterType || typeOf(e.target) !== filterType)
      const style =
        inspector === 'rel'
          ? cross
            ? { stroke: '#d97706', strokeWidth: 2.5 }
            : { stroke: '#cbd5e1', strokeWidth: 1, opacity: 0.45 }
          : undefined
      return { ...e, hidden, style }
    })
  }, [edges, inspector, filterType, rootOf, nodes])

  const onAdd = (type) => {
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    // 对齐到 20px 网格，保证卡片整齐
    const gx = Math.round(center.x / 20) * 20
    const gy = Math.round(center.y / 20) * 20
    addNode(type, { x: gx, y: gy })
  }

  const onExport = () => {
    const { nodes, edges } = useStore.getState()
    const blob = new Blob([JSON.stringify({ nodes, edges }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'idea-canvas.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const onAddLink = () => {
    const url = linkUrl.trim()
    if (!url) return
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    const gx = Math.round(center.x / 20) * 20
    const gy = Math.round(center.y / 20) * 20
    const id = addNode('resource', { x: gx, y: gy }, {
      url,
      content: linkTitle.trim(),
    })
    // 尽力抓取网页标题作为说明（跨域多半失败，失败则保留用户填的标题）
    fetch(url)
      .then((r) => r.text())
      .then((html) => {
        const m = html.match(/<title>([\s\S]*?)<\/title>/i)
        if (m && m[1].trim() && !linkTitle.trim()) {
          updateNodeData(id, { content: m[1].trim() })
        }
      })
      .catch(() => {})
    setLinkOpen(false)
    setLinkUrl('')
    setLinkTitle('')
    setTimeout(
      () => fitView({ nodes: [{ id }], padding: 0.3, duration: 400 }),
      60,
    )
  }

  const focusNodes = (ids) => {
    const valid = ids.filter((id) => nodes.some((n) => n.id === id))
    if (!valid.length) return
    fitView({ nodes: valid.map((id) => ({ id })), padding: 0.3, duration: 500, maxZoom: 1.2 })
  }

  // 详情浮层
  const detailNode = detailNodeId
    ? nodes.find((n) => n.id === detailNodeId)
    : null
  const editNode = editId ? nodes.find((n) => n.id === editId) : null

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="toolbar">
        <span className="title">💡 想法画布</span>
        {NODE_TYPE_KEYS.map((k) => (
          <button
            key={k}
            onClick={() => onAdd(k)}
            style={{ borderColor: NODE_TYPES[k].color, color: NODE_TYPES[k].color }}
            title={NODE_TYPES[k].desc}
          >
            + {NODE_TYPES[k].label}
          </button>
        ))}
        <button onClick={() => setLinkOpen(true)} title="插入一个链接节点（资料类型）">
          🔗 链接
        </button>
        <span style={{ flex: 1 }} />
        <button
          className={inspector === 'rel' ? 'tb-active' : ''}
          onClick={() => setInspector((v) => (v === 'rel' ? null : 'rel'))}
        >
          关系图谱
        </button>
        <button
          className={inspector === 'data' ? 'tb-active' : ''}
          onClick={() => setInspector((v) => (v === 'data' ? null : 'data'))}
        >
          数据面板
        </button>
        <button onClick={onExport}>导出 JSON</button>
        <button className="tb-danger" onClick={() => setConfirmClear(true)}>
          清空
        </button>
        <span
          className="app-version"
          style={{ marginLeft: 6, fontSize: 11, color: '#94a3b8', alignSelf: 'center' }}
          title="当前版本"
        >
          v{import.meta.env.VITE_APP_VERSION}
        </span>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <ReactFlow
            nodes={dispNodes}
            edges={dispEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNode(node.id)}
            onPaneClick={() => {
              setSelectedNode(null)
              setDetailNode(null)
            }}
            nodeTypes={nodeTypes}
            fitView
            snapToGrid
            snapGrid={[20, 20]}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>

          {inspector && (
            <Inspector
              tab={inspector}
              onTab={setInspector}
              onClose={() => setInspector(null)}
              nodes={nodes}
              edges={edges}
              rootOf={rootOf}
              roots={roots}
              membersOf={membersOf}
              filterType={filterType}
              onFilter={(t) => setFilterType(t)}
              onClearFilter={() => setFilterType(null)}
              onFocus={focusNodes}
            />
          )}
        </div>
        <AIPanel />
      </div>

      {detailNode && (
        <DetailPopover
          node={detailNode}
          updateNodeData={updateNodeData}
          onClose={() => setDetailNode(null)}
          onEdit={() => {
            setEditId(detailNode.id)
            setDetailNode(null)
          }}
        />
      )}

      {editNode && (
        <div className="modal-mask" onClick={() => setEditId(null)}>
          <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="detail-head">
              <select
                value={editNode.data.type}
                onChange={(e) =>
                  updateNodeData(editNode.id, { type: e.target.value })
                }
              >
                {NODE_TYPE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {NODE_TYPES[k].label}
                  </option>
                ))}
              </select>
              <span
                className={`read-badge ${editNode.data.read === true ? 'read' : 'unread'}`}
                onClick={() =>
                  updateNodeData(editNode.id, {
                    read: editNode.data.read !== true,
                  })
                }
              >
                {editNode.data.read === true ? '✓ 已读' : '● 未读'}
              </span>
              <button
                className="dm-img-btn"
                title="插入图片"
                onClick={() => linkFileRef.current?.click()}
              >
                🖼 插图
              </button>
              <button className="report-close" onClick={() => setEditId(null)}>
                关闭
              </button>
            </div>
            <div className="dm-url-row">
              <input
                className="dm-url"
                placeholder="链接 URL（可选，如 https://...）"
                value={editNode.data.url || ''}
                onChange={(e) =>
                  updateNodeData(editNode.id, { url: e.target.value })
                }
              />
            </div>
            {editNode.data.image && (
              <div className="dm-image-wrap">
                <img className="dm-image" src={editNode.data.image} alt="" />
                <button
                  className="dm-img-del"
                  onClick={() => updateNodeData(editNode.id, { image: '' })}
                >
                  移除图片
                </button>
              </div>
            )}
            <textarea
              className="detail-edit"
              value={editNode.data.content || ''}
              onChange={(e) =>
                updateNodeData(editNode.id, { content: e.target.value })
              }
            />
            <div className="detail-foot">
              改动自动保存到本机。
            </div>
            <input
              ref={linkFileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const r = new FileReader()
                r.onload = () =>
                  updateNodeData(editNode.id, { image: r.result })
                r.readAsDataURL(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>
      )}

      {confirmClear && (
        <div className="modal-mask" onClick={() => setConfirmClear(false)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <p>清空画布？此操作不可撤销，所有卡片与连线将被删除。</p>
            <div className="confirm-actions">
              <button
                className="danger"
                onClick={() => {
                  clear()
                  setFilterType(null)
                  setConfirmClear(false)
                }}
              >
                确认清空
              </button>
              <button onClick={() => setConfirmClear(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {linkOpen && (
        <div className="modal-mask" onClick={() => setLinkOpen(false)}>
          <div className="link-modal" onClick={(e) => e.stopPropagation()}>
            <div className="link-head">🔗 插入链接</div>
            <label className="link-field">
              链接地址
              <input
                className="link-input"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://..."
                autoFocus
              />
            </label>
            <label className="link-field">
              标题 / 说明（可选）
              <input
                className="link-input"
                value={linkTitle}
                onChange={(e) => setLinkTitle(e.target.value)}
                placeholder="这张卡片要记的链接是什么"
              />
            </label>
            <div className="link-tip">
              将创建一个「资料」节点，点击卡片上的 🔗 可在新标签打开。系统会尝试抓取网页标题作为说明（跨域可能失败，失败则只用你填的标题）。
            </div>
            <div className="confirm-actions">
              <button className="primary" onClick={onAddLink}>
                创建链接节点
              </button>
              <button
                onClick={() => {
                  setLinkOpen(false)
                  setLinkUrl('')
                  setLinkTitle('')
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 点击卡片名称后弹出的小窗：展示该卡片的详细说明，锚定在卡片右侧
function DetailPopover({ node, updateNodeData, onClose, onEdit }) {
  const cfg = NODE_TYPES[node.data.type] || NODE_TYPES.idea
  const read = node.data.read === true
  const firstLine = (node.data.content || '').split('\n')[0] || '（未命名）'

  // 用节点 DOM 的屏幕位置锚定弹窗
  const pos = (() => {
    const el = document.querySelector(`[data-id="${node.id}"]`)
    if (!el) return { left: 80, top: 80 }
    const r = el.getBoundingClientRect()
    const left = Math.min(r.right + 12, window.innerWidth - 320)
    const top = Math.min(Math.max(r.top, 12), window.innerHeight - 220)
    return { left, top }
  })()

  return createPortal(
    <div className="detail-popover" style={pos} onClick={(e) => e.stopPropagation()}>
      <div className="dp-head">
        <span className="dp-type" style={{ color: cfg.color }}>
          {cfg.label}
        </span>
        <span
          className={`read-badge ${read ? 'read' : 'unread'}`}
          title={read ? '已读' : '未读'}
          onClick={() => updateNodeData(node.id, { read: !read })}
        >
          {read ? '✓ 已读' : '● 未读'}
        </span>
        <button className="dp-close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="dp-title">{firstLine}</div>
      <div className="dp-body">{node.data.content || '（暂无内容，双击卡片可编辑）'}</div>
      {node.data.image && (
        <img className="dp-image" src={node.data.image} alt="" />
      )}
      <div className="dp-foot">
        <button className="dp-edit" onClick={onEdit}>
          展开编辑
        </button>
      </div>
    </div>,
    document.body,
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
