import { useEffect, useMemo, useState, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { toPng } from 'html-to-image'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Controls,
  useReactFlow,
  SelectionMode,
  getNodesBounds,
  getViewportForBounds,
} from '@xyflow/react'
import { useStore } from './store'
import { NODE_TYPES, NODE_TYPE_KEYS } from './nodeTypes'
import CustomNode from './CustomNode'
import Markdown from './Markdown'
import AIPanel from './AIPanel'
import Inspector from './Inspector'
import { loadSettings, saveChat } from './settings'
import { DEFAULT_SETTINGS } from './ai'

const nodeTypes = { custom: CustomNode }

// 固定引用，避免 React Flow 因 prop 对象变化反复重置内部边状态
const DEFAULT_EDGE_OPTIONS = { type: 'default' }

// 计算想法根：从连线做无向连通分量，每个分量选一个"想法根"
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
    nodes, edges, onNodesChange, onEdgesChange, onConnect,
    addNode, clear, load, setSelectedNode, detailNodeId,
    setDetailNode, updateNodeData, selectedNodeId, collapsed,
    selectionMode, setSelectionMode, setSelectedNodeIds,
    undo, redo, saveStatus, past, future,
  } = useStore()
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, setCenter } = useReactFlow()
  const [inspector, setInspector] = useState(null)
  const [filterType, setFilterType] = useState(null)
  const [editId, setEditId] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')

  // 全局撤销/重做快捷键（输入框内不拦截，保留原生文本撤销）
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // 保存状态指示器：仅「保存中/已保存」时短暂显示于画布正上方，不常驻
  const [saveVisible, setSaveVisible] = useState(false)
  useEffect(() => {
    if (saveStatus === 'saving') { setSaveVisible(true); return }
    if (saveStatus === 'saved') {
      setSaveVisible(true)
      const t = setTimeout(() => setSaveVisible(false), 1800)
      return () => clearTimeout(t)
    }
    setSaveVisible(false)
  }, [saveStatus])
  const linkFileRef = useRef(null)
  const canvasRef = useRef(null)
  const exportRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  // 导出下拉 / PNG 预览
  const [exportOpen, setExportOpen] = useState(false)
  const [pngPreview, setPngPreview] = useState(null)
  const [capturing, setCapturing] = useState(false)

  // 节点搜索
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchIdx, setSearchIdx] = useState(0)
  // 全局状态提示条（2s 自动消失）
  const [statusToast, setStatusToast] = useState(null)
  useEffect(() => {
    if (!statusToast) return
    const t = setTimeout(() => setStatusToast(null), 2000)
    return () => clearTimeout(t)
  }, [statusToast])

  // 欢迎引导弹窗
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  useEffect(() => {
    const seen = localStorage.getItem('lapop-welcome-seen')
    if (!seen) {
      setWelcomeOpen(true)
      localStorage.setItem('lapop-welcome-seen', '1')
    }
  }, [])

  // 底栏输入状态（与 AIPanel 共享）
  const [input, setInput] = useState('')
  const aiPanelRef = useRef(null)

  // 可拖分割线 — 画布占 55%，聊天区占 45%
  const [splitPct, setSplitPct] = useState(45)
  const draggingDivider = useRef(false)
  const startDragDivider = useCallback((e) => {
    e.preventDefault()
    draggingDivider.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])
  useEffect(() => {
    const onMove = (e) => {
      if (!draggingDivider.current) return
      const pct = (e.clientX / window.innerWidth) * 100
      setSplitPct(Math.max(30, Math.min(65, pct)))
    }
    const onUp = () => {
      if (!draggingDivider.current) return
      draggingDivider.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 启动加载：开发/演示模式（resetOnStart）下每次清空画布与对话，恢复初始界面；
  // 正式投用时在「设置」关闭该开关，即恢复「保留上次信息」的行为。
  useEffect(() => {
    (async () => {
      const s = await loadSettings()
      const eff = { ...DEFAULT_SETTINGS, ...(s || {}) }
      if (eff.resetOnStart) {
        useStore.getState().resetToInitial()
        await saveChat({ messages: [], threads: {} })
        localStorage.removeItem('lapop-welcome-seen')
        setWelcomeOpen(true)
      } else {
        await useStore.getState().load()
      }
    })()
  }, [])

  // 导出下拉：点击外部关闭
  useEffect(() => {
    if (!exportOpen) return
    const onDoc = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [exportOpen])

  const { rootOf, roots, membersOf } = useMemo(() => computeRoots(nodes, edges), [nodes, edges])

  // 选中节点的「整条链路」：自身 + 所有祖先（向上）+ 所有后代（向下），双向高亮
  const chainSet = useMemo(() => {
    const set = new Set()
    if (!selectedNodeId) return set
    // 向上：沿 source→target 回溯到根
    const parentOf = new Map()
    edges.forEach((e) => {
      if (!parentOf.has(e.target)) parentOf.set(e.target, e.source)
    })
    let cur = selectedNodeId
    while (cur) {
      if (set.has(cur)) break
      set.add(cur)
      cur = parentOf.get(cur)
    }
    // 向下：沿 target 遍历所有后代
    const childrenOf = new Map()
    edges.forEach((e) => {
      if (!childrenOf.has(e.source)) childrenOf.set(e.source, [])
      childrenOf.get(e.source).push(e.target)
    })
    const stack = [selectedNodeId]
    while (stack.length) {
      const c = stack.pop()
      ;(childrenOf.get(c) || []).forEach((t) => {
        if (!set.has(t)) {
          set.add(t)
          stack.push(t)
        }
      })
    }
    return set
  }, [selectedNodeId, edges])

  const dispNodes = useMemo(
    () =>
      nodes.map((n) => {
        const inChain = chainSet.has(n.id)
        const cls = inChain
          ? n.id === selectedNodeId
            ? 'chain-hl chain-sel'
            : 'chain-hl'
          : chainSet.size > 1
            ? 'chain-dim'
            : ''
        return { ...n, hidden: !!filterType && n.data.type !== filterType, className: cls }
      }),
    [nodes, filterType, chainSet, selectedNodeId],
  )

  const dispEdges = useMemo(() => {
    const typeOf = (id) => nodes.find((n) => n.id === id)?.data.type
    return edges.map((e) => {
      const cross = rootOf.get(e.source) !== rootOf.get(e.target)
      const hidden = !!filterType && (typeOf(e.source) !== filterType || typeOf(e.target) !== filterType)
      const inChain = chainSet.size > 1 && chainSet.has(e.source) && chainSet.has(e.target)
      let cls = ''
      if (inChain) cls = 'chain-edge'
      else if (inspector === 'rel') cls = cross ? 'rel-cross' : 'rel-plain'
      return { ...e, hidden, className: cls || undefined }
    })
  }, [edges, inspector, filterType, rootOf, nodes, chainSet])

  const onAdd = (type) => {
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    addNode(type, { x: Math.round(center.x / 20) * 20, y: Math.round(center.y / 20) * 20 })
  }

  const onExport = () => {
    const { nodes: nn, edges: ee } = useStore.getState()
    const blob = new Blob([JSON.stringify({ nodes: nn, edges: ee }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'lapop.json'; a.click(); URL.revokeObjectURL(url)
  }

  // 导出 MD：先生成报告（调 AIPanel 的 report，弹出预览），用户确认后再在预览里下载
  const onExportMd = () => {
    setExportOpen(false)
    aiPanelRef.current?.report()
  }

  // 导出 PNG：截图画布 viewport（含连线），预览后下载
  const onExportPng = async () => {
    setExportOpen(false)
    const rfNodes = useStore.getState().nodes
    if (!rfNodes.length) {
      alert('画布为空，暂无可导出的内容。')
      return
    }
    const viewport = document.querySelector('.react-flow__viewport')
    if (!viewport) return
    setCapturing(true)
    // 等一帧，确保隐藏项生效
    await new Promise((r) => setTimeout(r, 60))
    // html-to-image 1.11.x 回归：克隆时不会把连线描边的 CSS 内联进导出图，
    // 导致连线在 PNG 里整条消失（屏幕端正常）。导出前把每条连线（含文字）的描边/填充以
    // "计算值"写入内联 style，确保被捕获；finally 中还原，不影响屏幕端样式。
    const rfEl = document.querySelector('.react-flow')
    const edgeEls = rfEl
      ? Array.from(rfEl.querySelectorAll('.react-flow__edge-path, .react-flow__edge-textbg, .react-flow__edge-text'))
      : []
    const savedStyles = edgeEls.map((el) => el.getAttribute('style'))
    try {
      const bounds = getNodesBounds(rfNodes)
      const margin = 80
      const width = Math.ceil(bounds.width + margin * 2)
      const height = Math.ceil(bounds.height + margin * 2)
      const transform = getViewportForBounds(bounds, width, height, 0.2, 2, 0.1)
      edgeEls.forEach((el) => {
        const cs = getComputedStyle(el)
        el.style.stroke = cs.stroke
        el.style.strokeWidth = cs.strokeWidth
        el.style.fill = cs.fill
      })
      const dataUrl = await toPng(viewport, {
        backgroundColor: '#F5F1E8',
        width,
        height,
        pixelRatio: 2,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
        },
        filter: (node) =>
          !(node.classList?.contains('react-flow__minimap') ||
            node.classList?.contains('react-flow__controls') ||
            node.classList?.contains('react-flow__panel') ||
            node.classList?.contains('canvas-toolbar')),
      })
      setPngPreview(dataUrl)
    } catch (e) {
      console.warn('PNG 导出失败', e)
      alert('导出 PNG 失败：' + (e?.message || e))
    } finally {
      edgeEls.forEach((el, i) => {
        const s = savedStyles?.[i]
        if (s === null) el.removeAttribute('style')
        else if (s !== undefined) el.setAttribute('style', s)
      })
      setCapturing(false)
    }
  }

  const downloadPng = () => {
    if (!pngPreview) return
    const a = document.createElement('a')
    a.href = pngPreview
    a.download = 'lapop.png'
    a.click()
  }

  const onAddLink = () => {
    const url = linkUrl.trim(); if (!url) return
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const id = addNode('resource', { x: Math.round(center.x / 20) * 20, y: Math.round(center.y / 20) * 20 }, { url, content: linkTitle.trim() })
    fetch(url).then(r => r.text()).then(html => {
      const m = html.match(/<title>([\s\S]*?)<\/title>/i)
      if (m?.[1]?.trim() && !linkTitle.trim()) updateNodeData(id, { content: m[1].trim() })
    }).catch(() => {})
    setLinkOpen(false); setLinkUrl(''); setLinkTitle('')
    setTimeout(() => fitView({ nodes: [{ id }], padding: 0.3, duration: 400 }), 60)
  }

  const focusNodes = (ids) => {
    const valid = ids.filter(id => nodes.some(n => n.id === id))
    if (!valid.length) return
    fitView({ nodes: valid.map(id => ({ id })), padding: 0.3, duration: 500, maxZoom: 1.2 })
  }

  const toggleFullscreen = () => {
    const el = canvasRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.()
  }

  const detailNode = detailNodeId ? nodes.find(n => n.id === detailNodeId) : null
  const editNode = editId ? nodes.find(n => n.id === editId) : null

  const toggleRelGraph = useCallback(() => setInspector(v => v === 'rel' ? null : 'rel'), [])

  // 固定 React Flow 事件回调引用，避免每次渲染重新订阅导致
  // onSelectionChange 在订阅瞬间被触发 → setSelectedNodeIds → 重渲染 → 再订阅 的无限循环
  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node.id)
    aiPanelRef.current?.scrollToType?.(node.data?.type)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
    setDetailNode(null)
  }, [])

  const onSelectionChange = useCallback(({ nodes: selNodes }) => {
    setSelectedNodeIds(selNodes.map((n) => n.id))
  }, [])

  const onDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback((e) => {
    if (e.currentTarget === e.target) setDragOver(false)
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/lapop-para')
    if (!raw) return
    try {
      const { text, type } = JSON.parse(raw)
      if (!text) return
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      addNode(type || 'resource', pos, { content: text })
      setStatusToast('POP！已落图一段回答')
    } catch (_) { /* 非段落拖拽载荷，忽略 */ }
  }, [])

  // 底栏操作：发送 / 拆解落图 / 优化 / 关联 / 报告 → 委托给 AIPanel
  const handleSend = () => aiPanelRef.current?.send()
  const handleDecompose = () => aiPanelRef.current?.decompose()
  const handleOptimize = () => aiPanelRef.current?.optimize()
  const handleRelate = () => aiPanelRef.current?.relate()
  const handleReport = () => aiPanelRef.current?.report()

  // 节点搜索：跳转到指定节点并选中
  const gotoNode = useCallback((node) => {
    const w = 210, h = 96
    setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1.2, duration: 400 })
    setSelectedNode(node.id)
    setSearchOpen(false)
    setSearch('')
  }, [setCenter, setSelectedNode])

  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return nodes
      .filter((n) => (n.data?.content || '').toLowerCase().includes(q))
      .slice(0, 50)
  }, [search, nodes])

  const onSearchKey = (e) => {
    if (!searchHits.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIdx((i) => Math.min(i + 1, searchHits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIdx((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const hit = searchHits[searchIdx]; if (hit) gotoNode(hit) }
    else if (e.key === 'Escape') { setSearchOpen(false); setSearch('') }
  }

  // 底栏键盘事件：Enter 发送，Shift+Enter 换行
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--cream)' }}>
      {/* ===== 顶部工具栏：LAPOP 品牌 + 功能胶囊 ===== */}
      <div className="toolbar">
        <div className="brand-area">
          <div className="brand-brain" onClick={toggleRelGraph} title="点击查看关系图谱">
            <img src={import.meta.env.BASE_URL + 'lapop-logo.png'} alt="LAPOP" />
          </div>
          <div className="brand-text">
            <span className="brand-lapop">LAPOP</span>
            <span className="brand-tagline">THINK WITH ME</span>
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="tb-btn tb-dark" onClick={() => aiPanelRef.current?.showImport()}>导入</button>
        <div className="export-wrap" ref={exportRef}>
          <button className="tb-btn tb-pink" onClick={() => setExportOpen(v => !v)}>导出 ▾</button>
          {exportOpen && (
            <div className="export-menu">
              <button onClick={() => { setExportOpen(false); onExport() }}>JSON（直接下载）</button>
              <button onClick={onExportMd}>Markdown（生成报告后下载）</button>
              <button onClick={onExportPng} disabled={capturing}>{capturing ? '截图预览中…' : 'PNG（生成预览后下载）'}</button>
            </div>
          )}
        </div>
        <button className="tb-btn tb-dark" onClick={() => aiPanelRef.current?.toggleSettings()}>设置</button>
        <span
          className="tb-version"
          role="button"
          tabIndex={0}
          title="查看新手引导 · 点击重温"
          onClick={() => setWelcomeOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setWelcomeOpen(true) }}
        >v{import.meta.env.VITE_APP_VERSION}</span>
      </div>

      {/* ===== 主体：左AI(~55%) + 分割线 + 右画布(~45%) ===== */}
      <div className="app-body">
        {/* 左侧 AI 聊天面板（输入已移到底栏） */}
        <AIPanel ref={aiPanelRef} splitPct={splitPct} externalInput={{ value: input, onChange: setInput }} onStatus={setStatusToast} />

        {/* AI 面板收起时：画布左边缘显示展开条 */}
        {collapsed && (
          <div className="ai-expand-tab" onClick={() => useStore.getState().setCollapsed(false)} title="展开 AI 聊天框">
            <span className="ai-expand-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>
            </span>
            <span className="ai-expand-text">AI</span>
          </div>
        )}

        {/* 可拖分割线 */}
        {!collapsed && <div className="divider" onMouseDown={startDragDivider} />}

        {/* 右侧画布区域（支持从对话段落拖拽落图 + 框选模式） */}
        <div
          className={`canvas-area mode-${selectionMode}${dragOver ? ' drag-over' : ''}`}
          ref={canvasRef}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={dispNodes}
            edges={dispEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            maxZoom={2.5}
            snapToGrid snapGrid={[20, 20]}
            zoomOnDoubleClick={false}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            proOptions={{ hideAttribution: true }}
            selectionMode={SelectionMode.Full}
            selectionOnDrag={selectionMode === 'select'}
            panOnDrag={selectionMode === 'select' ? [1, 2] : true}
            onSelectionChange={onSelectionChange}
          >
            <Background gap={30} color="#e5e5e5" size={1.5} />
            <MiniMap pannable zoomable nodeColor={(n) => NODE_TYPES[n.data?.type || 'idea']?.color || '#FF2E92'} maskColor="rgba(0,0,0,0.7)" />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>

          {/* 画布空状态：品牌视觉锤 */}
          {nodes.length === 0 && (
            <div className="canvas-empty">
              <div className="canvas-empty-logo">POP</div>
              <div className="canvas-empty-tagline">THINK WITH ME</div>
              <div className="canvas-empty-hint">&gt; LA个想法进来，POP一下拆解成图</div>
              <div className="canvas-empty-brain">
                <img src={import.meta.env.BASE_URL + 'stand-mascot.gif'} alt="POP Brain" />
              </div>
            </div>
          )}

          {/* 全局状态提示条 */}
          {statusToast && (
            <div className="status-toast">
              <span className="status-cursor">&gt; {statusToast}</span>
            </div>
          )}

          {/* 保存状态指示器：仅保存后短暂显示于画布正上方 */}
          {saveVisible && (
            <div className="save-indicator">{saveStatus === 'saving' ? '保存中…' : '已保存'}</div>
          )}

          {/* 右下角控件：撤销/重做 + 缩放 + 模式切换 */}
          <div className="canvas-toolbar">
            <div className="canvas-controls">
              <button onClick={undo} disabled={past.length === 0} title="撤销 (Ctrl+Z)">↶</button>
              <button onClick={redo} disabled={future.length === 0} title="重做 (Ctrl+Shift+Z)">↷</button>
              <button onClick={toggleFullscreen} title="全屏">⛶</button>
              <button onClick={() => zoomIn({ duration: 200 })} title="放大">＋</button>
              <button onClick={() => zoomOut({ duration: 200 })} title="缩小">－</button>
              <button onClick={() => fitView({ duration: 300 })} title="适应画布">⊙</button>
              <button
                className={`ctrl-mode${selectionMode === 'select' ? ' is-select' : ''}`}
                onClick={() => setSelectionMode(selectionMode === 'select' ? 'pan' : 'select')}
                title={selectionMode === 'select' ? '当前：框选模式 — 点击切回平移' : '当前：平移模式 — 点击切换到框选'}
              >
                {selectionMode === 'select' ? '▢' : '✋'}
              </button>
            </div>
          </div>

          {/* 节点搜索：画布内、缩略图左侧；全屏时亦可搜索 */}
          <div className="canvas-search">
            <input
              className="search-input"
              value={search}
              placeholder="搜索节点…"
              aria-label="搜索节点"
              onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); setSearchIdx(0) }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={onSearchKey}
            />
            {searchOpen && search && (
              <div className="search-drop">
                {searchHits.length === 0 && <div className="search-empty">无匹配节点</div>}
                {searchHits.map((n, i) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`search-item${i === searchIdx ? ' active' : ''}`}
                    onMouseEnter={() => setSearchIdx(i)}
                    onClick={() => gotoNode(n)}
                  >
                    <span className="search-dot" style={{ background: NODE_TYPES[n.data?.type || 'idea']?.color }} />
                    <span className="search-text">{(n.data?.content || '').split('\n')[0] || '(空卡片)'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 检视面板 */}
          {inspector && (
            <Inspector
              tab={inspector} onTab={setInspector} onClose={() => setInspector(null)}
              nodes={nodes} edges={edges} rootOf={rootOf} roots={roots} membersOf={membersOf}
              filterType={filterType} onFilter={(t) => setFilterType(t)} onClearFilter={() => setFilterType(null)}
              onFocus={focusNodes}
            />
          )}
        </div>
      </div>

      {/* ===== 底部输入栏（独立全宽，60px 纯黑）===== */}
      <div className="bottom-bar">
        <textarea
          className="bottom-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入想法，或继续和 AI 讨论…（Enter 发送，Shift+Enter 换行）"
          rows={1}
        />
        <button className="bottom-btn primary" onClick={handleSend}>发 送</button>
        <button className="bottom-btn decompose" onClick={handleDecompose}>拆解落图</button>
        <button className="bottom-btn optimize" onClick={handleOptimize}>优化画布</button>
      </div>

      {/* 详情浮层 */}
      {detailNode && createPortal(
        <DetailPopover node={detailNode} updateNodeData={updateNodeData} onClose={() => setDetailNode(null)}
          onEdit={() => { setEditId(detailNode.id); setDetailNode(null) }} />,
        document.body,
      )}

      {/* 全屏编辑弹窗（可拖拽 + 可缩放） */}
      {editNode && (
        <div className="modal-mask" onClick={() => setEditId(null)}>
          <DetailModal node={editNode} updateNodeData={updateNodeData} onClose={() => setEditId(null)} linkFileRef={linkFileRef} />
        </div>
      )}

      {/* 清空确认 */}
      {confirmClear && (
        <div className="modal-mask" onClick={() => setConfirmClear(false)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <p>清空画布？此操作不可撤销，所有卡片与连线将被删除。</p>
            <div className="confirm-actions">
              <button className="danger" onClick={() => { clear(); setFilterType(null); setConfirmClear(false) }}>确认清空</button>
              <button onClick={() => setConfirmClear(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 链接弹窗 */}
      {linkOpen && (
        <div className="modal-mask" onClick={() => { setLinkOpen(false); setLinkUrl(''); setLinkTitle('') }}>
          <div className="link-modal" onClick={(e) => e.stopPropagation()}>
            <div className="link-head">🔗 插入链接</div>
            <label className="link-field">链接地址
              <input className="link-input" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://..." autoFocus />
            </label>
            <label className="link-field">标题 / 说明（可选）
              <input className="link-input" value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} placeholder="这张卡片要记的链接是什么" />
            </label>
            <div className="link-tip">将创建一个「资料」节点，点击卡片上的 🔗 可在新标签打开。系统会尝试抓取网页标题作为说明。</div>
            <div className="confirm-actions">
              <button className="primary" style={{ background: '#FF2E92', color: '#fff', border: 'none' }} onClick={onAddLink}>创建链接节点</button>
              <button onClick={() => { setLinkOpen(false); setLinkUrl(''); setLinkTitle('') }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* PNG 导出预览 */}
      {pngPreview && (
        <div className="modal-mask" onClick={() => setPngPreview(null)}>
          <div className="png-modal" onClick={(e) => e.stopPropagation()}>
            <div className="png-head">
              <span>🖼 画布预览（PNG）</span>
              <div className="report-actions">
                <button onClick={downloadPng}>下载 PNG</button>
                <button className="report-close" onClick={() => setPngPreview(null)}>关闭</button>
              </div>
            </div>
            <div className="png-body">
              <img src={pngPreview} alt="画布预览" />
            </div>
            <div className="png-tip">确认无误后点「下载 PNG」。如不满意可关闭后调整画布再导出。</div>
          </div>
        </div>
      )}

      {/* 欢迎引导弹窗 */}
      {welcomeOpen && (
        <div className="modal-mask" onClick={() => setWelcomeOpen(false)}>
          <div className="welcome-modal" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-deco welcome-deco--tl"></div>
            <div className="welcome-deco welcome-deco--tr"></div>
            <div className="welcome-deco welcome-deco--bl"></div>
            <div className="welcome-mascot">
              <img src={import.meta.env.BASE_URL + 'walk-mascot.gif'} alt="LAPOP Brain" />
            </div>
            <div className="welcome-logo">LAPOP</div>
            <div className="welcome-tagline">THINK WITH ME</div>
            <p className="welcome-desc">把想法丢进来，AI 帮你拆解成可视化思维图谱</p>
            <div className="welcome-steps">
              <div className="welcome-step"><span className="ws-num">1</span><span>想法拆解成图</span></div>
              <div className="welcome-step"><span className="ws-num">2</span><span>卡片下钻深挖</span></div>
              <div className="welcome-step"><span className="ws-num">3</span><span>智能关联与优化</span></div>
              <div className="welcome-step"><span className="ws-num">4</span><span>导入与沉淀</span></div>
            </div>
            <button className="welcome-start" onClick={() => setWelcomeOpen(false)}>知道了，开始用</button>
          </div>
        </div>
      )}

    </div>
  )
}

// 详情编辑弹窗（可拖拽 + 可缩放）
function DetailModal({ node, updateNodeData, onClose, linkFileRef }) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(40, (window.innerWidth - 560) / 2),
    y: Math.max(40, (window.innerHeight - 500) / 2),
  }))
  const [size, setSize] = useState({ w: 540, h: 'auto' })
  const dragRef = useRef(null)
  const resizeRef = useRef(null)

  const onMouseDownDrag = (e) => {
    if (e.target.closest('button, select, input, textarea')) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    document.addEventListener('mousemove', onMoveDrag)
    document.addEventListener('mouseup', onUpDrag)
  }
  const onMoveDrag = (e) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setPos({
      x: Math.max(0, Math.min(dragRef.current.origX + dx, window.innerWidth - 260)),
      y: Math.max(0, Math.min(dragRef.current.origY + dy, window.innerHeight - 150)),
    })
  }
  const onUpDrag = () => { dragRef.current = null; document.removeEventListener('mousemove', onMoveDrag); document.removeEventListener('mouseup', onUpDrag) }

  const onMouseDownResize = (e) => { e.preventDefault(); e.stopPropagation(); resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h }; document.addEventListener('mousemove', onMoveResize); document.addEventListener('mouseup', onUpResize) }
  const onMoveResize = (e) => { if (!resizeRef.current) return; setSize({ w: Math.max(360, resizeRef.current.origW + e.clientX - resizeRef.current.startX), h: Math.max(250, (resizeRef.current.origH === 'auto' ? 420 : resizeRef.current.origH) + e.clientY - resizeRef.current.startY) }) }
  const onUpResize = () => { resizeRef.current = null; document.removeEventListener('mousemove', onMoveResize); document.removeEventListener('mouseup', onUpResize) }

  useEffect(() => () => { onUpDrag(); onUpResize() }, [])

  return (
    <div className="detail-modal draggable-window" style={{ left: pos.x, top: pos.y, width: size.w }} onClick={(e) => e.stopPropagation()}>
      <div className="detail-head" onMouseDown={onMouseDownDrag} style={{ cursor: 'move' }}>
        <select value={node.data.type} onChange={(e) => updateNodeData(node.id, { type: e.target.value })}>
          {NODE_TYPE_KEYS.map(k => <option key={k} value={k}>{NODE_TYPES[k].label}</option>)}
        </select>
        <span className={`read-badge ${node.data.read === true ? 'read' : 'unread'}`}
          onClick={() => updateNodeData(node.id, { read: node.data.read !== true })}>
          {node.data.read === true ? '✓ 已读' : '● 未读'}
        </span>
        <button className="dm-img-btn" onClick={() => linkFileRef.current?.click()}>🖼 插图</button>
        <button className="report-close" onClick={onClose}>关闭</button>
      </div>
      <div className="dm-url-row">
        <input className="dm-url" placeholder="链接 URL（可选）" value={node.data.url || ''}
          onChange={(e) => updateNodeData(node.id, { url: e.target.value })} />
      </div>
      {node.data.image && (
        <div className="dm-image-wrap">
          <img className="dm-image" src={node.data.image} alt="" />
          <button className="dm-img-del" onClick={() => updateNodeData(node.id, { image: '' })}>移除图片</button>
        </div>
      )}
      <textarea className="detail-edit" value={node.data.content || ''}
        onChange={(e) => updateNodeData(node.id, { content: e.target.value })} />
      <div className="detail-foot">
        <span>改动自动保存到本机。</span>
        <span className="dp-drag-hint">↔ 拖拽标题栏移动 · 拖拽右下角缩放</span>
      </div>
      <input ref={linkFileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return
          const r = new FileReader()
          r.onload = () => updateNodeData(node.id, { image: r.result })
          r.readAsDataURL(f); e.target.value = ''
        }} />
      {/* 缩放手柄 */}
      <div className="resize-handle" onMouseDown={onMouseDownResize} />
    </div>
  )
}

// 详情小窗
function DetailPopover({ node, updateNodeData, onClose, onEdit }) {
  const cfg = NODE_TYPES[node.data.type] || NODE_TYPES.idea
  const read = node.data.read === true
  const firstLine = (node.data.content || '').split('\n')[0] || '（未命名）'
  const dpLong = (node.data.content || '').length > 400
  const [dpExpanded, setDpExpanded] = useState(false)

  // 拖拽 + 缩放状态
  const [pos, setPos] = useState(() => {
    const el = document.querySelector(`[data-id="${node.id}"]`)
    if (!el) return { x: 80, y: 80 }
    const r = el.getBoundingClientRect()
    const POP_W = 320
    const POP_H = 260
    // 优先放右侧；右侧放不下就放左侧（贴着卡片）
    const x = r.right + 12 + POP_W <= window.innerWidth
      ? r.right + 12
      : Math.max(12, r.left - 12 - POP_W)
    // 垂直尽量对齐卡片，避免飞太远
    const y = Math.min(Math.max(r.top, 12), Math.max(12, window.innerHeight - POP_H))
    return { x, y }
  })
  const [size, setSize] = useState({ w: 310, h: 'auto' })
  const dragRef = useRef(null)   // { startX, startY, origX, origY }
  const resizeRef = useRef(null) // { startX, startY, origW, origH }

  const onMouseDownDrag = (e) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    document.addEventListener('mousemove', onMoveDrag)
    document.addEventListener('mouseup', onUpDrag)
  }
  const onMoveDrag = (e) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setPos({
      x: Math.max(0, Math.min(dragRef.current.origX + dx, window.innerWidth - 200)),
      y: Math.max(0, Math.min(dragRef.current.origY + dy, window.innerHeight - 100)),
    })
  }
  const onUpDrag = () => {
    dragRef.current = null
    document.removeEventListener('mousemove', onMoveDrag)
    document.removeEventListener('mouseup', onUpDrag)
  }

  const onMouseDownResize = (e) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h }
    document.addEventListener('mousemove', onMoveResize)
    document.addEventListener('mouseup', onUpResize)
  }
  const onMoveResize = (e) => {
    if (!resizeRef.current) return
    const dx = e.clientX - resizeRef.current.startX
    const dy = e.clientY - resizeRef.current.startY
    const newW = Math.max(260, resizeRef.current.origW + dx)
    const newH = size.h === 'auto' ? 'auto' : Math.max(180, resizeRef.current.origH + dy)
    setSize({ w: newW, h: newH })
  }
  const onUpResize = () => {
    resizeRef.current = null
    document.removeEventListener('mousemove', onMoveResize)
    document.removeEventListener('mouseup', onUpResize)
  }

  // 清理事件监听
  useEffect(() => () => { onUpDrag(); onUpResize() }, [])

  return createPortal(
    <div className="detail-popover pop-in draggable-window" style={{ left: pos.x, top: pos.y, width: size.w }} onClick={(e) => e.stopPropagation()}>
      <div className="dp-head" onMouseDown={onMouseDownDrag} style={{ cursor: 'move' }}>
        <span className="dp-type">{cfg.label}</span>
        <span className={`read-badge ${read ? 'read' : 'unread'}`} onClick={() => updateNodeData(node.id, { read: !read })}>
          {read ? '✓ 已读' : '● 未读'}
        </span>
        <button className="dp-close" onClick={onClose}>×</button>
      </div>
      <div className="dp-title">{firstLine}</div>
      <div className={`dp-body${dpLong && !dpExpanded ? ' clamp' : ''}`}>
        <Markdown>{node.data.content || '（暂无内容，双击卡片可编辑）'}</Markdown>
      </div>
      {dpLong && (
        <button className="dp-fold" onClick={() => setDpExpanded((v) => !v)}>
          {dpExpanded ? '收起 ▲' : '展开全文 ▼'}
        </button>
      )}
      {node.data.image && <img className="dp-image" src={node.data.image} alt="" />}
      <div className="dp-foot">
        <button className="dp-edit" onClick={onEdit}>展开编辑</button>
        <span className="dp-drag-hint">↔ 拖拽标题栏移动 · 拖拽右下角缩放</span>
      </div>
      {/* 右下角缩放手柄 */}
      <div className="resize-handle" onMouseDown={onMouseDownResize} />
    </div>,
    document.body,
  )
}

export default function App() {
  return <ReactFlowProvider><Canvas /></ReactFlowProvider>
}
