import { useState } from 'react'
import { NODE_TYPES, NODE_TYPE_KEYS } from './nodeTypes'
import { useStore } from './store'

function labelOf(n) {
  const c = (n?.data?.content || '').split('\n').find((l) => l.trim())
  return c ? c.slice(0, 24) : '（空卡片）'
}

export default function Inspector({
  tab,
  onTab,
  onClose,
  nodes,
  edges,
  rootOf,
  roots,
  membersOf,
  filterType,
  onFilter,
  onClearFilter,
  onFocus,
}) {
  // 多画布：从 store 直接读取全部画布，用于画布列表与跨画布关联纵览
  const { canvases, currentId, switchCanvas, addCanvas, renameCanvas } = useStore()
  // 行内重命名状态
  const [renamingId, setRenamingId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const commitRename = (id) => {
    const name = (draftName || '').trim()
    if (name) renameCanvas(id, name)
    setRenamingId(null)
  }

  const canvasName = (id) => canvases.find((c) => c.id === id)?.name || id

  // 全局节点映射 + 节点 → 所属画布映射
  const allNodes = canvases.flatMap((c) =>
    c.nodes.map((n) => ({ ...n, _canvas: c.id, _canvasName: c.name })),
  )
  const byId = new Map(allNodes.map((n) => [n.id, n]))
  const canvasOf = new Map(allNodes.map((n) => [n.id, n._canvas]))

  // 跨画布关联：直接读取顶层 crossEdges（两端节点分属不同画布）
  const storeCrossEdges = useStore((s) => s.crossEdges) || []
  const crossEdges = storeCrossEdges.map((e) => ({
    ...e,
    sourceLabel: labelOf(byId.get(e.source)),
    targetLabel: labelOf(byId.get(e.target)),
  }))

  // 统计（基于当前画布）
  const total = nodes.length
  const byType = {}
  NODE_TYPE_KEYS.forEach((k) => (byType[k] = 0))
  let read = 0
  nodes.forEach((n) => {
    byType[n.data.type] = (byType[n.data.type] || 0) + 1
    if (n.data.read === true) read += 1
  })
  const unread = total - read
  const maxType = Math.max(1, ...Object.values(byType))

  if (tab === 'rel') {
    return (
      <div className="inspector">
        <div className="insp-head">
          <div className="insp-tabs">
            <button className="active">关系图谱</button>
            <button onClick={() => onTab('data')}>数据面板</button>
          </div>
          <button className="insp-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="insp-body">
          {/* 跨画布关联：全局纵览，找出不同画布（想法）之间的联系 */}
          <div className="insp-section-title">
            跨画布关联 <span className="insp-count">{crossEdges.length}</span>
          </div>
          {crossEdges.length === 0 ? (
            <div className="insp-empty">
              暂无跨画布关联。在不同画布间连线，或运行「优化画布」让 AI 发现想法之间的联系。
            </div>
          ) : (
            crossEdges.map((e, i) => (
              <div
                key={i}
                className="rel-row rel-cross"
                onClick={() => {
                  switchCanvas(e.sourceCanvas)
                  setTimeout(() => onFocus([e.source]), 60)
                }}
                title="点击切到源节点所在画布并聚焦"
              >
                <div className="rel-line">
                  <b>{e.sourceLabel}</b>
                  <span className="rel-arrow"> → </span>
                  <b>{e.targetLabel}</b>
                </div>
                <div className="rel-meta">
                  <span className="rel-tag">{e.label}</span>
                  <span className="rel-reason">
                    {canvasName(e.sourceCanvas)} → {canvasName(e.targetCanvas)}
                  </span>
                </div>
              </div>
            ))
          )}

          {/* 画布列表：替代原「想法清单」，支持切换与新建 */}
          <div className="insp-section-title" style={{ marginTop: 14 }}>
            画布 <span className="insp-count">{canvases.length}</span>
          </div>
          {canvases.map((c) => (
            <div
              key={c.id}
              className={`rel-row${c.id === currentId ? ' is-current' : ''}`}
              onClick={() => switchCanvas(c.id)}
              title="点击切换到该画布"
            >
              <div className="rel-line">
                <span
                  className="root-dot"
                  style={{ background: c.id === currentId ? NODE_TYPES.idea.color : '#bbb' }}
                />
                {renamingId === c.id ? (
                  <input
                    className="rel-edit-input"
                    autoFocus
                    value={draftName}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(c.id)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => commitRename(c.id)}
                  />
                ) : (
                  <b>{c.name}</b>
                )}
                <button
                  className="rel-rename-btn"
                  title="重命名画布"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDraftName(c.name)
                    setRenamingId(c.id)
                  }}
                >
                  ✎
                </button>
              </div>
              <div className="rel-meta">
                <span className="rel-reason">{c.nodes.length} 个节点</span>
              </div>
            </div>
          ))}
          <button className="insp-add-canvas" onClick={() => addCanvas()}>
            ＋ 新建画布
          </button>
        </div>
      </div>
    )
  }

  // 数据面板
  return (
    <div className="inspector">
      <div className="insp-head">
        <div className="insp-tabs">
          <button onClick={() => onTab('rel')}>关系图谱</button>
          <button className="active">数据面板</button>
        </div>
        <button className="insp-close" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      <div className="insp-body">
        <div className="stat-grid">
          <div className="stat-cell">
            <div className="stat-num">{total}</div>
            <div className="stat-label">总节点</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{edges.length}</div>
            <div className="stat-label">连线</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{crossEdges.length}</div>
            <div className="stat-label">跨画布关联</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{roots.length}</div>
            <div className="stat-label">想法</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num" style={{ color: '#059669' }}>
              {read}
            </div>
            <div className="stat-label">已读</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num" style={{ color: '#dc2626' }}>
              {unread}
            </div>
            <div className="stat-label">未读</div>
          </div>
        </div>

        <div className="insp-section-title">类型分布</div>
        {NODE_TYPE_KEYS.map((k) => (
          <div className="bar-row" key={k}>
            <span className="bar-label" style={{ color: NODE_TYPES[k].color }}>
              {NODE_TYPES[k].label}
            </span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${(byType[k] / maxType) * 100}%`,
                  background: NODE_TYPES[k].color,
                }}
              />
            </div>
            <span className="bar-num">{byType[k]}</span>
          </div>
        ))}

        <div className="insp-section-title">筛选显示</div>
        <div className="filter-row">
          {NODE_TYPE_KEYS.map((k) => (
            <button
              key={k}
              className={`filter-chip${filterType === k ? ' active' : ''}`}
              style={{ borderColor: NODE_TYPES[k].color, color: NODE_TYPES[k].color }}
              onClick={() => onFilter(k)}
            >
              {NODE_TYPES[k].label}
            </button>
          ))}
          {filterType && (
            <button className="filter-chip clear" onClick={onClearFilter}>
              清除筛选
            </button>
          )}
        </div>
        {filterType && (
          <div className="insp-empty">
            当前只显示「{NODE_TYPES[filterType].label}」，其余节点已隐藏。
          </div>
        )}
      </div>
    </div>
  )
}
