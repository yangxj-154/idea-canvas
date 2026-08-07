import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow } from '@xyflow/react'
import { nanoid } from 'nanoid'
import dagre from 'dagre'
import { useStore } from './store'
import { NODE_TYPES } from './nodeTypes'
import { loadSettings, saveSettings, loadChat, saveChat } from './settings'
import { collectAppState, downloadJSON, encryptJSON, decryptJSON, applyAppState } from './backup'
import { DEFAULT_SETTINGS, discuss, decompose, optimizeCanvas, autoRelate, generateReport, decomposeImport } from './ai'
import { treeToGraph } from './treeLayout'
import { buildLearningSummary } from './corrections'
import { readFileAsText } from './importFile'

const AIPanel = forwardRef(function AIPanel({ splitPct = 45, externalInput, onStatus }, ref) {
  const { screenToFlowPosition, fitView } = useReactFlow()
  const addNodesAndEdges = useStore((s) => s.addNodesAndEdges)
  const selectedNode = useStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId),
  )
  // 框选得到的多卡片上下文集合
  const selectedNodeIds = useStore((s) => s.selectedNodeIds)
  const allNodes = useStore((s) => s.nodes)
  const clearSelection = useStore((s) => s.clearSelection)
  const deselectNodes = useStore((s) => s.deselectNodes)
  const setSelectedNode = useStore((s) => s.setSelectedNode)
  // 在上下文芯片上点「下钻」：先选中该卡再进入下钻
  const drillCard = (id) => { setSelectedNode(id); enterDrill() }

  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS })
  const [messages, setMessages] = useState([])
  // 当有外部输入时，input 状态由外部管理；否则用内部状态
  const [internalInput, setInternalInput] = useState('')
  const input = externalInput?.value ?? internalInput
  const setInput = externalInput?.onChange ?? setInternalInput
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  // 备份/恢复向导状态（已并入「设置」弹窗）
  const [backupScope, setBackupScope] = useState('canvas')
  const [backupEncrypt, setBackupEncrypt] = useState(false)
  const [backupPass, setBackupPass] = useState('')
  const [importParsed, setImportParsed] = useState(null)
  const [importEncPass, setImportEncPass] = useState('')
  const [importMode, setImportMode] = useState('merge')
  const [importError, setImportError] = useState(null)
  const collapsed = useStore((s) => s.collapsed)
  const setCollapsed = useStore((s) => s.setCollapsed)
  const [showKey, setShowKey] = useState(false)
  const [report, setReport] = useState(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importFileObj, setImportFileObj] = useState(null)
  const [importUrl, setImportUrl] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importErr, setImportErr] = useState('')
  const [clearConfirm, setClearConfirm] = useState(false)
  // 优化画布：批量审阅（Human-in-the-loop）状态
  const [reviewDiff, setReviewDiff] = useState(null)
  const [reviewSel, setReviewSel] = useState({ add: [], merge: [], relate: [] })
  const scrollRef = useRef(null)
  // 标记历史会话是否已载入：载入前不持久化，避免挂载时的空值覆盖磁盘旧数据
  const chatLoaded = useRef(false)

  // 标签芯片：从 AI 回复消息对象（m.tags）渲染，无需额外状态

  // 下钻模式：针对某张卡片提问并拆解
  const [mode, setMode] = useState('global')
  const [focus, setFocus] = useState(null)
  // 每个节点的下钻对话：nodeId -> [ {role, content} ]，与主会话分离且持久化
  const [threads, setThreads] = useState({})

  // 按画布隔离会话：chatMapRef 保存全部画布的会话；messages/threads 仅承载「当前画布」
  const currentId = useStore((s) => s.currentId)
  const chatMapRef = useRef({})
  const latestChatRef = useRef({ messages: [], threads: {} })
  const prevCanvasRef = useRef(null)
  // 每次渲染同步最新会话，供切换画布时把上一画布的改动刷回 map
  latestChatRef.current = { messages, threads }

  useEffect(() => {
    loadSettings().then((s) => {
      if (s) setSettings((p) => ({ ...p, ...s }))
    })
    // 始终从本地持久层恢复历史会话（按画布隔离，启动不再自动清空）
    loadChat().then((map) => {
      chatMapRef.current = map && typeof map === 'object' ? map : {}
      chatLoaded.current = true
      const id = useStore.getState().currentId
      const slice = chatMapRef.current[id]
      setMessages(slice?.messages || [])
      setThreads(slice?.threads || {})
    })
  }, [])

  // 切换画布：先把上一画布的最新会话刷回 map，再载入目标画布的会话（新画布自然是空白）
  useEffect(() => {
    if (!chatLoaded.current) return
    const prev = prevCanvasRef.current
    if (prev && prev !== currentId) {
      chatMapRef.current[prev] = latestChatRef.current
    }
    prevCanvasRef.current = currentId
    const slice = chatMapRef.current[currentId]
    setMessages(slice?.messages || [])
    setThreads(slice?.threads || {})
  }, [currentId])

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 会话持久化：按当前画布写入，整张 map（含其它画布会话）一并落盘
  useEffect(() => {
    if (!chatLoaded.current) return
    const t = setTimeout(() => {
      saveChat({ ...chatMapRef.current, [currentId]: { messages, threads } })
    }, 400)
    return () => clearTimeout(t)
  }, [messages, threads, currentId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, threads, focus, busy, error])

  const update = (patch) => setSettings((p) => ({ ...p, ...patch }))

  const lastUserText = () =>
    messages.filter((m) => m.role === 'user').slice(-1)[0]?.content || ''

  const enterDrill = () => {
    if (!selectedNode) return
    setFocus(selectedNode)
    setMode('node')
    setInput('')
  }

  const exitDrill = () => {
    setMode('global')
    setFocus(null)
  }

  // ===== 暴露给外部（底栏）调用的方法 =====
  useImperativeHandle(ref, () => ({
    send,
    optimize: doOptimize,
    // 全局模式拆解：不传参时内部回退到最近一条用户消息作为方向
    decompose: () => doDecompose(),
    relate: doRelate,
    report: doReport,
    showImport: () => setShowImport(true),
    toggleSettings: () => setShowSettings(v => !v),
    isCollapsed: collapsed,
    expand: () => setCollapsed(false),
    scrollToType: (type) => scrollToTagType(type),
  }))

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!settings.apiKey) {
      // 演示模式（未配置 Key）：不拦截，走 mock 数据，下方已有「演示模式」标识提示
    }
    setError('')
    setInput('')

    if (mode === 'node' && focus) {
      const thread = threads[focus.id] || []
      const full = [
        { role: 'system', content: `你正在围绕这张卡片进行讨论，卡片内容：\n${focus.data?.content || ''}` },
        ...thread,
        { role: 'user', content: text },
      ]
      setThreads((t) => ({
        ...t,
        [focus.id]: [...(t[focus.id] || []), { role: 'user', content: text }],
      }))
      setBusy(true)
      onStatus?.('LAPOP 正在输出...')
      try {
        const result = await discuss(settings, full)
        const reply = result?.text ?? result
        const tags = result?.tags || []
        setThreads((t) => ({
          ...t,
          [focus.id]: [...(t[focus.id] || []), { role: 'assistant', content: reply, tags }],
        }))
      } catch (e) {
        setError(e.message || '请求出错')
        onStatus?.('没憋出来，再补点细节试试')
      } finally {
        setBusy(false)
      }
    } else {
      const next = [...messages, { role: 'user', content: text }]
      setMessages(next)
      setBusy(true)
      onStatus?.('LAPOP 正在输出...')
      try {
        // 多卡片上下文：框选的卡片拼成 system 提示词，仅用于本次请求，不写入可见历史
        const ctxCards = allNodes.filter((n) => selectedNodeIds.includes(n.id))
        const ctxMsg = ctxCards.length
          ? {
              role: 'system',
              content:
                '以下是用户框选作为本次回答上下文的画布卡片（序号对应画布中的卡片）：\n' +
                ctxCards
                  .map(
                    (n, i) =>
                      `【卡片${i + 1} | ${NODE_TYPES[n.data?.type]?.label || '想法'}】\n${n.data?.content || ''}`,
                  )
                  .join('\n\n'),
            }
          : null
        const apiMessages = ctxMsg ? [ctxMsg, ...next] : next
        const result = await discuss(settings, apiMessages)
        const reply = result?.text ?? result
        const tags = result?.tags || []
        setMessages([...next, { role: 'assistant', content: reply, tags }])
        // 不再自动落图：拆解需用户主动触发（见「拆解落图」按钮 / 聊满 3 轮后的引导）
      } catch (e) {
        setError(e.message || '请求出错')
        onStatus?.('没憋出来，再补点细节试试')
      } finally {
        setBusy(false)
      }
    }
  }

  // 标签芯片点击：聚焦画布上同类节点并高亮闪烁；若还没有，温和提示去拆解
  const focusTagType = (tagType) => {
    const st = useStore.getState()
    const realType = tagType === 'dir' ? 'direction' : tagType
    const matches = st.nodes.filter((n) => n.data.type === realType)
    if (matches.length === 0) {
      setError('画布上暂无同类节点，点「拆解落图」即可生成。')
      return
    }
    fitView({ nodes: matches.map((n) => ({ id: n.id })), padding: 0.2, duration: 400, maxZoom: 1.2 })
    // 高亮闪烁对应节点
    setTimeout(() => {
      document.querySelectorAll(`[data-type="${realType}"] .node-card`).forEach((el) => {
        el.classList.add('node-flash')
        setTimeout(() => el.classList.remove('node-flash'), 900)
      })
    }, 450)
  }

  // 画布节点点击 → 对话区自动滚动到对应段落
  const scrollToTagType = (type) => {
    if (!type) return
    const msgs = mode === 'node' && focus ? threads[focus.id] || [] : messages
    const idx = msgs.findLastIndex((m) =>
      m.role === 'assistant' && m.tags?.some((t) => t.type === type || (type === 'direction' && t.type === 'dir')),
    )
    if (idx === -1 || !scrollRef.current) return
    const el = scrollRef.current.children[idx]
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const doDecompose = async (forcedDirection, forcedHistory) => {
    if (!settings.apiKey) {
      // 演示模式（未配置 Key）：不拦截，走 mock 数据，下方已有「演示模式」标识提示
    }
    let direction
    let history
    let anchor = null
    if (mode === 'node' && focus) {
      direction = focus.data?.content ||
        (threads[focus.id] || []).filter((m) => m.role === 'user').slice(-1)[0]?.content || ''
      if (!direction) {
        setError('卡片为空，且没有提问内容。先给卡片写几个字或提问后再拆解。')
        return
      }
      history = threads[focus.id] || []
      anchor = focus
    } else {
      direction = forcedDirection || input.trim() || lastUserText()
      if (!direction) {
        setError('先输入想法，或先和 AI 讨论。')
        return
      }
      history = forcedHistory || messages
    }
    setError('')
    setBusy(true)
    onStatus?.('LAPOP 正在输出...')
    try {
      const learning = await buildLearningSummary()
      const tree = await decompose(settings, direction, { history, anchor, learning })
      const st = useStore.getState()
      let origin
      if (anchor) {
        origin = { x: focus.position.x, y: focus.position.y }
      } else if (st.nodes.length === 0) {
        const center = screenToFlowPosition({
          x: window.innerWidth / 2 - 220,
          y: window.innerHeight / 2,
        })
        origin = { x: center.x, y: center.y }
      } else {
        origin = findFreeTreeOrigin(st.nodes)
      }
      const { nodes: dNodes, edges: dEdges } = treeToGraph(tree, anchor ? { anchor } : { origin })
      addNodesAndEdges(dNodes, dEdges)
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60)
      onStatus?.(`POP！已生成 ${dNodes.length} 个节点`)
      const summary = `已拆解，生成 ${dNodes.length} 个节点、${dEdges.length} 条连线${anchor ? '，挂在该卡片下' : ''}`
      if (mode === 'node') {
        setThreads((t) => ({
          ...t,
          [focus.id]: [...(t[focus.id] || []), { role: 'assistant', content: summary }],
        }))
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: summary }])
      }
    } catch (e) {
      setError(e.message || '拆解失败')
      onStatus?.('没憋出来，再补点细节试试')
    } finally {
      setBusy(false)
    }
  }

  function findFreeTreeOrigin(nodes, gap = 260) {
    if (!nodes.length) return { x: 0, y: 0 }
    const minY = Math.min(...nodes.map((n) => n.position.y))
    const maxX = Math.max(...nodes.map((n) => n.position.x + (n.width || 170)))
    return { x: maxX + gap, y: minY }
  }

  function collectSubgraph(st, focusId) {
    const childMap = new Map()
    st.edges.forEach((e) => {
      if (!childMap.has(e.source)) childMap.set(e.source, [])
      childMap.get(e.source).push(e.target)
    })
    const ids = new Set([focusId])
    const queue = [focusId]
    while (queue.length) {
      const cur = queue.shift()
      for (const c of childMap.get(cur) || []) {
        if (!ids.has(c)) { ids.add(c); queue.push(c) }
      }
    }
    return {
      nodes: st.nodes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, type: n.data.type, content: n.data.content })),
      edges: st.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target })),
    }
  }

  const doOptimize = async () => {
    if (!settings.apiKey) {
      // 演示模式（未配置 Key）：不拦截，走 mock 数据，下方已有「演示模式」标识提示
    }
    setError('')
    setBusy(true)
    onStatus?.('LAPOP 正在输出...')
    try {
      const st = useStore.getState()
      const graph = {
        nodes: st.nodes.map((n) => ({ id: n.id, type: n.data.type, content: n.data.content })),
        edges: st.edges.map((e) => ({ source: e.source, target: e.target })),
      }
      if (!graph.nodes.length) {
        setError('画布是空的，先放点东西再优化。')
        setBusy(false)
        return
      }
      // 重新排版：基于 dagre 的分层树布局，卡片不再重叠（带 600ms 平滑过渡 + 自动适应画布）
      await layoutTree({ nodes: st.nodes, edges: st.edges, setNodes: st.setNodes, fitView })
      const laidNodes = useStore.getState().nodes
      const selId = st.selectedNodeId
      const selNode = selId ? st.nodes.find((n) => n.id === selId) : null
      const subgraph = selNode ? collectSubgraph(st, selNode) : null
      const res = await optimizeCanvas(settings, graph, {
        mode: selNode ? 'node' : 'global',
        focusId: selNode?.id || null,
        focusContent: selNode?.data.content || '',
        subgraph,
      })
      const firstLine = (c) => (c || '').split('\n').find((l) => l.trim()) || ''
      const parentLabelOf = (pid) => {
        const p = laidNodes.find((n) => n.id === pid)
        return p ? firstLine(p.data.content) || '（根卡片）' : '（无）'
      }
      // 构建「待确认改动清单」而非直接落图（Human-in-the-loop）
      const addDiff = res.add.map((a) => ({
        ...a,
        label: [a.title, a.body].filter(Boolean).join(' / ') || '新节点',
        parentLabel: parentLabelOf(a.parentId),
      }))
      const mergeDiff = res.merge
        .map(([aId, bId]) => {
          const a = st.nodes.find((n) => n.id === aId)
          const b = st.nodes.find((n) => n.id === bId)
          if (!a || !b) return null
          return { aId, bId, aLabel: firstLine(a.data.content) || aId, bLabel: firstLine(b.data.content) || bId }
        })
        .filter(Boolean)
      let relDiff = []
      try {
        const suggested = await autoRelate(settings, graph)
        const existing = new Set(st.edges.map((e) => `${e.source}-${e.target}`))
        relDiff = suggested
          .filter((ed) => ed.source && ed.target && ed.source !== ed.target && !existing.has(`${ed.source}-${ed.target}`))
          .map((ed) => ({
            source: ed.source,
            target: ed.target,
            reason: ed.reason || '',
            sLabel: firstLine(st.nodes.find((n) => n.id === ed.source)?.data.content) || ed.source,
            tLabel: firstLine(st.nodes.find((n) => n.id === ed.target)?.data.content) || ed.target,
          }))
      } catch { /* 不阻断 */ }
      const diff = { add: addDiff, merge: mergeDiff, relate: relDiff, notes: res.notes || '' }
      setReviewDiff(diff)
      setReviewSel({ add: addDiff.map(() => true), merge: mergeDiff.map(() => true), relate: relDiff.map(() => true) })
      setBusy(false)
    } catch (e) {
      setError(e.message || '优化失败')
      onStatus?.('没憋出来，再补点细节试试')
      setBusy(false)
    }
  }

  // 勾选切换（按类型 + 索引）
  const toggleReview = (type, i, val) => {
    setReviewSel((prev) => {
      const next = { ...prev, [type]: prev[type].slice() }
      next[type][i] = val
      return next
    })
  }
  const selectAllReview = () => {
    if (!reviewDiff) return
    setReviewSel({
      add: reviewDiff.add.map(() => true),
      merge: reviewDiff.merge.map(() => true),
      relate: reviewDiff.relate.map(() => true),
    })
  }
  const anyReviewChecked = () =>
    reviewSel.add.some(Boolean) || reviewSel.merge.some(Boolean) || reviewSel.relate.some(Boolean)

  // 应用被勾选的改动（其余丢弃）
  const applyReview = () => {
    const diff = reviewDiff
    if (!diff) return
    const st = useStore.getState()
    const newNodes = []
    const newEdges = []
    const exist = new Set(st.edges.map((e) => `${e.source}-${e.target}`))
    reviewSel.add.forEach((on, i) => {
      if (!on) return
      const a = diff.add[i]
      const parent = st.nodes.find((n) => n.id === a.parentId) || st.nodes[0]
      if (!parent) return
      const id = nanoid(6)
      const pos = findFreePosition(parent, [...st.nodes, ...newNodes])
      newNodes.push({
        id, type: 'custom', position: pos,
        data: { type: a.type || 'step', content: [a.title, a.body].filter(Boolean).join('\n'), ai: true, read: false },
      })
      newEdges.push({ id: `e-${a.parentId}-${id}`, source: a.parentId, target: id, data: { read: false } })
    })
    const delIds = []
    reviewSel.merge.forEach((on, i) => {
      if (!on) return
      const { aId, bId } = diff.merge[i]
      const a = st.nodes.find((n) => n.id === aId)
      const b = st.nodes.find((n) => n.id === bId)
      if (a && b) {
        const merged = (a.data.content ? a.data.content + '\n' : '') + (b.data.content || '')
        st.updateNodeData(aId, { content: merged })
        delIds.push(bId)
      }
    })
    if (delIds.length) delIds.forEach((id) => st.deleteNode(id))
    const relEdges = []
    reviewSel.relate.forEach((on, i) => {
      if (!on) return
      const ed = diff.relate[i]
      const key = `${ed.source}-${ed.target}`
      if (exist.has(key)) return
      exist.add(key)
      relEdges.push({
        id: `e-rel-${ed.source}-${ed.target}-${nanoid(4)}`, source: ed.source, target: ed.target,
        data: { reason: ed.reason || '' },
      })
    })
    if (newNodes.length) st.addNodesAndEdges(newNodes, newEdges)
    if (relEdges.length) st.addNodesAndEdges([], relEdges)
    const appliedAdd = reviewSel.add.filter(Boolean).length
    const appliedMerge = reviewSel.merge.filter(Boolean).length
    const appliedRel = reviewSel.relate.filter(Boolean).length
    setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 80)
    const summary = `已应用优化：新增 ${appliedAdd} 个节点，合并 ${appliedMerge} 组，新增关联 ${appliedRel} 条。${diff.notes ? '\n' + diff.notes : ''}`
    setMessages((m) => [...m, { role: 'assistant', content: summary }])
    onStatus?.(`POP！已优化 ${appliedAdd + appliedMerge + appliedRel} 处`)
    setReviewDiff(null)
  }

  // 重新排版：基于 dagre 的有向图分层布局（优化画布用）
  // 仅修改节点 position，绝不触碰节点内容 / 类型 / 连线数据。
  async function layoutTree({ nodes, edges, setNodes, fitView }) {
    // 边界：空画布直接返回
    if (!nodes.length) return
    // 边界：节点过多，跳过排版以保持性能
    if (nodes.length > 200) {
      window.alert('节点过多（>200），跳过自动排版以保持性能')
      return
    }

    const NODE_W = 210
    const NODE_H = 96
    const H_GAP = 240   // 层级间水平间距（中心距）：比节点宽略大，节点间留约 30px 缝隙，紧凑
    const V_GAP = 130   // 同层垂直间距（中心距）：卡片间留约 34px 缝隙
    const TREE_GAP = 180 // 多棵树之间的垂直间距（LR 下纵向分列）
    const ORPHAN_GAP = 180 // 孤立区与树区的水平间距
    const COLS = 6      // 孤立节点每列最多 6 个（纵向排列）
    const LEFT_X = 120  // 根节点列 x 起点（左侧）

    const sizeOf = (n) => ({
      w: n.measured?.width || n.width || NODE_W,
      h: n.measured?.height || n.height || NODE_H,
    })
    const inEdge = new Set(edges.map((e) => e.target))
    const connected = new Set()
    edges.forEach((e) => { connected.add(e.source); connected.add(e.target) })

    // 根节点 = 无入边；多根在 LR 下按"原有 position.y"纵向分列（从上到下），每棵占独立垂直区域
    let roots = nodes.filter((n) => !inEdge.has(n.id))
    if (!roots.length && nodes.length) roots = [nodes[0]]

    // 孤立节点 = 没有任何连线的节点
    const isolated = nodes.filter((n) => !connected.has(n.id))
    const isolatedSet = new Set(isolated.map((n) => n.id))

    // 1) dagre 计算分层坐标（LR：左 → 右，符合横向浏览习惯）
    //    LR 下 ranksep = 层级间水平间距，nodesep = 同层节点垂直间距
    const g = new dagre.graphlib.Graph()
    g.setGraph({
      rankdir: 'LR',
      nodesep: Math.max(20, V_GAP - NODE_H), // 同层（垂直方向）节点间距：V_GAP(130)-NODE_H(96)=34
      ranksep: Math.max(20, H_GAP - NODE_W), // 层间（水平方向）节点间距：H_GAP(240)-NODE_W(210)=30
      marginx: 20,
      marginy: 20,
    })
    g.setDefaultEdgeLabel(() => ({}))
    const measured = new Map()
    nodes.forEach((n) => {
      const s = sizeOf(n)
      measured.set(n.id, s)
      g.setNode(n.id, { width: s.w, height: s.h })
    })
    edges.forEach((e) => {
      if (connected.has(e.source) && connected.has(e.target)) g.setEdge(e.source, e.target)
    })
    dagre.layout(g)

    // dagre 返回中心点，转 React Flow 左上角坐标
    const pos = new Map()
    nodes.forEach((n) => {
      const dn = g.node(n.id)
      const s = measured.get(n.id)
      pos.set(n.id, { x: dn.x - s.w / 2, y: dn.y - s.h / 2 })
    })

    // 2) 按根重组：LR 下多棵树纵向分列（从上到下），每棵占独立垂直区域
    //    根按"原有 position.y"从小到大排序（从上到下）
    const origY = new Map(nodes.map((n) => [n.id, n.position?.y ?? 0]))
    roots.sort((a, b) => (origY.get(a.id) ?? 0) - (origY.get(b.id) ?? 0))
    const childMap = new Map()
    edges.forEach((e) => {
      if (!childMap.has(e.source)) childMap.set(e.source, [])
      childMap.get(e.source).push(e.target)
    })
    const subtreeIds = (rootId) => {
      const out = []
      const stack = [rootId]
      while (stack.length) {
        const id = stack.pop()
        out.push(id)
        for (const c of childMap.get(id) || []) stack.push(c)
      }
      return out
    }
    const groups = roots.map((r) => {
      const ids = subtreeIds(r.id)
      const ys = ids.map((id) => pos.get(id).y)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      return { ids, minY, maxY, h: maxY - minY }
    })
    let cursor = 0
    groups.forEach((grp) => {
      const shift = cursor - grp.minY
      grp.ids.forEach((id) => { const p = pos.get(id); p.y += shift })
      cursor += grp.h + TREE_GAP
    })

    // 3) 整片森林：根列对齐到左侧（LEFT_X），垂直居中于视口高度 / 2
    const rfEl = (typeof document !== 'undefined') ? document.querySelector('.react-flow') : null
    const vw = rfEl ? rfEl.clientWidth : (typeof window !== 'undefined' ? window.innerWidth : 1280)
    const vh = rfEl ? rfEl.clientHeight : (typeof window !== 'undefined' ? window.innerHeight : 800)
    const ysAll = nodes.map((n) => pos.get(n.id).y)
    const centerY = (Math.min(...ysAll) + Math.max(...ysAll)) / 2
    const minX = Math.min(...nodes.map((n) => pos.get(n.id).x))
    const dx = LEFT_X - minX
    const dy = vh / 2 - centerY
    nodes.forEach((n) => { const p = pos.get(n.id); p.x += dx; p.y += dy })

    // 4) 孤立节点放最右侧网格（每列最多 COLS 个，纵向排列，与树区保持 ORPHAN_GAP 水平间距）
    if (isolated.length) {
      const treeMaxX = Math.max(0, ...nodes.filter((n) => !isolatedSet.has(n.id)).map((n) => {
        const p = pos.get(n.id)
        const s = measured.get(n.id)
        return p.x + s.w
      }))
      const startX = treeMaxX + ORPHAN_GAP
      const cellW = NODE_W + H_GAP // 列间水平间距
      const cellH = NODE_H + V_GAP // 同列垂直间距
      const gridH = COLS * cellH
      const startY = vh / 2 - gridH / 2
      isolated.forEach((n, i) => {
        const col = Math.floor(i / COLS)
        const row = i % COLS
        pos.set(n.id, { x: startX + col * cellW, y: startY + row * cellH })
      })
    }

    // 5) 批量更新 + 600ms 平滑过渡 + 自动适应画布
    if (rfEl) rfEl.classList.add('layouting')
    setNodes((ns) => ns.map((n) => {
      const p = pos.get(n.id)
      return p ? { ...n, position: p } : n
    }))
    setTimeout(() => { try { fitView({ padding: 0.2, duration: 400 }) } catch (e) {} }, 60)
    setTimeout(() => { if (rfEl) rfEl.classList.remove('layouting') }, 660)
  }

  function findFreePosition(parentNode, allNodes, w = 170, h = 70) {
    const target = parentNode.position
    const others = allNodes.filter((n) => n.id !== parentNode.id)
    const xStep = 180, yStep = 70
    for (let col = 0; col < 6; col++) {
      for (let row = -3; row <= 10; row++) {
        const x = target.x + 200 + col * xStep
        const y = target.y + row * yStep
        const overlap = others.some((n) => {
          const nw = n.width || 170, nh = n.height || 70
          const nx = n.position.x + nw / 2
          const ny = n.position.y + nh / 2
          return (
            Math.abs(nx - (x + w / 2)) < (nw + w) / 2 + 10 &&
            Math.abs(ny - (y + h / 2)) < (nh + h) / 2 + 10
          )
        })
        if (!overlap) return { x, y }
      }
    }
    return { x: target.x + 200, y: target.y + 10 * yStep }
  }

  const doRelate = async () => {
    if (!settings.apiKey) {
      // 演示模式：走 mock 关联，不拦截
    }
    setError(''); setBusy(true)
    onStatus?.('LAPOP 正在输出...')
    try {
      const st = useStore.getState()
      const graph = {
        nodes: st.nodes.map((n) => ({ id: n.id, type: n.data.type, content: n.data.content })),
        edges: st.edges.map((e) => ({ source: e.source, target: e.target })),
      }
      if (graph.nodes.length < 2) { setError('至少要有两张卡片才能自动关联。'); setBusy(false); return }
      const suggested = await autoRelate(settings, graph)
      const existing = new Set(st.edges.map((e) => `${e.source}-${e.target}`))
      const newEdges = []
      for (const ed of suggested) {
        if (!ed.source || !ed.target || ed.source === ed.target) continue
        const key = `${ed.source}-${ed.target}`
        if (existing.has(key)) continue
        existing.add(key)
        newEdges.push({ id: `e-${ed.source}-${ed.target}`, source: ed.source, target: ed.target, data: { reason: ed.reason || '' } })
      }
      if (newEdges.length) st.addNodesAndEdges([], newEdges)
      setMessages((m) => [...m, { role: 'assistant', content: `自动关联完成：新增 ${newEdges.length} 条连线。` }])
      onStatus?.(`POP！已新增 ${newEdges.length} 条关联`)
    } catch (e) {
      setError(e.message || '自动关联失败')
      onStatus?.('没憋出来，再补点细节试试')
    } finally {
      setBusy(false)
    }
  }

  const doReport = async () => {
    if (!settings.apiKey) {
      // 演示模式：走 mock 报告，不拦截
    }
    const st = useStore.getState()
    if (!st.nodes.length) { setError('画布是空的，先放点东西再生成报告。'); return }
    setError(''); setReportBusy(true)
    try {
      const graph = {
        nodes: st.nodes.map((n) => ({ id: n.id, type: n.data.type, content: n.data.content })),
        edges: st.edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
      }
      const text = await generateReport(settings, graph)
      setReport(text)
    } catch (e) {
      setError(e.message || '生成报告失败')
      onStatus?.('没憋出来，再补点细节试试')
    } finally {
      setReportBusy(false)
    }
  }

  const downloadReport = () => {
    if (!report) return
    const blob = new Blob([report], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'LAPOP 报告.md'; a.click(); URL.revokeObjectURL(url)
  }

  const doImport = async () => {
    if (!settings.apiKey) {
      // 演示模式：走 mock 导入拆解，不拦截
    }
    let text = importText.trim()
    if (importFileObj) {
      setImportBusy(true); setImportErr('')
      try { text = (await readFileAsText(importFileObj)).trim() }
      catch (e) { setImportBusy(false); setImportErr(e.message || '文件解析失败'); return }
    }
    // 链接框：尽力抓取（浏览器受 CORS 限制，多数分享页会失败，失败则提示粘贴文本）
    if (!text && importUrl.trim()) {
      setImportBusy(true); setImportErr('')
      try {
        const resp = await fetch(importUrl.trim())
        const html = await resp.text()
        text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      } catch (e) {
        setImportBusy(false)
        setImportErr('无法抓取该链接（可能被跨域策略拦截）。请直接复制聊天文本粘贴，或导出文件后上传。')
        return
      }
    }
    if (!text) { setImportErr('先粘贴内容、上传文件，或填入一个可访问的分享链接。'); return }
    setImportErr(''); setImportBusy(true)
    onStatus?.('LAPOP 正在输出...')
    try {
      const learning = await buildLearningSummary()
      const tree = await decomposeImport(settings, text, { learning })
      const st = useStore.getState()
      const origin = st.nodes.length === 0
        ? (() => { const c = screenToFlowPosition({ x: window.innerWidth / 2 - 220, y: window.innerHeight / 2 }); return { x: c.x, y: c.y } })()
        : findFreeTreeOrigin(st.nodes)
      const { nodes, edges } = treeToGraph(tree, { origin })
      addNodesAndEdges(nodes, edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60)
      setMessages((m) => [...m, { role: 'assistant', content: `已从材料拆解，生成 ${nodes.length} 个节点、${edges.length} 条连线。` }])
      onStatus?.(`POP！已生成 ${nodes.length} 个节点`)
      setShowImport(false); setImportText(''); setImportFileObj(null); setImportUrl('')
    } catch (e) {
      setImportErr(e.message || '导入拆解失败')
      onStatus?.('没憋出来，再补点细节试试')
    } finally {
      setImportBusy(false)
    }
  }

  // ===== 备份 / 恢复（已并入「设置」弹窗）=====
  const handleExportBackup = async () => {
    try {
      let payload
      if (backupScope === 'app') {
        payload = await collectAppState()
      } else {
        const st = useStore.getState()
        payload = {
          app: 'LAPOP', kind: 'canvas', version: 1,
          exportedAt: new Date().toISOString(),
          canvas: { nodes: st.nodes, edges: st.edges },
        }
      }
      if (backupEncrypt) {
        if (!backupPass) { onStatus?.('请先输入加密口令'); return }
        payload = await encryptJSON(payload, backupPass)
      }
      const stamp = new Date().toISOString().slice(0, 10)
      downloadJSON(payload, `lapop-${backupScope}-${stamp}.json`)
      onStatus?.('已导出备份文件')
    } catch (e) {
      onStatus?.('导出失败：' + (e.message || '未知错误'))
    }
  }

  const handleImportFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        setImportParsed(parsed)
        setImportError(null)
      } catch (err) {
        setImportParsed(null)
        setImportError('文件不是合法 JSON')
      }
    }
    reader.onerror = () => setImportError('读取文件失败')
    reader.readAsText(f)
    e.target.value = ''
  }

  const handleRestore = async () => {
    try {
      if (!importParsed) { setImportError('请先选择备份文件'); return }
      let parsed = importParsed
      if (parsed.encrypted) {
        if (!importEncPass) { setImportError('请输入解密口令'); return }
        parsed = await decryptJSON(parsed, importEncPass)
      }
      const canvas = parsed.canvas || (parsed.nodes ? parsed : null)
      if (!canvas) { setImportError('备份文件不含画布数据'); return }
      await applyAppState(parsed, importMode, useStore.getState())
      onStatus?.('恢复完成')
      setShowSettings(false)
      setTimeout(() => fitView({ duration: 400 }), 120)
    } catch (e) {
      setImportError('恢复失败：' + (e.message || '口令错误或文件损坏'))
    }
  }

  // 收起态：浮动按钮
  if (collapsed) {
    return (
      <button className="ai-fab" onClick={() => setCollapsed(false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>
        <span>AI</span>
      </button>
    )
  }

  const displayMsgs = mode === 'node' && focus ? threads[focus.id] || [] : messages

  // 是否使用外部输入（底栏模式）
  const hasExternalInput = !!externalInput

  return (
    <div className="ai-panel" style={{ width: `${splitPct}%` }}>
      {/* 面板头部 */}
      <div className="ai-head">
        <span>AI 聊天框</span>
        {!settings.apiKey && <span className="demo-badge">演示模式 · 模拟数据</span>}
        <button className="ai-mini" onClick={() => setCollapsed(true)} title="收起">—</button>
      </div>

      {/* 下钻/选中提示条 */}
      {mode === 'node' && focus && (
        <div className="ai-focus">📌 正在下钻卡片：<b>{focus.data?.content?.slice(0, 30) || '（空卡片）'}</b><button className="ai-exit" onClick={exitDrill}>返回</button></div>
      )}
      {mode === 'global' && selectedNodeIds.length > 0 && (() => {
        const cards = allNodes.filter((n) => selectedNodeIds.includes(n.id))
        return (
          <div className="ai-context">
            <span className="ctx-label">🟦 上下文 {cards.length} 张</span>
            <div className="ctx-chips">
              {cards.map((n) => (
                <span className="ctx-chip" key={n.id}>
                  <span className={`ctx-dot type-${n.data?.type || 'idea'}`} />
                  <span className="ctx-name">{(n.data?.content || '（空卡片）').split('\n')[0].slice(0, 16) || '（空卡片）'}</span>
                  <button className="ctx-drill" title="在此卡片下钻提问" onClick={() => drillCard(n.id)}>下钻</button>
                  <button className="ctx-x" title="移出上下文" onClick={() => deselectNodes([n.id])}>×</button>
                </span>
              ))}
            </div>
            <button className="ctx-clear" onClick={clearSelection}>清空</button>
          </div>
        )
      })()}

      {/* 消息列表 */}
      <div className="ai-msg-list" ref={scrollRef}>
        {displayMsgs.length === 0 && !busy && !error && (
            <div className="ai-empty">
            <div className="ai-empty-logo">LA</div>
            <img className="ai-empty-mascot" src={import.meta.env.BASE_URL + 'walk-mascot.gif'} alt="LAPOP" />
            <div className="ai-empty-hint">&gt; 准备就绪，等待你的灵感输入<span className="ai-wait-dots"><i/><i/><i/><i/></span></div>
          </div>
        )}
        {displayMsgs.map((m, i) => {
          const isLast = i === displayMsgs.length - 1
          const userRounds = displayMsgs.filter((x) => x.role === 'user').length
          const showDecomposeHint = mode === 'global' && m.role === 'assistant' && isLast && userRounds >= 3
          // AI 回答按空行拆成可拖拽段落；用户消息保持原样
          const paras = m.role === 'assistant'
            ? (m.content || '').split(/\n\n+/).map((s) => s.trim()).filter(Boolean)
            : []
          return (
            <div key={i}>
              <div className={`ai-msg ai-${m.role}`}>
                {m.role === 'assistant'
                  ? (paras.length ? paras.map((para, pi) => (
                    <div className="ai-para" key={pi}>
                      <span
                        className="para-handle"
                        title="按住拖到画布"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'copy'
                          e.dataTransfer.setData('application/lapop-para', JSON.stringify({ text: para, type: 'resource' }))
                        }}
                      >⊕</span>
                      <span className="ai-para-text">{para}</span>
                    </div>
                  )) : <div className="ai-msg-text">{m.content}</div>)
                  : <div className="ai-msg-text">{m.content}</div>}
                {/* 每条助手消息自带标签芯片（对齐原型：INSIGHT/DIR/STEP/IDEA） */}
                {m.role === 'assistant' && m.tags && m.tags.length > 0 && (
                  <div className="tag-chips">
                    {m.tags.map((tag, ti) => (
                      <button key={ti} className={`tag-chip type-${tag.type}`}
                        title={`聚焦画布上同类节点: ${tag.label}`}
                        onClick={() => focusTagType(tag.type)}>
                        {tag.type.toUpperCase()}: {tag.label}
                      </button>
                    ))}
                  </div>
                )}
                {/* 聊满 3 轮后，最后一条助手消息下方给出拆解引导（用户主动触发） */}
                {showDecomposeHint && (
                  <button className="decompose-hint" onClick={() => doDecompose(lastUserText())} disabled={busy}>
                    👉 方向已明确？点此「拆解落图」生成图谱
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {busy && (
          <div className="ai-loading">
            <span className="loading-dot dot-pink" />
            <span className="loading-dot dot-blue" />
            <span className="loading-dot dot-yellow" />
            <span className="loading-dot dot-green" />
          </div>
        )}
        {error && <div className="ai-error">{error}</div>}
      </div>

      {/* 下钻模式：拆解按钮（外部输入模式下仍保留，挂到选中卡片下） */}
      {mode === 'node' && focus && (
        <div className="ai-drill-bar">
          <button className="primary" onClick={doDecompose} disabled={busy}>挂在此卡下拆解</button>
        </div>
      )}

      {/* ===== 外部输入模式下：不渲染内置输入区和操作按钮行 ===== */}
      {!hasExternalInput && (
        <>
          <div className="ai-input-row">
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder={mode === 'node' ? '针对这张卡片继续提问…（Enter 发送，Shift+Enter 换行）' : '输入想法，或继续和 AI 讨论…（Enter 发送，Shift+Enter 换行）'}
              rows={Math.min(Math.max(input.split('\n').length, 3), 8)}
            />
          </div>
          <div className="ai-actions">
            <button onClick={send} disabled={busy}>发送</button>
            {mode === 'node'
              ? <button className="primary" onClick={doDecompose} disabled={busy}>挂在此卡下拆解</button>
              : <button className="primary" onClick={doDecompose} disabled={busy}>拆解落图</button>
            }
            <button className="ghost" onClick={doOptimize} disabled={busy}>优化画布</button>
            <button className="ghost" onClick={doRelate} disabled={busy}>自动关联</button>
            <button className="ghost" onClick={doReport} disabled={reportBusy}>生成报告</button>
            <button className="ghost" onClick={() => setShowImport(true)}>导入</button>
            <button className="ghost" onClick={() => setShowSettings((v) => !v)}>设置</button>
          </div>
        </>
      )}

      {/* 设置弹窗（含备份与恢复，复用备份向导视觉语言） */}
      {showSettings && (
        <div className="modal-mask" onClick={() => setShowSettings(false)}>
          <div className="backup-modal settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="设置">
            <div className="backup-head">
              <span>⚙ 设置</span>
              <button className="report-close" onClick={() => setShowSettings(false)}>关闭</button>
            </div>
            <div className="backup-body">
              {/* AI 配置 */}
              <div className="backup-sec">
                <div className="backup-sec-title">AI 配置</div>
                <label className="backup-row"><span>API Key</span>
                  <span className="key-row">
                    <input type={showKey ? 'text' : 'password'} value={settings.apiKey}
                      onChange={(e) => update({ apiKey: e.target.value })} placeholder="sk-..." />
                    <button type="button" className="key-toggle" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  </span>
                </label>
                <label className="backup-row"><span>Base URL</span>
                  <input value={settings.baseURL} onChange={(e) => update({ baseURL: e.target.value })} placeholder="https://api.deepseek.com" />
                </label>
                <label className="backup-row"><span>模型</span>
                  <input value={settings.model} onChange={(e) => update({ model: e.target.value })} placeholder="deepseek-v4-pro" list="model-options" />
                </label>
                <datalist id="model-options">
                  <option value="deepseek-v4-pro" /><option value="deepseek-v4-flash" />
                  <option value="deepseek-chat" /><option value="deepseek-reasoner" />
                  <option value="gpt-4o" /><option value="gpt-4o-mini" />
                  <option value="claude-3-5-sonnet-20241022" /><option value="qwen-max" />
                </datalist>
                <div className="settings-tip">
                  默认 DeepSeek（OpenAI 兼容）。DeepSeek 官方模型请填 <code>deepseek-v4-pro</code> 或 <code>deepseek-v4-flash</code>；
                  旧版 <code>deepseek-chat</code> / <code>deepseek-reasoner</code> 将于 2026/07/24 弃用。
                  Base URL 默认 <code>https://api.deepseek.com</code>（无需加 /v1）。Key 仅存本机，应用直连厂商。
                </div>
              </div>

              {/* 联网搜索 */}
              <div className="backup-sec">
                <div className="backup-sec-title">联网搜索</div>
                <label className="backup-row"><span>模式</span>
                  <select value={settings.searchMode} onChange={(e) => update({ searchMode: e.target.value })}>
                    <option value="none">关闭（仅模型知识库）</option>
                    <option value="app">应用侧 · 搜索 API 注入（RAG）</option>
                    <option value="model">模型侧 · web_search 工具</option>
                  </select>
                </label>
                {settings.searchMode === 'app' && (
                  <>
                    <label className="backup-row"><span>搜索服务</span>
                      <select value={settings.searchProvider} onChange={(e) => update({ searchProvider: e.target.value })}>
                        <option value="tavily">Tavily</option>
                        <option value="serpapi">SerpAPI</option>
                        <option value="bing">Bing</option>
                      </select>
                    </label>
                    <label className="backup-row"><span>搜索 API Key</span>
                      <span className="key-row">
                        <input type={showKey ? 'text' : 'password'} value={settings.searchApiKey || ''}
                          onChange={(e) => update({ searchApiKey: e.target.value })} placeholder="搜索服务 Key" />
                        <button type="button" className="key-toggle" onClick={() => setShowKey((v) => !v)}>
                          {showKey ? '隐藏' : '显示'}
                        </button>
                      </span>
                    </label>
                  </>
                )}
                {settings.searchMode === 'model' && (
                  <label className="settings-toggle">
                    <input type="checkbox" checked={!!settings.modelWebSearch} onChange={(e) => update({ modelWebSearch: e.target.checked })} />
                    <span>启用 web_search 工具（需模型厂商支持，如 OpenAI o 系列；由厂商执行搜索，无需搜索 Key）</span>
                  </label>
                )}
                <div className="settings-tip">
                  应用侧：填入搜索服务 Key，AI 回答前先联网取资料注入上下文（受 CORS 限制，Tavily / SerpAPI 通常可直接用）。
                  模型侧：由模型厂商代发搜索，无需搜索 Key，但 DeepSeek 等多数模型不支持此工具。
                </div>
              </div>

              {/* 备份与恢复 */}
              <div className="backup-sec">
                <div className="backup-sec-title">备份与恢复</div>
                <label className="backup-row"><span>范围</span>
                  <select value={backupScope} onChange={(e) => setBackupScope(e.target.value)}>
                    <option value="canvas">当前画布</option>
                    <option value="app">整个应用（含对话与设置）</option>
                  </select>
                </label>
                <label className="backup-row"><span>加密口令</span>
                  <input type="password" placeholder="留空则不加密"
                    value={backupPass} onChange={(e) => { setBackupPass(e.target.value); setBackupEncrypt(!!e.target.value) }} />
                </label>
                <div className="backup-tip">加密使用浏览器内置 AES-GCM，口令不会上传；忘记口令将无法恢复。</div>
                <button className="backup-btn" onClick={handleExportBackup}>导出为 JSON</button>

                <div className="backup-divider" />
                <div className="backup-sec-title">导入恢复</div>
                <input type="file" accept="application/json,.json" onChange={handleImportFile} />
                {importParsed && importParsed.encrypted && (
                  <label className="backup-row"><span>解密口令</span>
                    <input type="password" placeholder="输入备份时设置的口令"
                      value={importEncPass} onChange={(e) => setImportEncPass(e.target.value)} />
                  </label>
                )}
                <label className="backup-row"><span>模式</span>
                  <select value={importMode} onChange={(e) => setImportMode(e.target.value)}>
                    <option value="merge">合并（仅添加新节点）</option>
                    <option value="replace">替换（覆盖当前画布）</option>
                  </select>
                </label>
                {importError && <div className="backup-err">{importError}</div>}
                <button className="backup-btn" onClick={handleRestore} disabled={!importParsed}>开始恢复</button>
              </div>

              {/* 危险操作 */}
              <div className="backup-sec danger-zone">
                <div className="backup-sec-title">危险操作</div>
                {!clearConfirm ? (
                  <button className="tb-danger" onClick={() => setClearConfirm(true)}>清空画布</button>
                ) : (
                  <div className="clear-confirm">
                    <span>确认清空全部节点与连线？</span>
                    <div className="confirm-actions">
                      <button className="danger" onClick={() => { useStore.getState().clear(); setClearConfirm(false) }}>确认清空</button>
                      <button onClick={() => setClearConfirm(false)}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 报告弹窗 */}
      {report && (
        <div className="modal-mask" onClick={() => setReport(null)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="report-head"><span>📄 画布报告</span><div className="report-actions">
              <button onClick={() => navigator.clipboard?.writeText(report)}>复制</button>
              <button onClick={downloadReport}>下载 .md</button>
              <button className="report-close" onClick={() => setReport(null)}>关闭</button>
            </div></div>
            <pre className="report-body">{report}</pre>
          </div>
        </div>
      )}

      {/* 导入弹窗（复用备份向导视觉语言） */}
      {showImport && (
        <div className="modal-mask" onClick={() => setShowImport(false)}>
          <div className="backup-modal import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="backup-head">
              <span>📥 导入材料 → 拆解成图谱</span>
              <button className="report-close" onClick={() => setShowImport(false)}>关闭</button>
            </div>
            <div className="backup-body">
              <div className="import-tip">
                把想法 / 文章 / 笔记，或其他 AI（ChatGPT、Claude、DeepSeek、豆包等）的聊天记录导出粘贴进来；
                也支持上传 <b>.md / .txt / .docx / .pdf</b> 文件，或粘贴一个<b>可访问的分享链接</b>。AI 会把它提炼成「想法 → 方向 → 步骤 / 资料 / 洞察」的节点树落到画布。
              </div>
              <label className="import-url-row">
                分享链接（可选，尽力抓取；跨域可能被拦截则请复制文本）
                <input className="import-url-input" value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://chatgpt.com/share/... 或 https://claude.ai/..." />
              </label>
              <textarea className="import-text" value={importText} onChange={(e) => setImportText(e.target.value)}
                placeholder="把要拆解的材料粘贴到这里（也可上传文件，二选一或都填；文件优先）" rows={8} />
              <div className="import-file-row">
                <label className="import-file-btn">选择文件（.md / .txt / .docx / .pdf）
                  <input type="file" accept=".md,.markdown,.txt,.text,.json,.docx,.pdf" style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; setImportFileObj(f || null); setImportErr('') }} />
                </label>
                {importFileObj && <span className="import-file-name">{importFileObj.name}</span>}
              </div>
              {importErr && <div className="ai-error">{importErr}</div>}
              <div className="confirm-actions">
                <button className="primary" onClick={doImport} disabled={importBusy}>{importBusy ? '拆解中…' : '拆解成图谱'}</button>
                <button onClick={() => { setShowImport(false); setImportText(''); setImportFileObj(null); setImportUrl(''); setImportErr('') }}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 优化画布 · 批量审阅（Human-in-the-loop）：逐条确认后再应用 */}
      {reviewDiff && (
        <div className="modal-mask" onClick={() => setReviewDiff(null)}>
          <div className="backup-modal review-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="优化审阅">
            <div className="backup-head">
              <span>⚡ 优化审阅 · 请确认要应用的改动</span>
              <button className="report-close" onClick={() => setReviewDiff(null)}>关闭</button>
            </div>
            <div className="review-body">
              {reviewDiff.add.length === 0 && reviewDiff.merge.length === 0 && reviewDiff.relate.length === 0 && (
                <div className="insp-empty">AI 未提出可应用的改动。</div>
              )}
              {reviewDiff.add.length > 0 && (
                <div className="review-sec">
                  <div className="review-sec-title">新增节点（{reviewDiff.add.length}）</div>
                  {reviewDiff.add.map((a, i) => (
                    <label className="review-item" key={i}>
                      <input type="checkbox" checked={reviewSel.add[i]} onChange={(e) => toggleReview('add', i, e.target.checked)} />
                      <span><b>{a.label}</b> <span className="review-sub">挂在「{a.parentLabel}」下</span></span>
                    </label>
                  ))}
                </div>
              )}
              {reviewDiff.merge.length > 0 && (
                <div className="review-sec">
                  <div className="review-sec-title">合并节点（{reviewDiff.merge.length}）</div>
                  {reviewDiff.merge.map((m, i) => (
                    <label className="review-item" key={i}>
                      <input type="checkbox" checked={reviewSel.merge[i]} onChange={(e) => toggleReview('merge', i, e.target.checked)} />
                      <span>把 <b>{m.bLabel}</b> 合并进 <b>{m.aLabel}</b>（保留前者，删除后者）</span>
                    </label>
                  ))}
                </div>
              )}
              {reviewDiff.relate.length > 0 && (
                <div className="review-sec">
                  <div className="review-sec-title">新增关联（{reviewDiff.relate.length}）</div>
                  {reviewDiff.relate.map((r, i) => (
                    <label className="review-item" key={i}>
                      <input type="checkbox" checked={reviewSel.relate[i]} onChange={(e) => toggleReview('relate', i, e.target.checked)} />
                      <span><b>{r.sLabel}</b> → <b>{r.tLabel}</b></span>
                    </label>
                  ))}
                </div>
              )}
              {reviewDiff.notes && <div className="review-notes">📝 {reviewDiff.notes}</div>}
            </div>
            <div className="confirm-actions">
              <button onClick={() => setReviewDiff(null)}>取消</button>
              <button onClick={selectAllReview}>全选</button>
              <button className="primary" onClick={applyReview} disabled={!anyReviewChecked()}>应用选中</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default AIPanel
