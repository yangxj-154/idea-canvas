import { NODE_TYPES, NODE_TYPE_KEYS } from './nodeTypes'

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
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // 跨想法关联：两端属于不同想法根
  const crossEdges = edges
    .filter((e) => rootOf[e.source] !== rootOf[e.target])
    .map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label || '关联',
      reason: e.data?.reason || '',
    }))

  // 统计
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
          <div className="insp-section-title">
            跨想法关联 <span className="insp-count">{crossEdges.length}</span>
          </div>
          {crossEdges.length === 0 ? (
            <div className="insp-empty">
              暂无跨想法关联。可点 AI 面板的「自动关联」让 AI 找出不同想法之间的实体联系。
            </div>
          ) : (
            crossEdges.map((e, i) => (
              <div
                key={i}
                className="rel-row"
                onClick={() => onFocus([e.source, e.target])}
                title="点击在画布中聚焦这两条卡片"
              >
                <div className="rel-line">
                  <b>{labelOf(byId.get(e.source))}</b>
                  <span className="rel-arrow"> → </span>
                  <b>{labelOf(byId.get(e.target))}</b>
                </div>
                <div className="rel-meta">
                  <span className="rel-tag">{e.label}</span>
                  {e.reason && <span className="rel-reason">{e.reason}</span>}
                </div>
              </div>
            ))
          )}

          <div className="insp-section-title" style={{ marginTop: 14 }}>
            想法清单 <span className="insp-count">{roots.length}</span>
          </div>
          {roots.length === 0 ? (
            <div className="insp-empty">画布还没有想法根节点。</div>
          ) : (
            roots.map((rid, i) => (
              <div
                key={i}
                className="rel-row"
                onClick={() => onFocus(membersOf[rid] || [rid])}
                title="点击聚焦该想法及其全部子节点"
              >
                <div className="rel-line">
                  <span
                    className="root-dot"
                    style={{ background: NODE_TYPES.idea.color }}
                  />
                  <b>{labelOf(byId.get(rid))}</b>
                </div>
                <div className="rel-meta">
                  <span className="rel-reason">
                    {membersOf[rid]?.length || 1} 个节点
                  </span>
                </div>
              </div>
            ))
          )}
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
            <div className="stat-label">跨想法关联</div>
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
