import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { nanoid } from 'nanoid'
import { useStore } from './store'
import { loadSettings, saveSettings, loadChat, saveChat } from './settings'
import { DEFAULT_SETTINGS, discuss, decompose, optimizeCanvas, autoRelate, generateReport, relLabel, decomposeImport } from './ai'
import { treeToGraph } from './treeLayout'
import { buildLearningSummary } from './corrections'
import { readFileAsText } from './importFile'

export default function AIPanel() {
  const { screenToFlowPosition, fitView } = useReactFlow()
  const addNodesAndEdges = useStore((s) => s.addNodesAndEdges)
  const selectedNode = useStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId),
  )

  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS })
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [report, setReport] = useState(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importFileObj, setImportFileObj] = useState(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importErr, setImportErr] = useState('')
  const scrollRef = useRef(null)

  // 下钻模式：针对某张卡片提问并拆解
  const [mode, setMode] = useState('global')
  const [focus, setFocus] = useState(null)
  // 每个节点的下钻对话：nodeId -> [ {role, content} ]，与主会话分离且持久化
  const [threads, setThreads] = useState({})

  useEffect(() => {
    loadSettings().then((s) => {
      if (s) setSettings((p) => ({ ...p, ...s }))
    })
    loadChat().then((c) => {
      if (c) {
        if (Array.isArray(c.messages)) setMessages(c.messages)
        if (c.threads && typeof c.threads === 'object') setThreads(c.threads)
      }
    })
  }, [])

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 会话持久化：主会话 + 各节点下钻对话，防抖写入本地
  useEffect(() => {
    const t = setTimeout(() => saveChat({ messages, threads }), 400)
    return () => clearTimeout(t)
  }, [messages, threads])

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

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!settings.apiKey) {
      setError('请先在「设置」中填写 API Key。')
      setShowSettings(true)
      return
    }
    setError('')
    setInput('')

    if (mode === 'node' && focus) {
      const thread = threads[focus.id] || []
      const full = [
        {
          role: 'system',
          content: `你正在围绕这张卡片进行讨论，卡片内容：\n${focus.content}`,
        },
        ...thread,
        { role: 'user', content: text },
      ]
      setThreads((t) => ({
        ...t,
        [focus.id]: [...(t[focus.id] || []), { role: 'user', content: text }],
      }))
      setBusy(true)
      try {
        const reply = await discuss(settings, full)
        setThreads((t) => ({
          ...t,
          [focus.id]: [...(t[focus.id] || []), { role: 'assistant', content: reply }],
        }))
      } catch (e) {
        setError(e.message || '请求出错')
      } finally {
        setBusy(false)
      }
    } else {
      const next = [...messages, { role: 'user', content: text }]
      setMessages(next)
      setBusy(true)
      try {
        const reply = await discuss(settings, next)
        setMessages([...next, { role: 'assistant', content: reply }])
      } catch (e) {
        setError(e.message || '请求出错')
      } finally {
        setBusy(false)
      }
    }
  }

  const doDecompose = async () => {
    if (!settings.apiKey) {
      setError('请先在「设置」中填写 API Key。')
      setShowSettings(true)
      return
    }
    let direction
    let history
    let anchor = null
    if (mode === 'node' && focus) {
      direction =
        focus.content ||
        (threads[focus.id] || [])
          .filter((m) => m.role === 'user')
          .slice(-1)[0]?.content ||
        ''
      if (!direction) {
        setError('卡片为空，且没有提问内容。先给卡片写几个字或提问后再拆解。')
        return
      }
      history = threads[focus.id] || []
      anchor = focus
    } else {
      direction = input.trim() || lastUserText()
      if (!direction) {
        setError('先输入想法，或先和 AI 讨论。')
        return
      }
      history = messages
    }
    setError('')
    setBusy(true)
    try {
      const learning = await buildLearningSummary()
      const tree = await decompose(settings, direction, { history, anchor, learning })
      const st = useStore.getState()
      let origin
      if (anchor) {
        // 下钻：子节点从父节点右侧展开，后续 treeToGraph 会基于 anchor 位置
        origin = { x: focus.position.x, y: focus.position.y }
      } else if (st.nodes.length === 0) {
        const center = screenToFlowPosition({
          x: window.innerWidth / 2 - 220,
          y: window.innerHeight / 2,
        })
        origin = { x: center.x, y: center.y }
      } else {
        // 新想法：放在现有画布最右侧，避免与旧节点重叠
        origin = findFreeTreeOrigin(st.nodes)
      }
      const { nodes, edges } = treeToGraph(
        tree,
        anchor ? { anchor } : { origin },
      )
      addNodesAndEdges(nodes, edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60)
      const summary = `已拆解，生成 ${nodes.length} 个节点、${edges.length} 条连线${
        anchor ? '，挂在该卡片下' : ''
      }。`
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
    } finally {
      setBusy(false)
    }
  }

  // 给新树找一个不重叠的起点：现有内容最右侧、y 与最上方节点对齐
  function findFreeTreeOrigin(nodes, gap = 260) {
    if (!nodes.length) return { x: 0, y: 0 }
    const minY = Math.min(...nodes.map((n) => n.position.y))
    const maxX = Math.max(
      ...nodes.map((n) => n.position.x + (n.width || 170)),
    )
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
        if (!ids.has(c)) {
          ids.add(c)
          queue.push(c)
        }
      }
    }
    return {
      nodes: st.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => ({ id: n.id, type: n.data.type, content: n.data.content })),
      edges: st.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, label: e.label })),
    }
  }

  const doOptimize = async () => {
    if (!settings.apiKey) {
      setError('请先在「设置」中填写 API Key。')
      setShowSettings(true)
      return
    }
    setError('')
    setBusy(true)
    try {
      const st = useStore.getState()
      const graph = {
        nodes: st.nodes.map((n) => ({
          id: n.id,
          type: n.data.type,
          content: n.data.content,
        })),
        edges: st.edges.map((e) => ({
          source: e.source,
          target: e.target,
          label: e.label,
        })),
      }
      if (!graph.nodes.length) {
        setError('画布是空的，先放点东西再优化。')
        setBusy(false)
        return
      }
      const selId = st.selectedNodeId
      const selNode = selId ? st.nodes.find((n) => n.id === selId) : null
      const subgraph = selNode ? collectSubgraph(st, selId) : null
      const res = await optimizeCanvas(settings, graph, {
        mode: selNode ? 'node' : 'global',
        focusId: selNode?.id || null,
        focusContent: selNode?.data.content || '',
        subgraph,
      })
      const newNodes = []
      const newEdges = []
      res.add.forEach((a) => {
        const parent = st.nodes.find((n) => n.id === a.parentId) || st.nodes[0]
        if (!parent) return
        const id = nanoid(6)
        const pos = findFreePosition(parent, [...st.nodes, ...newNodes])
        newNodes.push({
          id,
          type: 'custom',
          position: pos,
          data: {
            type: a.type || 'step',
            content: [a.title, a.body].filter(Boolean).join('\n'),
            ai: true,
            read: false,
          },
        })
        newEdges.push({
          id: `e-${a.parentId}-${id}`,
          source: a.parentId,
          target: id,
          type: 'smoothstep',
          label: '',
          data: { read: false },
        })
      })
      const delIds = []
      res.merge.forEach(([aId, bId]) => {
        const a = st.nodes.find((n) => n.id === aId)
        const b = st.nodes.find((n) => n.id === bId)
        if (a && b) {
          const merged =
            (a.data.content ? a.data.content + '\n' : '') + (b.data.content || '')
          st.updateNodeData(aId, { content: merged })
          delIds.push(bId)
        }
      })
      if (delIds.length) delIds.forEach((id) => st.deleteNode(id))
      if (newNodes.length) st.addNodesAndEdges(newNodes, newEdges)
      // 优化后自动补一次全局关联连线
      let relCount = 0
      try {
        const suggested = await autoRelate(settings, graph)
        const existing = new Set(st.edges.map((e) => `${e.source}-${e.target}`))
        const relEdges = []
        for (const ed of suggested) {
          if (!ed.source || !ed.target || ed.source === ed.target) continue
          const key = `${ed.source}-${ed.target}`
          if (existing.has(key)) continue
          existing.add(key)
          relEdges.push({
            id: `e-rel-${ed.source}-${ed.target}`,
            source: ed.source,
            target: ed.target,
            type: 'smoothstep',
            label: relLabel(ed.rel),
            data: { reason: ed.reason || '' },
          })
        }
        if (relEdges.length) st.addNodesAndEdges([], relEdges)
        relCount = relEdges.length
      } catch {
        /* 关联失败不阻断优化主流程 */
      }
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 80)
      const summary = `优化完成：新增 ${newNodes.length} 个节点，合并 ${res.merge.length} 组，新增关联 ${relCount} 条。${
        res.notes ? '\n' + res.notes : ''
      }`
      setMessages((m) => [...m, { role: 'assistant', content: summary }])
    } catch (e) {
      setError(e.message || '优化失败')
    } finally {
      setBusy(false)
    }
  }

  function findFreePosition(parentNode, allNodes, w = 170, h = 70) {
    const target = parentNode.position
    const others = allNodes.filter((n) => n.id !== parentNode.id)
    const xStep = 180
    const yStep = 70
    for (let col = 0; col < 6; col++) {
      for (let row = -3; row <= 10; row++) {
        const x = target.x + 200 + col * xStep
        const y = target.y + row * yStep
        const overlap = others.some((n) => {
          const nw = n.width || 170
          const nh = n.height || 70
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
      setError('请先在「设置」中填写 API Key。')
      setShowSettings(true)
      return
    }
    setError('')
    setBusy(true)
    try {
      const st = useStore.getState()
      const graph = {
        nodes: st.nodes.map((n) => ({
          id: n.id,
          type: n.data.type,
          content: n.data.content,
        })),
        edges: st.edges.map((e) => ({
          source: e.source,
          target: e.target,
          label: e.label,
        })),
      }
      if (graph.nodes.length < 2) {
        setError('至少要有两张卡片才能自动关联。')
        setBusy(false)
        return
      }
      const suggested = await autoRelate(settings, graph)
      const existing = new Set(st.edges.map((e) => `${e.source}-${e.target}`))
      const newEdges = []
      for (const ed of suggested) {
        if (!ed.source || !ed.target || ed.source === ed.target) continue
        const key = `${ed.source}-${ed.target}`
        if (existing.has(key)) continue
        existing.add(key)
        newEdges.push({
          id: `e-${ed.source}-${ed.target}`,
          source: ed.source,
          target: ed.target,
          type: 'smoothstep',
          label: relLabel(ed.rel),
          data: { reason: ed.reason || '' },
        })
      }
      if (newEdges.length) st.addNodesAndEdges([], newEdges)
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: `自动关联完成：新增 ${newEdges.length} 条连线。`,
        },
      ])
    } catch (e) {
      setError(e.message || '自动关联失败')
    } finally {
      setBusy(false)
    }
  }

  const doReport = async () => {
    if (!settings.apiKey) {
      setError('请先在「设置」中填写 API Key。')
      setShowSettings(true)
      return
    }
    const st = useStore.getState()
    if (!st.nodes.length) {
      setError('画布是空的，先放点东西再生成报告。')
      return
    }
    setError('')
    setReportBusy(true)
    try {
      const graph = {
        nodes: st.nodes.map((n) => ({
          id: n.id,
          type: n.data.type,
          content: n.data.content,
        })),
        edges: st.edges.map((e) => ({
          source: e.source,
          target: e.target,
          label: e.label,
        })),
      }
      const text = await generateReport(settings, graph)
      setReport(text)
    } catch (e) {
      setError(e.message || '生成报告失败')
    } finally {
      setReportBusy(false)
    }
  }

  const downloadReport = () => {
    if (!report) return
    const blob = new Blob([report], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '想法画布报告.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  // 导入材料 / 聊天记录 → AI 提炼成图谱
  const doImport = async () => {
    if (!settings.apiKey) {
      setError('请先在「设置」中填写 API Key。')
      setShowSettings(true)
      return
    }
    let text = importText.trim()
    if (importFileObj) {
      setImportBusy(true)
      setImportErr('')
      try {
        text = (await readFileAsText(importFileObj)).trim()
      } catch (e) {
        setImportBusy(false)
        setImportErr(e.message || '文件解析失败')
        return
      }
    }
    if (!text) {
      setImportErr('先粘贴内容，或选择一个 .md / .txt / .docx / .pdf 文件。')
      return
    }
    setImportErr('')
    setImportBusy(true)
    try {
      const learning = await buildLearningSummary()
      const tree = await decomposeImport(settings, text, { learning })
      const st = useStore.getState()
      const origin =
        st.nodes.length === 0
          ? (() => {
              const c = screenToFlowPosition({
                x: window.innerWidth / 2 - 220,
                y: window.innerHeight / 2,
              })
              return { x: c.x, y: c.y }
            })()
          : findFreeTreeOrigin(st.nodes)
      const { nodes, edges } = treeToGraph(tree, { origin })
      addNodesAndEdges(nodes, edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60)
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: `已从材料拆解，生成 ${nodes.length} 个节点、${edges.length} 条连线。`,
        },
      ])
      setShowImport(false)
      setImportText('')
      setImportFileObj(null)
    } catch (e) {
      setImportErr(e.message || '导入拆解失败')
    } finally {
      setImportBusy(false)
    }
  }

  if (collapsed) {
    return (
      <button className="ai-fab" onClick={() => setCollapsed(false)}>
        🤖 AI
      </button>
    )
  }

  const rows = Math.min(Math.max(input.split('\n').length, 3), 8)

  const displayMsgs =
    mode === 'node' && focus ? threads[focus.id] || [] : messages

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span>🤖 AI 协同拆解</span>
        <button className="ai-mini" onClick={() => setCollapsed(true)} title="收起">
          —
        </button>
      </div>

      {mode === 'node' && focus && (
        <div className="ai-focus">
          📌 正在下钻卡片：
          <b>{focus.content?.slice(0, 30) || '（空卡片）'}</b>
          <button className="ai-exit" onClick={exitDrill}>
            返回
          </button>
        </div>
      )}

      {mode === 'global' && selectedNode && (
        <div className="ai-sel">
          🟦 已选中卡片：
          <b>{(selectedNode.data.content || '').slice(0, 24) || '（空卡片）'}</b>
          <button className="ai-drill" onClick={enterDrill}>
            在此卡片下钻提问
          </button>
        </div>
      )}

      <div className="ai-msg-list" ref={scrollRef}>
        {displayMsgs.length === 0 && !busy && !error && (
          <div className="ai-hint">
            {mode === 'node'
              ? '针对这张卡片继续提问；聊清楚后点「挂在此卡下拆解」，子节点会直接长在它下面。'
              : '把想法丢进来，点「发送」和 AI 多轮讨论；聊清楚后「拆解落图」，节点会自动落到画布并横向展开。也可直接在画布点选卡片下钻。'}
          </div>
        )}
        {displayMsgs.map((m, i) => (
          <div key={i} className={`ai-msg ai-${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="ai-msg ai-assistant">思考中…</div>}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={
            mode === 'node'
              ? '针对这张卡片继续提问…（Ctrl/⌘ + Enter 发送）'
              : '输入想法，或继续和 AI 讨论…（Ctrl/⌘ + Enter 发送）'
          }
          rows={rows}
        />
      </div>

      <div className="ai-actions">
        <button onClick={send} disabled={busy}>
          发送
        </button>
        {mode === 'node' ? (
          <button className="primary" onClick={doDecompose} disabled={busy}>
            挂在此卡下拆解
          </button>
        ) : (
          <button className="primary" onClick={doDecompose} disabled={busy}>
            拆解落图
          </button>
        )}
        <button className="ghost" onClick={doOptimize} disabled={busy}>
          优化画布
        </button>
        <button className="ghost" onClick={doRelate} disabled={busy}>
          自动关联
        </button>
        <button className="ghost" onClick={doReport} disabled={reportBusy}>
          生成报告
        </button>
        <button className="ghost" onClick={() => setShowImport(true)}>
          导入
        </button>
        <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
          设置
        </button>
      </div>

      {showSettings && (
        <div className="ai-settings">
          <label>
            API Key
            <span className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="sk-..."
              />
              <button
                type="button"
                className="key-toggle"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>
          <label>
            Base URL
            <input
              value={settings.baseURL}
              onChange={(e) => update({ baseURL: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
            />
          </label>
          <label>
            模型
            <input
              value={settings.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="deepseek-v4-pro"
              list="model-options"
            />
          </label>
          <datalist id="model-options">
            <option value="deepseek-v4-pro" />
            <option value="deepseek-v4-flash" />
            <option value="deepseek-chat" />
            <option value="deepseek-reasoner" />
            <option value="gpt-4o" />
            <option value="gpt-4o-mini" />
            <option value="claude-3-5-sonnet-20241022" />
            <option value="qwen-max" />
          </datalist>
          <div className="ai-settings-tip">
            默认 DeepSeek（OpenAI 兼容）。DeepSeek 官方模型请填
            <code>deepseek-v4-pro</code> 或 <code>deepseek-v4-flash</code>
            ；旧版 <code>deepseek-chat</code> / <code>deepseek-reasoner</code>
            将于 2026/07/24 弃用。Base URL 可用
            <code>https://api.deepseek.com</code> 或
            <code>https://api.deepseek.com/v1</code>。Key 仅存本机，应用直连厂商。
          </div>
        </div>
      )}

      {report && (
        <div className="modal-mask" onClick={() => setReport(null)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="report-head">
              <span>📄 画布报告</span>
              <div className="report-actions">
                <button onClick={() => navigator.clipboard?.writeText(report)}>
                  复制
                </button>
                <button onClick={downloadReport}>下载 .md</button>
                <button className="report-close" onClick={() => setReport(null)}>
                  关闭
                </button>
              </div>
            </div>
            <pre className="report-body">{report}</pre>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-mask" onClick={() => setShowImport(false)}>
          <div className="import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="import-head">
              <span>📥 导入材料 → 拆解成图谱</span>
              <button className="report-close" onClick={() => setShowImport(false)}>
                ×
              </button>
            </div>
            <div className="import-tip">
              把想法 / 文章 / 笔记，或其他 AI（ChatGPT、Claude、DeepSeek、豆包等）的聊天记录导出粘贴进来；
              也支持上传 <b>.md / .txt / .docx / .pdf</b> 文件。AI 会把它提炼成「想法 → 方向 → 步骤 / 资料 / 洞察」的节点树落到画布。
            </div>
            <textarea
              className="import-text"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="把要拆解的材料粘贴到这里（也可上传文件，二选一或都填；文件优先）"
              rows={8}
            />
            <div className="import-file-row">
              <label className="import-file-btn">
                选择文件（.md / .txt / .docx / .pdf）
                <input
                  type="file"
                  accept=".md,.markdown,.txt,.text,.json,.docx,.pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    setImportFileObj(f || null)
                    setImportErr('')
                  }}
                />
              </label>
              {importFileObj && (
                <span className="import-file-name">{importFileObj.name}</span>
              )}
            </div>
            {importErr && <div className="ai-error">{importErr}</div>}
            <div className="confirm-actions">
              <button
                className="primary"
                onClick={doImport}
                disabled={importBusy}
              >
                {importBusy ? '拆解中…' : '拆解成图谱'}
              </button>
              <button
                onClick={() => {
                  setShowImport(false)
                  setImportText('')
                  setImportFileObj(null)
                  setImportErr('')
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
